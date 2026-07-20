"""Windows clipboard text bridge for the clipboard share (M2 follow-up).

Reads and writes CF_UNICODETEXT via the Win32 API. Text only — no file lists,
images, or other formats. Reads return None off Windows or when the clipboard is
unavailable/held by another app so callers can simply skip that poll.

read_clipboard_text mirrors the host clipboard to the viewer (agent -> viewer,
ADR-017). write_clipboard_text is the reverse: the viewer asks the agent to set
the host clipboard so the user can Ctrl+V text they typed/pasted in the browser.
Writes only happen when clipboard sharing is enabled and control is active
(enforced by the caller). Neither path is ever logged with its content.
"""

from __future__ import annotations

import ctypes
import os
import subprocess
import sys
from ctypes import wintypes

CF_UNICODETEXT = 13
GMEM_MOVEABLE = 0x0002
# CREATE_NO_WINDOW: keep the helper PowerShell from flashing a console window.
_CREATE_NO_WINDOW = 0x0800_0000
# copy=$true flushes the image onto the clipboard so it survives the helper
# process exiting. The path arrives via an env var (below), never interpolated
# into the command, so a hostile filename cannot inject PowerShell.
_SET_IMAGE_PS = (
    "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; "
    "$img = [System.Drawing.Image]::FromFile($env:MIRROR_CLIPBOARD_IMAGE_PATH); "
    "try { [System.Windows.Forms.Clipboard]::SetDataObject($img, $true) } "
    "finally { $img.Dispose() }"
)
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
    user32.EmptyClipboard.argtypes = ()
    user32.EmptyClipboard.restype = wintypes.BOOL
    user32.SetClipboardData.argtypes = (wintypes.UINT, wintypes.HANDLE)
    user32.SetClipboardData.restype = wintypes.HANDLE
    user32.CloseClipboard.argtypes = ()
    user32.CloseClipboard.restype = wintypes.BOOL
    kernel32.GlobalAlloc.argtypes = (wintypes.UINT, ctypes.c_size_t)
    kernel32.GlobalAlloc.restype = wintypes.HGLOBAL
    kernel32.GlobalFree.argtypes = (wintypes.HGLOBAL,)
    kernel32.GlobalFree.restype = wintypes.HGLOBAL
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


def write_clipboard_text(text: str) -> bool:
    """Set the host clipboard to ``text`` (capped). Returns True on success.

    Never raises: any Win32 failure (clipboard locked, allocation failure)
    returns False so the caller can log a masked failure and move on. On success
    the system takes ownership of the moveable global block, so we must NOT free
    it; on failure we free it ourselves to avoid a leak.
    """
    if sys.platform != "win32":
        return False
    if not text:
        return False
    text = text[:CLIPBOARD_TEXT_MAX_LENGTH]
    try:
        user32 = ctypes.WinDLL("user32", use_last_error=True)
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        _configure(user32, kernel32)

        # UTF-16LE, NUL-terminated, as CF_UNICODETEXT expects.
        buffer = ctypes.create_unicode_buffer(text)
        size = ctypes.sizeof(buffer)
        handle = kernel32.GlobalAlloc(GMEM_MOVEABLE, size)
        if not handle:
            return False
        # Single ownership flag: the system takes the block only once
        # SetClipboardData succeeds. Until then any exit — including an exception
        # from memmove/OpenClipboard/SetClipboardData — must free it, so the
        # free lives in one finally rather than scattered per branch.
        transferred = False
        try:
            pointer = kernel32.GlobalLock(handle)
            if not pointer:
                return False
            try:
                ctypes.memmove(pointer, buffer, size)
            finally:
                kernel32.GlobalUnlock(handle)

            if not user32.OpenClipboard(None):
                return False
            try:
                user32.EmptyClipboard()
                if not user32.SetClipboardData(CF_UNICODETEXT, handle):
                    return False
                transferred = True
            finally:
                user32.CloseClipboard()
        finally:
            if not transferred:
                kernel32.GlobalFree(handle)
    except Exception:  # noqa: BLE001 - clipboard access is best-effort
        return False
    return True


def write_clipboard_image_from_file(path: str) -> bool:
    """Copy an image file onto the host clipboard. Returns True on success.

    Windows clipboard image APIs need an STA thread and a decoder, so this shells
    out to PowerShell (-STA) with System.Drawing/Windows.Forms rather than
    hand-rolling CF_DIB. Never raises: any failure (timeout, decode error,
    non-Windows) returns False so the caller can log a masked failure.
    """
    if sys.platform != "win32":
        return False
    try:
        result = subprocess.run(  # noqa: S603 - fixed argv, no shell, path via env
            [
                "powershell",
                "-NoProfile",
                "-NonInteractive",
                "-STA",
                "-Command",
                _SET_IMAGE_PS,
            ],
            env={**os.environ, "MIRROR_CLIPBOARD_IMAGE_PATH": str(path)},
            capture_output=True,
            timeout=15,
            creationflags=_CREATE_NO_WINDOW,
        )
    except Exception:  # noqa: BLE001 - clipboard access is best-effort
        return False
    return result.returncode == 0
