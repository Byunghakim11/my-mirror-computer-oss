"""Windows SendInput backend for remote input (M2).

Real input injection into the logged-in user's desktop via ``SendInput``. This
is the only place that touches the Windows API; the InputController drives it
through the ``InputSink`` protocol so all control logic stays testable.

Injection happens ONLY when a control session is granted and local policy allows
it. Absolute mouse coordinates are 0..65535 on the primary monitor (no
``VIRTUALDESK`` — multi-monitor targeting is out of scope). Keyboard uses a
whitelist-derived virtual-key map, including the Meta/Win key (VK_LWIN/
VK_RWIN); there is still no way to reach the secure desktop (UAC /
Ctrl+Alt+Del) — that is blocked by the OS regardless of injected key codes.
"""

from __future__ import annotations

import ctypes
import sys
from ctypes import wintypes

INPUT_MOUSE = 0
INPUT_KEYBOARD = 1

MOUSEEVENTF_MOVE = 0x0001
MOUSEEVENTF_ABSOLUTE = 0x8000
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_RIGHTDOWN = 0x0008
MOUSEEVENTF_RIGHTUP = 0x0010
MOUSEEVENTF_MIDDLEDOWN = 0x0020
MOUSEEVENTF_MIDDLEUP = 0x0040
MOUSEEVENTF_WHEEL = 0x0800
MOUSEEVENTF_HWHEEL = 0x1000

KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004

_BUTTON_FLAGS = {
    ("left", "down"): MOUSEEVENTF_LEFTDOWN,
    ("left", "up"): MOUSEEVENTF_LEFTUP,
    ("right", "down"): MOUSEEVENTF_RIGHTDOWN,
    ("right", "up"): MOUSEEVENTF_RIGHTUP,
    ("middle", "down"): MOUSEEVENTF_MIDDLEDOWN,
    ("middle", "up"): MOUSEEVENTF_MIDDLEUP,
}


def _build_virtual_key_map() -> dict[str, int]:
    mapping: dict[str, int] = {}
    for letter in range(ord("A"), ord("Z") + 1):
        mapping[f"Key{chr(letter)}"] = letter  # VK_A..VK_Z == 'A'..'Z'
    for digit in range(ord("0"), ord("9") + 1):
        mapping[f"Digit{chr(digit)}"] = digit  # VK_0..VK_9 == '0'..'9'
    for index in range(1, 13):
        mapping[f"F{index}"] = 0x70 + (index - 1)  # VK_F1..VK_F12
    mapping.update(
        {
            "Backspace": 0x08,
            "Tab": 0x09,
            "Enter": 0x0D,
            "Escape": 0x1B,
            "Space": 0x20,
            "PageUp": 0x21,
            "PageDown": 0x22,
            "End": 0x23,
            "Home": 0x24,
            "ArrowLeft": 0x25,
            "ArrowUp": 0x26,
            "ArrowRight": 0x27,
            "ArrowDown": 0x28,
            "Delete": 0x2E,
            "ShiftLeft": 0xA0,
            "ShiftRight": 0xA1,
            "ControlLeft": 0xA2,
            "ControlRight": 0xA3,
            "AltLeft": 0xA4,
            "AltRight": 0xA5,
            "MetaLeft": 0x5B,  # VK_LWIN
            "MetaRight": 0x5C,  # VK_RWIN
            # OEM punctuation (US layout). Injected as virtual keys so shifted
            # variants still work via the ShiftLeft/ShiftRight modifiers above.
            "Semicolon": 0xBA,  # VK_OEM_1  ;:
            "Equal": 0xBB,  # VK_OEM_PLUS  =+
            "Comma": 0xBC,  # VK_OEM_COMMA  ,<
            "Minus": 0xBD,  # VK_OEM_MINUS  -_
            "Period": 0xBE,  # VK_OEM_PERIOD  .>
            "Slash": 0xBF,  # VK_OEM_2  /?
            "Backquote": 0xC0,  # VK_OEM_3  `~
            "BracketLeft": 0xDB,  # VK_OEM_4  [{
            "Backslash": 0xDC,  # VK_OEM_5  \|
            "BracketRight": 0xDD,  # VK_OEM_6  ]}
            "Quote": 0xDE,  # VK_OEM_7  '"
            # Korean/Japanese IME toggle keys so the remote IME can switch modes.
            "Lang1": 0x15,  # VK_HANGUL  (한/영)
            "Lang2": 0x19,  # VK_HANJA  (한자)
        }
    )
    return mapping


_VIRTUAL_KEYS = _build_virtual_key_map()


def _utf16_code_units(character: str) -> list[int]:
    """UTF-16 code units for one character (a surrogate pair for astral
    characters such as emoji), as required by KEYEVENTF_UNICODE."""
    encoded = character.encode("utf-16-le")
    return [
        int.from_bytes(encoded[index : index + 2], "little")
        for index in range(0, len(encoded), 2)
    ]

_ULONG_PTR = wintypes.WPARAM  # pointer-sized unsigned


class _MOUSEINPUT(ctypes.Structure):
    _fields_ = [
        ("dx", wintypes.LONG),
        ("dy", wintypes.LONG),
        ("mouseData", wintypes.DWORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", _ULONG_PTR),
    ]


class _KEYBDINPUT(ctypes.Structure):
    _fields_ = [
        ("wVk", wintypes.WORD),
        ("wScan", wintypes.WORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", _ULONG_PTR),
    ]


class _INPUT_UNION(ctypes.Union):
    _fields_ = [("mi", _MOUSEINPUT), ("ki", _KEYBDINPUT)]


class _INPUT(ctypes.Structure):
    _fields_ = [("type", wintypes.DWORD), ("union", _INPUT_UNION)]


# Korean IME toggle via the IME window's conversion mode. Injecting VK_HANGUL
# with SendInput is unreliable — many apps ignore a synthetic 한/영 key because
# the real one carries a scan code the IME hotkey layer expects — so ask the IME
# to switch modes directly instead. This is deterministic (read mode, flip the
# native bit, write it back) rather than a toggle that can desync.
WM_IME_CONTROL = 0x0283
IMC_GETCONVERSIONMODE = 0x0001
IMC_SETCONVERSIONMODE = 0x0002
IME_CMODE_NATIVE = 0x0001  # Hangul input; cleared = alphanumeric


def toggle_hangul_ime() -> bool:
    """Flip the foreground window's IME between Hangul and English.

    Returns True when the IME accepted the change; False when there is no IME
    window (or any Win32 failure), so the caller can fall back to SendInput.
    Never raises.
    """
    if sys.platform != "win32":
        return False
    try:
        user32 = ctypes.WinDLL("user32", use_last_error=True)
        imm32 = ctypes.WinDLL("imm32", use_last_error=True)
        user32.GetForegroundWindow.restype = wintypes.HWND
        imm32.ImmGetDefaultIMEWnd.argtypes = (wintypes.HWND,)
        imm32.ImmGetDefaultIMEWnd.restype = wintypes.HWND
        user32.SendMessageW.argtypes = (
            wintypes.HWND,
            wintypes.UINT,
            wintypes.WPARAM,
            wintypes.LPARAM,
        )
        user32.SendMessageW.restype = ctypes.c_ssize_t

        foreground = user32.GetForegroundWindow()
        if not foreground:
            return False
        ime_window = imm32.ImmGetDefaultIMEWnd(foreground)
        if not ime_window:
            return False
        mode = user32.SendMessageW(
            ime_window, WM_IME_CONTROL, IMC_GETCONVERSIONMODE, 0
        )
        user32.SendMessageW(
            ime_window,
            WM_IME_CONTROL,
            IMC_SETCONVERSIONMODE,
            mode ^ IME_CMODE_NATIVE,
        )
        return True
    except Exception:  # noqa: BLE001 - IME access is best-effort
        return False


class WindowsInputSink:
    """Injects input via SendInput. Instantiate only on Windows."""

    def __init__(self) -> None:
        if sys.platform != "win32":
            raise RuntimeError("WindowsInputSink is only available on Windows")
        # True while a 한/영 press was satisfied by the IME path, so the paired
        # key-up is swallowed instead of injecting a stray VK_HANGUL.
        self._hangul_handled_by_ime = False
        self._send_input = ctypes.windll.user32.SendInput
        self._send_input.argtypes = (
            wintypes.UINT,
            ctypes.POINTER(_INPUT),
            ctypes.c_int,
        )
        self._send_input.restype = wintypes.UINT

    def _send(self, event: _INPUT) -> None:
        self._send_input(1, ctypes.byref(event), ctypes.sizeof(_INPUT))

    def move_absolute(self, x: int, y: int) -> None:
        mouse = _MOUSEINPUT(
            dx=x,
            dy=y,
            mouseData=0,
            dwFlags=MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE,
            time=0,
            dwExtraInfo=0,
        )
        self._send(_INPUT(type=INPUT_MOUSE, union=_INPUT_UNION(mi=mouse)))

    def mouse_button(self, button: str, action: str) -> None:
        flag = _BUTTON_FLAGS.get((button, action))
        if flag is None:
            return
        mouse = _MOUSEINPUT(dx=0, dy=0, mouseData=0, dwFlags=flag, time=0, dwExtraInfo=0)
        self._send(_INPUT(type=INPUT_MOUSE, union=_INPUT_UNION(mi=mouse)))

    def wheel(self, delta_x: int, delta_y: int) -> None:
        if delta_y != 0:
            self._wheel_event(MOUSEEVENTF_WHEEL, delta_y)
        if delta_x != 0:
            self._wheel_event(MOUSEEVENTF_HWHEEL, delta_x)

    def _wheel_event(self, flag: int, delta: int) -> None:
        mouse = _MOUSEINPUT(
            dx=0,
            dy=0,
            mouseData=delta & 0xFFFFFFFF,
            dwFlags=flag,
            time=0,
            dwExtraInfo=0,
        )
        self._send(_INPUT(type=INPUT_MOUSE, union=_INPUT_UNION(mi=mouse)))

    def key(self, code: str, action: str) -> None:
        virtual_key = _VIRTUAL_KEYS.get(code)
        if virtual_key is None:
            return
        if code == "Lang1":
            # Prefer the IME conversion-mode switch; only fall back to injecting
            # VK_HANGUL when there is no IME window to talk to.
            if action == "down":
                self._hangul_handled_by_ime = toggle_hangul_ime()
                if self._hangul_handled_by_ime:
                    return
            elif self._hangul_handled_by_ime:
                self._hangul_handled_by_ime = False
                return
        flags = KEYEVENTF_KEYUP if action == "up" else 0
        keyboard = _KEYBDINPUT(
            wVk=virtual_key, wScan=0, dwFlags=flags, time=0, dwExtraInfo=0
        )
        self._send(_INPUT(type=INPUT_KEYBOARD, union=_INPUT_UNION(ki=keyboard)))

    def type_text(self, text: str) -> None:
        """Inject composed text (mobile soft keyboard / IME) as unicode key
        events. KEYEVENTF_UNICODE carries the UTF-16 code unit in wScan with
        wVk=0, so Hangul and other non-ASCII text types correctly regardless of
        the host keyboard layout. Newlines map to a real Enter press; other
        control characters were already rejected upstream (fail-closed)."""
        for unit in text:
            if unit == "\n":
                self.key("Enter", "down")
                self.key("Enter", "up")
                continue
            for scan in _utf16_code_units(unit):
                for flags in (KEYEVENTF_UNICODE, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP):
                    keyboard = _KEYBDINPUT(
                        wVk=0, wScan=scan, dwFlags=flags, time=0, dwExtraInfo=0
                    )
                    self._send(
                        _INPUT(type=INPUT_KEYBOARD, union=_INPUT_UNION(ki=keyboard))
                    )


def create_input_sink() -> WindowsInputSink:
    """Return a real injection sink. Raises on non-Windows so callers can fall
    back to view-only."""
    return WindowsInputSink()
