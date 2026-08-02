"""한/영 (Hangul) toggle uses the IME conversion mode, not a synthetic key."""

from __future__ import annotations

import sys
import unittest
from unittest.mock import patch

if sys.platform == "win32":
    from mirror_host_agent.windows_input import WindowsInputSink


@unittest.skipUnless(sys.platform == "win32", "SendInput backend is Windows-only")
class HangulToggleTests(unittest.TestCase):
    def test_hangul_down_uses_the_ime_and_swallows_the_paired_up(self) -> None:
        # Injecting VK_HANGUL via SendInput is unreliable; the IME path must be
        # preferred, and the key-up must NOT also be injected (a stray VK_HANGUL
        # after a successful toggle can flip the mode back).
        sink = WindowsInputSink()
        with patch(
            "mirror_host_agent.windows_input.toggle_hangul_ime", return_value=True
        ) as toggle, patch.object(sink, "_send") as send:
            sink.key("Lang1", "down")
            sink.key("Lang1", "up")
        toggle.assert_called_once()
        send.assert_not_called()

    def test_falls_back_to_sendinput_when_no_ime_window(self) -> None:
        sink = WindowsInputSink()
        with patch(
            "mirror_host_agent.windows_input.toggle_hangul_ime", return_value=False
        ), patch.object(sink, "_send") as send:
            sink.key("Lang1", "down")
            sink.key("Lang1", "up")
        # Both halves of the keypress reach SendInput on the fallback path.
        self.assertEqual(send.call_count, 2)

    def test_other_keys_are_unaffected(self) -> None:
        sink = WindowsInputSink()
        with patch(
            "mirror_host_agent.windows_input.toggle_hangul_ime"
        ) as toggle, patch.object(sink, "_send") as send:
            sink.key("KeyA", "down")
            sink.key("KeyA", "up")
        toggle.assert_not_called()
        self.assertEqual(send.call_count, 2)


if __name__ == "__main__":
    unittest.main()
