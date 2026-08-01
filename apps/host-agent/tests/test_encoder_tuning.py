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


class BitrateCapTests(unittest.TestCase):
    def setUp(self) -> None:
        from aiortc.codecs import h264

        self._original_max = h264.MAX_BITRATE
        self._original_default = h264.DEFAULT_BITRATE

    def tearDown(self) -> None:
        from aiortc.codecs import h264

        h264.MAX_BITRATE = self._original_max
        h264.DEFAULT_BITRATE = self._original_default

    def test_raises_ceiling_so_screen_text_can_get_sharp(self) -> None:
        from aiortc.codecs import h264

        self.assertTrue(encoder_tuning.raise_bitrate_cap(12_000, 3_000))
        self.assertEqual(h264.MAX_BITRATE, 12_000_000)
        self.assertEqual(h264.DEFAULT_BITRATE, 3_000_000)

    def test_encoder_target_bitrate_can_now_exceed_the_old_3mbps_clamp(self) -> None:
        from aiortc.codecs.h264 import H264Encoder

        encoder_tuning.raise_bitrate_cap(12_000, 3_000)
        encoder = H264Encoder()
        encoder.target_bitrate = 9_000_000
        self.assertEqual(encoder.target_bitrate, 9_000_000)

    def test_start_never_exceeds_the_ceiling(self) -> None:
        from aiortc.codecs import h264

        encoder_tuning.raise_bitrate_cap(2_000, 9_000)
        self.assertEqual(h264.MAX_BITRATE, 2_000_000)
        self.assertEqual(h264.DEFAULT_BITRATE, 2_000_000)


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
