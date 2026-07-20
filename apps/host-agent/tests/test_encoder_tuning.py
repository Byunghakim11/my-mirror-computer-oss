"""Tests for the H.264 encoder preset patch (CPU/memory tuning)."""

from __future__ import annotations

import fractions
import unittest
from unittest.mock import patch

import av

from mirror_host_agent import encoder_tuning


class ResolvePresetTests(unittest.TestCase):
    def test_defaults_to_veryfast(self) -> None:
        with patch.dict("os.environ", {}, clear=False):
            import os

            os.environ.pop("MIRROR_X264_PRESET", None)
            self.assertEqual(encoder_tuning.resolve_preset(), "veryfast")

    def test_env_override_is_honored(self) -> None:
        with patch.dict("os.environ", {"MIRROR_X264_PRESET": "ULTRAFAST"}):
            self.assertEqual(encoder_tuning.resolve_preset(), "ultrafast")

    def test_invalid_preset_falls_back_to_default(self) -> None:
        with patch.dict("os.environ", {"MIRROR_X264_PRESET": "warp-speed"}):
            self.assertEqual(encoder_tuning.resolve_preset(), "veryfast")


class BuildOptionsTests(unittest.TestCase):
    def test_includes_preset_and_preserves_zerolatency_tuning(self) -> None:
        options = encoder_tuning.build_libx264_options("ultrafast")
        self.assertEqual(options.get("preset"), "ultrafast")
        # aiortc's existing real-time tuning must be preserved.
        self.assertEqual(options.get("tune"), "zerolatency")
        self.assertEqual(options.get("level"), "31")


class ApplyPresetTests(unittest.TestCase):
    def test_patch_installs_and_encodes_without_error(self) -> None:
        from aiortc.codecs.h264 import H264Encoder

        # Idempotent: the first apply in the process wins; default is veryfast.
        self.assertTrue(encoder_tuning.apply_h264_preset())
        # The encoder method was replaced by our preset-injecting wrapper.
        self.assertEqual(
            H264Encoder._encode_frame.__name__, "_encode_frame_with_preset"
        )

        # And the patched encoder still produces a working codec end-to-end
        # (PyAV consumes .options on open, so we assert the encode path runs
        # rather than reading the preset back off the opened context).
        encoder = H264Encoder()
        frame = av.VideoFrame(320, 240, "yuv420p")
        frame.pts = 0
        frame.time_base = fractions.Fraction(1, 90_000)
        list(encoder._encode_frame(frame, force_keyframe=True))
        self.assertIsNotNone(encoder.codec)
        self.assertEqual(encoder.codec.width, 320)
        self.assertEqual(encoder.codec.height, 240)


if __name__ == "__main__":
    unittest.main()
