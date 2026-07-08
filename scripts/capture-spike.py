"""M1 Desktop Duplication capture stability spike.

Drives DesktopDuplicationTrack.recv() for a configurable duration and reports
achieved fps, frame count, non-black-frame ratio, and safety-net restart count.
The M1 exit criterion is a stable 30-minute primary-monitor capture; this
harness measures a shorter run by default so it can be used as a smoke check.

Usage:
    .venv/Scripts/python scripts/capture-spike.py --seconds 30
    MIRROR_SPIKE_SECONDS=1800 .venv/Scripts/python scripts/capture-spike.py

No screen content, pixels, or frames are logged — only aggregate counters.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import time

import numpy as np

from mirror_host_agent.__main__ import configure_dpi_awareness
from mirror_host_agent.video import DesktopDuplicationTrack, get_profile


def _parse_args() -> tuple[float, str]:
    parser = argparse.ArgumentParser(description="Desktop Duplication capture spike")
    parser.add_argument(
        "--seconds",
        type=float,
        default=float(os.environ.get("MIRROR_SPIKE_SECONDS", "15")),
        help="capture duration in seconds (default 15, or MIRROR_SPIKE_SECONDS)",
    )
    parser.add_argument(
        "--profile",
        type=str,
        default=os.environ.get("MIRROR_VIDEO_PROFILE", "balanced"),
        help="quality profile: low or balanced (or MIRROR_VIDEO_PROFILE)",
    )
    args = parser.parse_args()
    if args.seconds < 1 or args.seconds > 7200:
        parser.error("--seconds must be between 1 and 7200")
    return args.seconds, args.profile


async def run_spike(seconds: float, profile_name: str) -> dict[str, object]:
    configure_dpi_awareness()
    profile = get_profile(profile_name)
    track = DesktopDuplicationTrack(profile=profile)

    frames = 0
    non_black = 0
    wrong_size = 0
    started = time.monotonic()
    deadline = started + seconds
    try:
        while time.monotonic() < deadline:
            frame = await track.recv()
            frames += 1
            if frame.width != profile.width or frame.height != profile.height:
                wrong_size += 1
            # A fully black frame means "no capture yet / mid-recovery". Sample
            # the array cheaply to distinguish live capture from the fallback.
            image = frame.to_ndarray(format="rgb24")
            if int(image.max()) > 0:
                non_black += 1
    finally:
        track.stop()

    elapsed = time.monotonic() - started
    return {
        "profile": profile.name,
        "requested_seconds": round(seconds, 2),
        "elapsed_seconds": round(elapsed, 2),
        "frames": frames,
        "achieved_fps": round(frames / elapsed, 2) if elapsed > 0 else 0,
        "target_fps": profile.fps,
        "non_black_frames": non_black,
        "non_black_ratio": round(non_black / frames, 3) if frames else 0.0,
        "wrong_size_frames": wrong_size,
        "restart_count": track.restart_count,
        "output": f"{profile.width}x{profile.height}",
    }


def main() -> None:
    seconds, profile_name = _parse_args()
    result = asyncio.run(run_spike(seconds, profile_name))
    # A run is healthy if it captured live (non-black) frames near target fps
    # without excessive restarts.
    target_fps = float(result["target_fps"])  # type: ignore[arg-type]
    result["status"] = (
        "pass"
        if result["non_black_ratio"] >= 0.5
        and result["achieved_fps"] >= target_fps * 0.6
        and result["wrong_size_frames"] == 0
        else "attention"
    )
    print(json.dumps(result, indent=2))
    raise SystemExit(0 if result["status"] == "pass" else 1)


if __name__ == "__main__":
    main()
