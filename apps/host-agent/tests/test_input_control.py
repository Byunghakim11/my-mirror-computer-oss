from __future__ import annotations

import unittest
from typing import Any

from mirror_host_agent.input_control import (
    ABSOLUTE_MAX,
    FakeInputSink,
    InputController,
    frame_to_desktop_absolute,
)


def _msg(event: str, data: dict[str, Any], sequence: int) -> dict[str, Any]:
    return {
        "event": event,
        "data": data,
        "sequence": sequence,
        "sessionId": "session_0123456789abcdef",
        "timestamp": 0,
        "version": 1,
    }


def _controller(**kwargs: Any) -> tuple[InputController, FakeInputSink]:
    sink = FakeInputSink()
    controller = InputController(sink, frame_width=1280, frame_height=720, **kwargs)
    controller.set_source_size(1280, 720)
    return controller, sink


class FrameToDesktopAbsoluteTests(unittest.TestCase):
    def test_identity_when_frame_matches_desktop(self) -> None:
        # 1280x720 desktop into 1280x720 frame: no capture letterbox.
        kwargs = dict(source_width=1280, source_height=720, frame_width=1280, frame_height=720)
        self.assertEqual(
            frame_to_desktop_absolute(0.5, 0.5, **kwargs), _point(32768, 32768)
        )
        self.assertEqual(frame_to_desktop_absolute(0.0, 0.0, **kwargs), _point(0, 0))
        self.assertEqual(
            frame_to_desktop_absolute(1.0, 1.0, **kwargs),
            _point(ABSOLUTE_MAX, ABSOLUTE_MAX),
        )

    def test_inverts_pillarbox_for_16_10_desktop(self) -> None:
        # 1920x1200 (16:10) fitted into 1280x720 -> scaled 1152x720, 64px bars L/R.
        kwargs = dict(source_width=1920, source_height=1200, frame_width=1280, frame_height=720)
        # Frame center maps to desktop center.
        self.assertEqual(
            frame_to_desktop_absolute(0.5, 0.5, **kwargs), _point(32768, 32768)
        )
        # Desktop left edge sits at frame px 64 -> fx = 64/1280 = 0.05.
        left = frame_to_desktop_absolute(64 / 1280, 0.5, **kwargs)
        self.assertIsNotNone(left)
        assert left is not None
        self.assertEqual(left.x, 0)
        # Desktop right edge at frame px 1216 -> fx = 1216/1280 = 0.95.
        right = frame_to_desktop_absolute(1216 / 1280, 0.5, **kwargs)
        assert right is not None
        self.assertEqual(right.x, ABSOLUTE_MAX)

    def test_rejects_points_on_capture_letterbox(self) -> None:
        kwargs = dict(source_width=1920, source_height=1200, frame_width=1280, frame_height=720)
        # fx=0.02 -> frame px 25.6 < 64 (left bar) -> no desktop content.
        self.assertIsNone(frame_to_desktop_absolute(0.02, 0.5, **kwargs))
        self.assertIsNone(frame_to_desktop_absolute(0.98, 0.5, **kwargs))

    def test_rejects_out_of_range(self) -> None:
        kwargs = dict(source_width=1280, source_height=720, frame_width=1280, frame_height=720)
        self.assertIsNone(frame_to_desktop_absolute(1.5, 0.5, **kwargs))
        self.assertIsNone(frame_to_desktop_absolute(-0.1, 0.5, **kwargs))


def _point(x: int, y: int):
    from mirror_host_agent.input_control import AbsolutePoint

    return AbsolutePoint(x=x, y=y)


class InputControllerTests(unittest.TestCase):
    def test_pointer_move_maps_and_injects(self) -> None:
        controller, sink = _controller()
        self.assertTrue(
            controller.handle(_msg("pointer.move", {"x": 0.5, "y": 0.5}, 1), now=0.0)
        )
        self.assertEqual(sink.calls, [("move", 32768, 32768)])

    def test_pointer_move_dropped_without_source_size(self) -> None:
        sink = FakeInputSink()
        controller = InputController(sink, frame_width=1280, frame_height=720)
        # No set_source_size -> cannot map -> dropped, nothing injected.
        self.assertFalse(
            controller.handle(_msg("pointer.move", {"x": 0.5, "y": 0.5}, 1), now=0.0)
        )
        self.assertEqual(sink.calls, [])

    def test_rejects_non_monotonic_sequence(self) -> None:
        controller, sink = _controller()
        self.assertTrue(controller.handle(_msg("pointer.button", {"button": "left", "action": "down"}, 5), now=0.0))
        # Same or lower sequence is a replay -> rejected.
        self.assertFalse(controller.handle(_msg("pointer.button", {"button": "left", "action": "up"}, 5), now=0.0))
        self.assertFalse(controller.handle(_msg("pointer.button", {"button": "left", "action": "up"}, 3), now=0.0))
        self.assertEqual(sink.calls, [("button", "left", "down")])

    def test_release_all_releases_tracked_buttons_and_keys(self) -> None:
        controller, sink = _controller()
        controller.handle(_msg("pointer.button", {"button": "left", "action": "down"}, 1), now=0.0)
        controller.handle(_msg("key.down", {"code": "ShiftLeft"}, 2), now=0.0)
        controller.handle(_msg("key.down", {"code": "KeyA"}, 3), now=0.0)
        self.assertEqual(controller.pressed_count, 3)
        sink.calls.clear()

        controller.release_all()
        self.assertEqual(controller.pressed_count, 0)
        self.assertIn(("button", "left", "up"), sink.calls)
        self.assertIn(("key", "ShiftLeft", "up"), sink.calls)
        self.assertIn(("key", "KeyA", "up"), sink.calls)

    def test_key_whitelist_rejects_unknown_codes(self) -> None:
        controller, sink = _controller()
        self.assertFalse(controller.handle(_msg("key.down", {"code": "KeyAA"}, 1), now=0.0))
        self.assertFalse(controller.handle(_msg("key.down", {"code": "PowerShell"}, 2), now=0.0))
        self.assertEqual(sink.calls, [])

    def test_key_whitelist_accepts_meta(self) -> None:
        # MetaLeft/MetaRight (Win key) mirror the protocol allowlist in
        # packages/protocol/src/schemas/control.ts and map to VK_LWIN/VK_RWIN
        # in windows_input.py; the secure desktop stays unreachable regardless.
        controller, sink = _controller()
        self.assertTrue(
            controller.handle(_msg("key.down", {"code": "MetaLeft"}, 1), now=0.0)
        )
        self.assertIn(("key", "MetaLeft", "down"), sink.calls)

    def test_key_whitelist_rejects_trailing_newline(self) -> None:
        # A `$`-anchored pattern would accept "KeyA\n"; fullmatch must reject it.
        controller, sink = _controller()
        self.assertFalse(controller.handle(_msg("key.down", {"code": "KeyA\n"}, 1), now=0.0))
        self.assertEqual(sink.calls, [])

    def test_key_whitelist_accepts_punctuation_and_ime_keys(self) -> None:
        # Slash and the Korean IME toggle (Lang1) must reach the sink so users
        # can type "/" and switch 한/영 on the remote desktop.
        controller, sink = _controller()
        for sequence, code in enumerate(("Slash", "Semicolon", "Lang1", "Lang2"), 1):
            self.assertTrue(
                controller.handle(_msg("key.down", {"code": code}, sequence), now=0.0)
            )
        self.assertIn(("key", "Slash", "down"), sink.calls)
        self.assertIn(("key", "Lang1", "down"), sink.calls)

    def test_wheel_range_enforced(self) -> None:
        controller, sink = _controller()
        self.assertTrue(controller.handle(_msg("pointer.wheel", {"deltaX": 0, "deltaY": 120}, 1), now=0.0))
        self.assertFalse(controller.handle(_msg("pointer.wheel", {"deltaX": 0, "deltaY": 9999}, 2), now=0.0))
        self.assertEqual(sink.calls, [("wheel", 0, 120)])

    def test_rate_limit_drops_excess_moves(self) -> None:
        controller, sink = _controller(rate_limit_per_second=3)
        applied = [
            controller.handle(_msg("pointer.move", {"x": 0.5, "y": 0.5}, seq), now=0.0)
            for seq in range(1, 6)
        ]
        self.assertEqual(applied, [True, True, True, False, False])
        self.assertEqual(len(sink.calls), 3)

    def test_action_rate_limit_covers_buttons_keys_and_wheel(self) -> None:
        controller, sink = _controller(action_rate_limit_per_second=3)
        # Presses across all three action types share one budget; the 4th press
        # is dropped. (Releases are exempt and covered separately.)
        messages = [
            _msg("pointer.button", {"button": "left", "action": "down"}, 1),
            _msg("key.down", {"code": "KeyA"}, 2),
            _msg("pointer.wheel", {"deltaX": 0, "deltaY": 120}, 3),
            _msg("pointer.button", {"button": "right", "action": "down"}, 4),
        ]

        applied = [controller.handle(message, now=0.0) for message in messages]

        self.assertEqual(applied, [True, True, True, False])
        self.assertEqual(len(sink.calls), 3)

    def test_release_up_events_bypass_action_rate_limit(self) -> None:
        # A saturated action budget must never drop an "up" event; otherwise the
        # button/key stays stuck down on the host with no release.
        controller, sink = _controller(action_rate_limit_per_second=1)
        self.assertTrue(
            controller.handle(
                _msg("key.down", {"code": "ControlLeft"}, 1), now=0.0
            )
        )
        # Budget of 1 is now spent; a fresh press is dropped...
        self.assertFalse(
            controller.handle(_msg("key.down", {"code": "KeyA"}, 2), now=0.0)
        )
        sink.calls.clear()
        # ...but the release of the held key still lands.
        self.assertTrue(
            controller.handle(_msg("key.up", {"code": "ControlLeft"}, 3), now=0.0)
        )
        self.assertEqual(sink.calls, [("key", "ControlLeft", "up")])
        self.assertEqual(controller.pressed_count, 0)

    def test_button_up_bypasses_action_rate_limit(self) -> None:
        controller, sink = _controller(action_rate_limit_per_second=1)
        self.assertTrue(
            controller.handle(
                _msg("pointer.button", {"button": "left", "action": "down"}, 1),
                now=0.0,
            )
        )
        self.assertFalse(
            controller.handle(
                _msg("pointer.wheel", {"deltaX": 0, "deltaY": 120}, 2), now=0.0
            )
        )
        sink.calls.clear()
        self.assertTrue(
            controller.handle(
                _msg("pointer.button", {"button": "left", "action": "up"}, 3),
                now=0.0,
            )
        )
        self.assertEqual(sink.calls, [("button", "left", "up")])
        self.assertEqual(controller.pressed_count, 0)

    def test_release_all_bypasses_action_rate_limit(self) -> None:
        controller, sink = _controller(action_rate_limit_per_second=1)
        self.assertTrue(
            controller.handle(
                _msg("pointer.button", {"button": "left", "action": "down"}, 1),
                now=0.0,
            )
        )
        sink.calls.clear()

        self.assertTrue(
            controller.handle(_msg("control.release-all", {}, 2), now=0.0)
        )
        self.assertEqual(sink.calls, [("button", "left", "up")])

    def test_control_release_all_event(self) -> None:
        controller, sink = _controller()
        controller.handle(_msg("key.down", {"code": "ControlLeft"}, 1), now=0.0)
        sink.calls.clear()
        self.assertTrue(controller.handle(_msg("control.release-all", {}, 2), now=0.0))
        self.assertEqual(sink.calls, [("key", "ControlLeft", "up")])
        self.assertEqual(controller.pressed_count, 0)

    def test_text_input_injects_safe_text(self) -> None:
        controller, sink = _controller()
        self.assertTrue(
            controller.handle(_msg("text.input", {"text": "안녕 hello\n"}, 1), now=0.0)
        )
        self.assertEqual(sink.calls, [("text", "안녕 hello\n")])
        # Stateless: nothing tracked for release-all.
        self.assertEqual(controller.pressed_count, 0)

    def test_text_input_rejects_control_characters_and_size(self) -> None:
        controller, sink = _controller()
        # C0 control char (ESC) must be rejected fail-closed, not stripped.
        self.assertFalse(
            controller.handle(_msg("text.input", {"text": "abc\x1bdef"}, 1), now=0.0)
        )
        # Over the 256-char cap.
        self.assertFalse(
            controller.handle(_msg("text.input", {"text": "a" * 257}, 2), now=0.0)
        )
        # Empty / non-string.
        self.assertFalse(controller.handle(_msg("text.input", {"text": ""}, 3), now=0.0))
        self.assertFalse(controller.handle(_msg("text.input", {"text": 42}, 4), now=0.0))
        self.assertEqual(sink.calls, [])

    def test_text_input_consumes_action_budget(self) -> None:
        controller, sink = _controller(action_rate_limit_per_second=2)
        self.assertTrue(controller.handle(_msg("text.input", {"text": "a"}, 1), now=0.0))
        self.assertTrue(controller.handle(_msg("text.input", {"text": "b"}, 2), now=0.0))
        # Third within the same second exceeds the shared action budget.
        self.assertFalse(controller.handle(_msg("text.input", {"text": "c"}, 3), now=0.0))
        self.assertEqual(sink.calls, [("text", "a"), ("text", "b")])

    def test_watchdog_releases_after_idle(self) -> None:
        controller, sink = _controller(watchdog_seconds=3.0)
        controller.handle(_msg("pointer.button", {"button": "left", "action": "down"}, 1), now=10.0)
        sink.calls.clear()
        # 2s idle: not yet.
        self.assertFalse(controller.on_watchdog_tick(now=12.0))
        self.assertEqual(controller.pressed_count, 1)
        # 3.5s idle: fires, releases the held button.
        self.assertTrue(controller.on_watchdog_tick(now=13.5))
        self.assertEqual(sink.calls, [("button", "left", "up")])
        self.assertEqual(controller.pressed_count, 0)


class Utf16CodeUnitTests(unittest.TestCase):
    def test_bmp_character_is_one_unit(self) -> None:
        from mirror_host_agent.windows_input import _utf16_code_units

        self.assertEqual(_utf16_code_units("A"), [0x41])
        self.assertEqual(_utf16_code_units("한"), [0xD55C])

    def test_astral_character_is_a_surrogate_pair(self) -> None:
        from mirror_host_agent.windows_input import _utf16_code_units

        units = _utf16_code_units("😀")  # U+1F600
        self.assertEqual(units, [0xD83D, 0xDE00])


if __name__ == "__main__":
    unittest.main()
