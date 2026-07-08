"""Windows-only global emergency-stop hotkey.

Ctrl+Alt+F12 is registered in a small daemon thread with its own Win32 message
loop. The callback supplied by the asyncio agent must marshal back to its event
loop (``loop.call_soon_threadsafe``); this module never mutates agent state.
"""

from __future__ import annotations

import ctypes
import threading
from collections.abc import Callable
from ctypes import wintypes

HOTKEY_ID = 0x4D43  # "MC"
MOD_ALT = 0x0001
MOD_CONTROL = 0x0002
MOD_NOREPEAT = 0x4000
VK_F12 = 0x7B
WM_HOTKEY = 0x0312
WM_QUIT = 0x0012


class WindowsEmergencyStopMonitor:
    """Own a process-local Ctrl+Alt+F12 registration and message loop."""

    def __init__(self, callback: Callable[[], None]) -> None:
        self._callback = callback
        self._ready = threading.Event()
        self._error: str | None = None
        self._thread: threading.Thread | None = None
        self._thread_id: int | None = None

    def start(self, timeout_seconds: float = 2.0) -> None:
        if self._thread is not None:
            raise RuntimeError("emergency stop monitor already started")
        self._thread = threading.Thread(
            target=self._message_loop,
            name="mirror-emergency-stop",
            daemon=True,
        )
        self._thread.start()
        if not self._ready.wait(timeout_seconds):
            self.stop()
            raise RuntimeError("emergency stop hotkey registration timed out")
        if self._error is not None:
            self.stop()
            raise RuntimeError(self._error)

    def stop(self) -> None:
        thread = self._thread
        thread_id = self._thread_id
        if thread is None:
            return
        if thread_id is not None and thread.is_alive():
            user32 = ctypes.WinDLL("user32", use_last_error=True)
            user32.PostThreadMessageW(
                wintypes.DWORD(thread_id),
                wintypes.UINT(WM_QUIT),
                wintypes.WPARAM(0),
                wintypes.LPARAM(0),
            )
            thread.join(timeout=2.0)
        self._thread = None
        self._thread_id = None

    def _message_loop(self) -> None:
        user32 = ctypes.WinDLL("user32", use_last_error=True)
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        self._thread_id = int(kernel32.GetCurrentThreadId())
        registered = bool(
            user32.RegisterHotKey(
                None,
                HOTKEY_ID,
                MOD_CONTROL | MOD_ALT | MOD_NOREPEAT,
                VK_F12,
            )
        )
        if not registered:
            error_code = ctypes.get_last_error()
            self._error = f"Ctrl+Alt+F12 registration failed (WinError {error_code})"
            self._ready.set()
            return

        self._ready.set()
        message = wintypes.MSG()
        try:
            while True:
                result = int(user32.GetMessageW(ctypes.byref(message), None, 0, 0))
                if result <= 0:
                    break
                if message.message == WM_HOTKEY and message.wParam == HOTKEY_ID:
                    self._callback()
        finally:
            user32.UnregisterHotKey(None, HOTKEY_ID)
