"""Windows clipboard text reader for the one-way clipboard share (M2 follow-up).

Reads CF_UNICODETEXT via the Win32 API. Text only — no file lists, images, or
other formats leave the host. Returns None off Windows or when the clipboard is
unavailable/held by another app so callers can simply skip that poll.

The agent only ever READS the host clipboard; it never writes it. The viewer
stages received text and copies to its own clipboard only on an explicit user
click (see ADR-017).
"""

from __future__ import annotations

import ctypes
import sys
from ctypes import wintypes

CF_UNICODETEXT = 13
# Keep in sync with CLIPBOARD_TEXT_MAX_LENGTH in packages/protocol control schema.
CLIPBOARD_TEXT_MAX_LENGTH = 16_384


def _configure(user32: ctypes.WinDLL, kernel32: ctypes.WinDLL) -> None:
    # Pointer-returning calls MUST declare restype, or ctypes truncates the
    # handle to 32 bits on 64-bit Python and dereferences garbage.
    user32.OpenClipboard.argtypes = (wintypes.HWND,)
    user32.OpenClipboard.restype = wintypes.BOOL
    user32.IsClipboardFormatAvailable.argtypes = (wintypes.UINT,)
    user32.IsClipboardFormatAvailable.restype = wintypes.BOOL
    user32.GetClipboardData.argtypes = (wintypes.UINT,)
    user32.GetClipboardData.restype = wintypes.HANDLE
    user32.CloseClipboard.argtypes = ()
    user32.CloseClipboard.restype = wintypes.BOOL
    kernel32.GlobalLock.argtypes = (wintypes.HGLOBAL,)
    kernel32.GlobalLock.restype = wintypes.LPVOID
    kernel32.GlobalUnlock.argtypes = (wintypes.HGLOBAL,)
    kernel32.GlobalUnlock.restype = wintypes.BOOL


def read_clipboard_text() -> str | None:
    """Return the current clipboard text (capped), or None if unavailable.

    Never raises: any Win32 failure (including the clipboard being locked by
    another process) yields None so the poller just tries again later.
    """
    if sys.platform != "win32":
        return None
    try:
        user32 = ctypes.WinDLL("user32", use_last_error=True)
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        _configure(user32, kernel32)
        if not user32.OpenClipboard(None):
            return None
        try:
            if not user32.IsClipboardFormatAvailable(CF_UNICODETEXT):
                return None
            handle = user32.GetClipboardData(CF_UNICODETEXT)
            if not handle:
                return None
            pointer = kernel32.GlobalLock(handle)
            if not pointer:
                return None
            try:
                text = ctypes.c_wchar_p(pointer).value
            finally:
                kernel32.GlobalUnlock(handle)
        finally:
            user32.CloseClipboard()
    except Exception:  # noqa: BLE001 - clipboard access is best-effort
        return None

    if not text:
        return None
    return text[:CLIPBOARD_TEXT_MAX_LENGTH]
