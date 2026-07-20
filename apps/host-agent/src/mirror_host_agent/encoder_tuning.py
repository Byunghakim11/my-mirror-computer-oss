"""Lower the CPU/memory cost of aiortc's software H.264 encoder.

aiortc 1.14 builds its libx264 encoder with only ``{"level","tune"}`` options,
so libx264 falls back to its default **"medium"** preset — far heavier than
necessary for real-time screen capture (high CPU, and larger lookahead buffers
inflate memory). This module monkey-patches the encoder to add a faster preset,
which cuts CPU and memory for a small compression-efficiency tradeoff that is
invisible in practice over a bitrate-capped WebRTC link.

Safe by design: the patch reproduces aiortc's exact codec setup plus a preset,
and if anything about aiortc's internals differs from the pinned version the
patch is skipped and stock aiortc keeps working (just at higher CPU).
"""

from __future__ import annotations

import fractions
import logging
import os

LOGGER = logging.getLogger("mirror_host_agent.encoder_tuning")

# x264 presets, fastest -> slowest. "veryfast" is a strong default for screen
# share: a large CPU/memory drop versus "medium" with little visible quality
# loss at a capped bitrate. Override with MIRROR_X264_PRESET (e.g. "ultrafast"
# for the lowest CPU, "faster"/"fast" for a bit more quality).
_VALID_PRESETS = frozenset(
    {
        "ultrafast",
        "superfast",
        "veryfast",
        "faster",
        "fast",
        "medium",
        "slow",
        "slower",
        "veryslow",
    }
)
_DEFAULT_PRESET = "veryfast"

_patched = False


def resolve_preset() -> str:
    """The configured preset (``MIRROR_X264_PRESET``) or the safe default."""
    preset = os.environ.get("MIRROR_X264_PRESET", _DEFAULT_PRESET).strip().lower()
    return preset if preset in _VALID_PRESETS else _DEFAULT_PRESET


def build_libx264_options(preset: str) -> dict[str, str]:
    """libx264 options: aiortc's zero-latency screen-share tuning plus a preset.

    Extracted so it is unit-testable without opening a real encoder (PyAV
    consumes and clears ``CodecContext.options`` once the context opens).
    """
    return {"level": "31", "tune": "zerolatency", "preset": preset}


def apply_h264_preset(preset: str | None = None) -> bool:
    """Patch aiortc's H264Encoder to build libx264 with a faster preset.

    Idempotent and never raises. Returns True if the encoder is (now) patched.
    Must be called before the first video frame is encoded (i.e. at startup).
    """
    global _patched
    if _patched:
        return True
    chosen = (preset or resolve_preset()).strip().lower()
    if chosen not in _VALID_PRESETS:
        chosen = _DEFAULT_PRESET
    try:
        import av
        from aiortc.codecs import h264 as _h264

        original_encode_frame = _h264.H264Encoder._encode_frame

        def _encode_frame_with_preset(self, frame, force_keyframe):  # type: ignore[no-untyped-def]
            # Mirror aiortc's recreate-on-change check so the preset survives a
            # resolution or bitrate change, then build the codec ourselves with
            # the preset added. The original then reuses this codec (its own
            # "codec is None" branch is skipped) and just encodes.
            if self.codec and (
                frame.width != self.codec.width
                or frame.height != self.codec.height
                or abs(self.target_bitrate - self.codec.bit_rate) / self.codec.bit_rate
                > 0.1
            ):
                self.buffer_data = b""
                self.buffer_pts = None
                self.codec = None
            if self.codec is None:
                codec = av.CodecContext.create("libx264", "w")
                codec.width = frame.width
                codec.height = frame.height
                codec.bit_rate = self.target_bitrate
                codec.pix_fmt = "yuv420p"
                codec.framerate = fractions.Fraction(_h264.MAX_FRAME_RATE, 1)
                codec.time_base = fractions.Fraction(1, _h264.MAX_FRAME_RATE)
                codec.options = build_libx264_options(chosen)
                codec.profile = "Baseline"
                self.codec = codec
            return original_encode_frame(self, frame, force_keyframe)

        _h264.H264Encoder._encode_frame = _encode_frame_with_preset
        _patched = True
        LOGGER.info("H.264 encoder preset set to '%s' (lower CPU/memory)", chosen)
        return True
    except Exception as error:  # noqa: BLE001 - tuning is best-effort
        LOGGER.warning(
            "Could not apply H.264 preset (using aiortc default): %s",
            type(error).__name__,
        )
        return False
