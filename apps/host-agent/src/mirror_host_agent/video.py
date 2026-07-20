"""Video sources and quality profiles for the host agent.

Two WebRTC video tracks share one output contract (RGB frames at a profile's
resolution/fps):

- ``SyntheticVideoTrack``: deterministic test pattern, used for M0 and CI. No
  native dependencies, runs on any platform.
- ``DesktopDuplicationTrack``: real primary-monitor capture via DXGI Desktop
  Duplication (``dxcam``), used for the M1 spike. Windows-only; imported lazily
  so this module loads without ``dxcam`` installed.

Output is letterboxed into the profile's canvas so the aspect ratio is preserved
and the viewer's coordinate mapping (M2) has a stable frame to reason about.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from dataclasses import dataclass
from fractions import Fraction

import av
import numpy as np
from aiortc.mediastreams import MediaStreamTrack

LOGGER = logging.getLogger("mirror_host_agent.video")

# Minimum seconds between Desktop Duplication rebuild attempts after a capture
# fault, so a persistent fault does not rebuild dxcam on every frame.
_RECOVER_RETRY_SECONDS = 1.0

VIDEO_CLOCK_RATE = 90_000
VIDEO_TIME_BASE = Fraction(1, VIDEO_CLOCK_RATE)

SYNTHETIC_SOURCE = "synthetic"
DESKTOP_SOURCE = "desktop"


@dataclass(frozen=True)
class VideoProfile:
    """A quality tier: output resolution and frame rate."""

    name: str
    width: int
    height: int
    fps: int


PROFILE_LOW = VideoProfile(name="low", width=960, height=540, fps=10)
PROFILE_BALANCED = VideoProfile(name="balanced", width=1280, height=720, fps=15)
# 1600x1000 is 16:10, matching a 1920x1200 desktop exactly, so
# compute_letterbox_fit produces no pillarbox bars (every pixel is a live
# control target) — unlike the 16:9 profiles above, which letterbox a 16:10
# desktop and leave dead zones on the sides.
PROFILE_HIGH = VideoProfile(name="high", width=1600, height=1000, fps=20)
PROFILES: dict[str, VideoProfile] = {
    PROFILE_LOW.name: PROFILE_LOW,
    PROFILE_BALANCED.name: PROFILE_BALANCED,
    PROFILE_HIGH.name: PROFILE_HIGH,
}
DEFAULT_PROFILE = PROFILE_BALANCED

# Balanced defaults kept as module constants for callers/tests that reference the
# canonical M1 output size directly.
OUTPUT_WIDTH = PROFILE_BALANCED.width
OUTPUT_HEIGHT = PROFILE_BALANCED.height
VIDEO_FPS = PROFILE_BALANCED.fps


def get_profile(name: str) -> VideoProfile:
    """Resolve a profile by name (case-insensitive). Raises on unknown names."""
    key = name.strip().lower()
    if key not in PROFILES:
        allowed = ", ".join(sorted(PROFILES))
        raise ValueError(f"unknown MIRROR_VIDEO_PROFILE '{name}' (expected {allowed})")
    return PROFILES[key]


@dataclass(frozen=True)
class FitBox:
    """Placement of a scaled source image inside a destination canvas."""

    width: int
    height: int
    offset_x: int
    offset_y: int


def compute_letterbox_fit(
    src_width: int,
    src_height: int,
    dst_width: int,
    dst_height: int,
) -> FitBox:
    """Scale (src) to fit inside (dst) preserving aspect ratio, then center it.

    Pure integer math — no image data — so it is unit-testable without a display.
    The returned box always lies fully within the destination bounds.
    """
    if src_width <= 0 or src_height <= 0:
        raise ValueError("source dimensions must be positive")
    if dst_width <= 0 or dst_height <= 0:
        raise ValueError("destination dimensions must be positive")

    scale = min(dst_width / src_width, dst_height / src_height)
    width = max(1, min(dst_width, round(src_width * scale)))
    height = max(1, min(dst_height, round(src_height * scale)))
    offset_x = (dst_width - width) // 2
    offset_y = (dst_height - height) // 2
    return FitBox(width=width, height=height, offset_x=offset_x, offset_y=offset_y)


def letterbox_rgb(
    image_rgb: np.ndarray,
    dst_width: int = OUTPUT_WIDTH,
    dst_height: int = OUTPUT_HEIGHT,
) -> np.ndarray:
    """Return an (dst_height, dst_width, 3) RGB frame with the source scaled to
    fit and centered on a black background. Scaling uses libswscale via PyAV.
    """
    if image_rgb.ndim != 3 or image_rgb.shape[2] != 3:
        raise ValueError("expected an HxWx3 RGB image")

    src_height, src_width = image_rgb.shape[0], image_rgb.shape[1]
    fit = compute_letterbox_fit(src_width, src_height, dst_width, dst_height)

    contiguous = np.ascontiguousarray(image_rgb, dtype=np.uint8)
    source_frame = av.VideoFrame.from_ndarray(contiguous, format="rgb24")
    scaled = source_frame.reformat(width=fit.width, height=fit.height).to_ndarray(
        format="rgb24"
    )

    canvas = np.zeros((dst_height, dst_width, 3), dtype=np.uint8)
    canvas[
        fit.offset_y : fit.offset_y + fit.height,
        fit.offset_x : fit.offset_x + fit.width,
        :,
    ] = scaled
    return canvas


_RTPMAP_RE = re.compile(r"^a=rtpmap:\d+\s+([A-Za-z0-9-]+)/", re.MULTILINE)


def extract_primary_video_codec(sdp: str) -> str | None:
    """Return the encoding name of the first codec in the video m-section of an
    SDP answer (e.g. ``H264`` or ``VP8``), or None if not found. Only the codec
    name is derived — the SDP itself is never logged.
    """
    lines = sdp.splitlines()
    in_video = False
    first_payload: str | None = None
    rtpmaps: dict[str, str] = {}
    for line in lines:
        if line.startswith("m="):
            in_video = line.startswith("m=video")
            if in_video:
                parts = line.split()
                # m=video <port> <proto> <pt1> <pt2> ...
                if len(parts) >= 4:
                    first_payload = parts[3]
            continue
        if in_video and line.startswith("a=rtpmap:"):
            match = re.match(r"a=rtpmap:(\d+)\s+([A-Za-z0-9-]+)/", line)
            if match:
                rtpmaps[match.group(1)] = match.group(2)
    if first_payload and first_payload in rtpmaps:
        return rtpmaps[first_payload]
    # Fallback: first rtpmap encountered anywhere.
    match = _RTPMAP_RE.search(sdp)
    return match.group(1) if match else None


def _to_video_frame(image_rgb: np.ndarray, frame_index: int, fps: int) -> av.VideoFrame:
    frame = av.VideoFrame.from_ndarray(image_rgb, format="rgb24")
    frame.pts = frame_index * (VIDEO_CLOCK_RATE // fps)
    frame.time_base = VIDEO_TIME_BASE
    return frame


class SyntheticVideoTrack(MediaStreamTrack):
    """Deterministic test pattern with a moving bar and marker at profile size."""

    kind = "video"

    def __init__(self, profile: VideoProfile = DEFAULT_PROFILE) -> None:
        super().__init__()
        self._profile = profile
        self._interval = 1 / profile.fps
        self._started_at = time.monotonic()
        self._frame_index = 0

    @property
    def source_size(self) -> tuple[int, int]:
        # Synthetic content is authored at the profile size (no real desktop).
        return (self._profile.width, self._profile.height)

    async def recv(self) -> av.VideoFrame:
        target_time = self._started_at + self._frame_index * self._interval
        delay = target_time - time.monotonic()
        if delay > 0:
            await asyncio.sleep(delay)

        width = self._profile.width
        height = self._profile.height
        image = np.zeros((height, width, 3), dtype=np.uint8)
        image[:, :, 0] = 18
        image[:, :, 1] = 24
        image[:, :, 2] = 34

        bar_width = max(1, width // 8)
        bar_x = (self._frame_index * 12) % (width + bar_width) - bar_width
        left = max(0, bar_x)
        right = min(width, bar_x + bar_width)
        if left < right:
            image[:, left:right, 0] = 45
            image[:, left:right, 1] = 212
            image[:, left:right, 2] = 191

        # marker stays within bounds: marker_y in [pad, height - pad - marker_h].
        pad = max(8, height // 9)
        marker_h = max(4, height // 36)
        span = max(1, height - 2 * pad - marker_h)
        marker_y = pad + (self._frame_index * 5) % span
        marker_x = max(8, width // 16)
        marker_w = max(8, width // 5)
        image[marker_y : marker_y + marker_h, marker_x : marker_x + marker_w, :] = (
            245,
            158,
            11,
        )

        frame = _to_video_frame(image, self._frame_index, self._profile.fps)
        self._frame_index += 1
        return frame


class DesktopDuplicationTrack(MediaStreamTrack):
    """Primary-monitor capture via DXGI Desktop Duplication (dxcam).

    Frames are paced by dxcam's video-mode capture thread (profile fps); the
    track always reads the *latest* frame so no backlog accumulates. Capture and
    the blocking latest-frame read run in a worker thread to keep the asyncio
    loop responsive. dxcam 0.3.x recovers internally from
    ``DXGI_ERROR_ACCESS_LOST`` and resolution changes; ``_recover`` here is a
    safety net that rebuilds the camera if a grab still raises.
    """

    kind = "video"

    def __init__(
        self,
        *,
        profile: VideoProfile = DEFAULT_PROFILE,
        output_idx: int = 0,
    ) -> None:
        super().__init__()
        self._profile = profile
        self._output_idx = output_idx
        self._frame_index = 0
        self._camera = None
        self._last_rgb: np.ndarray | None = None
        self._restart_count = 0
        self._recover_not_before = 0.0

    @property
    def restart_count(self) -> int:
        return self._restart_count

    @property
    def source_size(self) -> tuple[int, int] | None:
        # Actual captured desktop resolution (width, height) from the last frame,
        # used to invert the capture letterbox for input coordinates.
        if self._last_rgb is None:
            return None
        height, width = self._last_rgb.shape[0], self._last_rgb.shape[1]
        return (width, height)

    def _ensure_camera(self) -> None:
        if self._camera is not None:
            return
        import dxcam  # lazy: keeps the module importable without dxcam

        camera = dxcam.create(
            output_idx=self._output_idx,
            output_color="RGB",
            processor_backend="numpy",
            max_buffer_len=2,
        )
        if camera is None:
            raise RuntimeError(
                f"dxcam.create returned None for output {self._output_idx}"
            )
        camera.start(target_fps=self._profile.fps, video_mode=True)
        self._camera = camera
        LOGGER.info(
            "Desktop Duplication capture started (output=%d, profile=%s, target=%dfps)",
            self._output_idx,
            self._profile.name,
            self._profile.fps,
        )

    def _recover(self, error: BaseException | None) -> None:
        if error is not None:
            self._restart_count += 1
            LOGGER.warning(
                "Desktop Duplication recover #%d after %s",
                self._restart_count,
                type(error).__name__,
            )
        camera = self._camera
        self._camera = None
        if camera is None:
            return
        try:
            camera.stop()
        except Exception:  # noqa: BLE001 - best-effort teardown
            pass
        try:
            camera.release()
        except Exception:  # noqa: BLE001 - best-effort teardown
            pass
        # dxcam caches one instance per (device, output) in a module-level
        # factory; release() frees the duplicator but leaves that registration,
        # so the next dxcam.create() returns the same dead instance ("already
        # exists; delete the old one first") and capture never recovers — the
        # black-screen loop. clean_up() clears the factory so create() rebuilds.
        try:
            import dxcam

            dxcam.clean_up()
        except Exception:  # noqa: BLE001 - best-effort teardown
            pass

    def _grab_rgb(self) -> np.ndarray | None:
        """Blocking capture read; runs in an executor thread."""
        # After a failed recovery, hold off before rebuilding the camera so a
        # persistent fault (monitor asleep, display change) doesn't rebuild dxcam
        # every frame; keep emitting the last/black frame meanwhile.
        if self._camera is None and time.monotonic() < self._recover_not_before:
            return self._last_rgb
        try:
            self._ensure_camera()
            assert self._camera is not None
            frame = self._camera.get_latest_frame()
        except Exception as error:  # noqa: BLE001 - convert to safety-net recovery
            self._recover(error)
            self._recover_not_before = time.monotonic() + _RECOVER_RETRY_SECONDS
            return self._last_rgb
        if frame is None:
            return self._last_rgb
        self._last_rgb = frame
        return frame

    async def recv(self) -> av.VideoFrame:
        loop = asyncio.get_event_loop()
        raw = await loop.run_in_executor(None, self._grab_rgb)
        if raw is None:
            # No frame yet (or mid-recovery): emit black to keep the timeline
            # advancing so the peer connection stays alive.
            image = np.zeros(
                (self._profile.height, self._profile.width, 3), dtype=np.uint8
            )
        else:
            image = letterbox_rgb(raw, self._profile.width, self._profile.height)

        frame = _to_video_frame(image, self._frame_index, self._profile.fps)
        self._frame_index += 1
        return frame

    def stop(self) -> None:
        self._recover(None)
        super().stop()


def create_video_track(
    source: str = SYNTHETIC_SOURCE,
    profile: VideoProfile = DEFAULT_PROFILE,
) -> MediaStreamTrack:
    """Factory selecting the video source at the given profile. Defaults to
    synthetic/balanced so M0 and CI are unaffected; ``desktop`` requires the
    ``capture`` extra (dxcam) on Windows.
    """
    normalized = source.strip().lower()
    if normalized == DESKTOP_SOURCE:
        return DesktopDuplicationTrack(profile=profile)
    if normalized == SYNTHETIC_SOURCE:
        return SyntheticVideoTrack(profile=profile)
    raise ValueError(
        f"unknown MIRROR_VIDEO_SOURCE '{source}' (expected 'synthetic' or 'desktop')"
    )
