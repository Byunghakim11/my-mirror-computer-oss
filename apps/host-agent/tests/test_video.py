from __future__ import annotations

import asyncio
import unittest

import numpy as np

from mirror_host_agent.video import (
    PROFILE_BALANCED,
    PROFILE_LOW,
    DesktopDuplicationTrack,
    SyntheticVideoTrack,
    compute_letterbox_fit,
    create_video_track,
    extract_primary_video_codec,
    get_profile,
    letterbox_rgb,
)


class LetterboxFitTests(unittest.TestCase):
    def test_same_aspect_fills_destination(self) -> None:
        fit = compute_letterbox_fit(1280, 720, 1280, 720)
        self.assertEqual((fit.width, fit.height), (1280, 720))
        self.assertEqual((fit.offset_x, fit.offset_y), (0, 0))

    def test_larger_16_9_source_scales_to_full_frame(self) -> None:
        fit = compute_letterbox_fit(2560, 1440, 1280, 720)
        self.assertEqual((fit.width, fit.height), (1280, 720))
        self.assertEqual((fit.offset_x, fit.offset_y), (0, 0))

    def test_16_10_source_pillarboxes(self) -> None:
        fit = compute_letterbox_fit(1920, 1200, 1280, 720)
        self.assertEqual((fit.width, fit.height), (1152, 720))
        self.assertEqual((fit.offset_x, fit.offset_y), (64, 0))

    def test_4_3_source_pillarboxes(self) -> None:
        fit = compute_letterbox_fit(1024, 768, 1280, 720)
        self.assertEqual((fit.width, fit.height), (960, 720))
        self.assertEqual((fit.offset_x, fit.offset_y), (160, 0))

    def test_portrait_source_is_centered(self) -> None:
        fit = compute_letterbox_fit(720, 1280, 1280, 720)
        self.assertEqual((fit.width, fit.height), (405, 720))
        self.assertEqual(fit.offset_y, 0)
        # Symmetric horizontal centering.
        self.assertEqual(fit.offset_x, (1280 - 405) // 2)

    def test_box_always_within_destination(self) -> None:
        fit = compute_letterbox_fit(3000, 1000, 1280, 720)
        self.assertLessEqual(fit.offset_x + fit.width, 1280)
        self.assertLessEqual(fit.offset_y + fit.height, 720)

    def test_rejects_non_positive_dimensions(self) -> None:
        with self.assertRaises(ValueError):
            compute_letterbox_fit(0, 100, 1280, 720)
        with self.assertRaises(ValueError):
            compute_letterbox_fit(100, 100, 0, 720)


class LetterboxRgbTests(unittest.TestCase):
    def test_output_shape_and_letterbox_padding(self) -> None:
        # 100x50 source (2:1) into 1280x720 -> full width, 640 tall, 40px top/bottom bars.
        source = np.zeros((50, 100, 3), dtype=np.uint8)
        source[:, :, 0] = 200  # red

        out = letterbox_rgb(source, 1280, 720)

        self.assertEqual(out.shape, (720, 1280, 3))
        # Top bar is black letterbox.
        self.assertTrue(np.array_equal(out[0, 0], np.zeros(3, dtype=np.uint8)))
        self.assertTrue(np.array_equal(out[719, 0], np.zeros(3, dtype=np.uint8)))
        # Center is the (red) source content.
        center = out[360, 640]
        self.assertGreater(int(center[0]), 100)
        self.assertLess(int(center[1]), 60)
        self.assertLess(int(center[2]), 60)

    def test_rejects_non_rgb_input(self) -> None:
        with self.assertRaises(ValueError):
            letterbox_rgb(np.zeros((10, 10), dtype=np.uint8))


class VideoProfileTests(unittest.TestCase):
    def test_known_profiles_resolve(self) -> None:
        low = get_profile("low")
        self.assertEqual((low.width, low.height, low.fps), (960, 540, 10))
        balanced = get_profile(" BALANCED ")
        self.assertEqual((balanced.width, balanced.height, balanced.fps), (1280, 720, 15))

    def test_unknown_profile_raises(self) -> None:
        with self.assertRaises(ValueError):
            get_profile("ultra")

    def test_synthetic_track_honors_profile_size(self) -> None:
        track = SyntheticVideoTrack(PROFILE_LOW)
        frame = asyncio.run(track.recv())
        self.assertEqual((frame.width, frame.height), (960, 540))

    def test_desktop_black_fallback_matches_profile(self) -> None:
        # Force the "no frame yet" path (no capture hardware touched): recv must
        # emit a profile-sized black frame rather than raise or leak a camera.
        track = create_video_track("desktop", PROFILE_LOW)
        track._grab_rgb = lambda: None  # type: ignore[method-assign]
        frame = asyncio.run(track.recv())
        self.assertEqual((frame.width, frame.height), (960, 540))


class ExtractCodecTests(unittest.TestCase):
    _SDP = (
        "v=0\r\n"
        "m=audio 9 UDP/TLS/RTP/SAVPF 111\r\n"
        "a=rtpmap:111 opus/48000/2\r\n"
        "m=video 9 UDP/TLS/RTP/SAVPF 102 96\r\n"
        "a=rtpmap:96 VP8/90000\r\n"
        "a=rtpmap:102 H264/90000\r\n"
    )

    def test_returns_first_video_payload_codec(self) -> None:
        # First video payload is 102 -> H264, even though VP8 rtpmap appears first.
        self.assertEqual(extract_primary_video_codec(self._SDP), "H264")

    def test_returns_none_without_video(self) -> None:
        self.assertIsNone(
            extract_primary_video_codec("v=0\r\nm=audio 9 RTP 111\r\n")
        )


class CreateVideoTrackTests(unittest.TestCase):
    def test_synthetic_is_default(self) -> None:
        self.assertIsInstance(create_video_track(), SyntheticVideoTrack)
        self.assertIsInstance(create_video_track("synthetic"), SyntheticVideoTrack)
        self.assertIsInstance(create_video_track(" SYNTHETIC "), SyntheticVideoTrack)

    def test_desktop_source_builds_capture_track_without_starting(self) -> None:
        # __init__ must not touch dxcam/hardware; capture starts lazily on recv.
        track = create_video_track("desktop")
        self.assertIsInstance(track, DesktopDuplicationTrack)
        self.assertEqual(track.restart_count, 0)

    def test_unknown_source_raises(self) -> None:
        with self.assertRaises(ValueError):
            create_video_track("webcam")


if __name__ == "__main__":
    unittest.main()
