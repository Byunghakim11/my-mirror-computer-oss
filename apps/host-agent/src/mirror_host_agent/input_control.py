"""Pure coordinate mapping for remote input (M2).

The viewer sends a frame-relative pointer position in 0..1 (already corrected for
the browser's display letterbox). This module inverts the *capture* letterbox
that placed the real desktop inside the encoded frame, producing a Windows
absolute coordinate in 0..65535 on the primary monitor.

Kept free of any Windows API so it is unit-testable without a display. The
SendInput adapter (later M2 step) consumes AbsolutePoint.
"""

from __future__ import annotations

import re
from collections import deque
from dataclasses import dataclass
from typing import Any, Protocol

from .video import compute_letterbox_fit

ABSOLUTE_MAX = 65535
_EDGE_EPSILON = 1e-9

# Mirrors the keyboard whitelist in packages/protocol/src/schemas/control.ts.
# Second line of defense: the schema validates on the wire, the controller
# re-checks before any injection. No Meta/Win key (system UI) by design.
_KEY_CODE_RE = re.compile(
    r"^(?:Key[A-Z]|Digit[0-9]|Arrow(?:Up|Down|Left|Right)"
    r"|F(?:[1-9]|1[0-2])|Backspace|Tab|Enter|Escape|Space|Delete"
    r"|Home|End|PageUp|PageDown|Shift(?:Left|Right)"
    r"|Control(?:Left|Right)|Alt(?:Left|Right)"
    r"|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon"
    r"|Quote|Backquote|Comma|Period|Slash|Lang[12])$"
)
_BUTTONS = frozenset({"left", "right", "middle"})
_WHEEL_LIMIT = 1200
# Mirrors TEXT_INPUT_MAX_LENGTH in the protocol schema (mobile soft keyboard).
_TEXT_INPUT_MAX_LENGTH = 256


def _is_safe_text(value: Any) -> bool:
    """Printable text only (plus newline/tab): C0/C1 control characters are
    rejected fail-closed rather than stripped, so nothing unexpected reaches
    the unicode injector."""
    if not isinstance(value, str) or not 1 <= len(value) <= _TEXT_INPUT_MAX_LENGTH:
        return False
    return all(ch in "\n\t" or (ord(ch) >= 0x20 and ord(ch) != 0x7F) for ch in value)


@dataclass(frozen=True)
class AbsolutePoint:
    """Windows MOUSEEVENTF_ABSOLUTE coordinate on the primary monitor (0..65535)."""

    x: int
    y: int


def _clamp_unit(value: float) -> float | None:
    if value < -_EDGE_EPSILON or value > 1.0 + _EDGE_EPSILON:
        return None
    return min(1.0, max(0.0, value))


def frame_to_desktop_absolute(
    frame_x: float,
    frame_y: float,
    *,
    source_width: int,
    source_height: int,
    frame_width: int,
    frame_height: int,
) -> AbsolutePoint | None:
    """Map a frame-relative point (0..1) to a primary-monitor absolute coordinate.

    Inverts the capture letterbox (desktop ``source_*`` fitted into the encoded
    ``frame_*``). Returns None when the point is out of range or falls on the
    capture letterbox bars (i.e. not over real desktop content). No resolution or
    DPI factor is re-applied — absolute 0..65535 is DPI-independent.
    """
    if not (0.0 <= frame_x <= 1.0 and 0.0 <= frame_y <= 1.0):
        return None

    fit = compute_letterbox_fit(source_width, source_height, frame_width, frame_height)
    frame_px = frame_x * frame_width
    frame_py = frame_y * frame_height

    desktop_x = _clamp_unit((frame_px - fit.offset_x) / fit.width)
    desktop_y = _clamp_unit((frame_py - fit.offset_y) / fit.height)
    if desktop_x is None or desktop_y is None:
        return None

    return AbsolutePoint(
        x=round(desktop_x * ABSOLUTE_MAX),
        y=round(desktop_y * ABSOLUTE_MAX),
    )


def _is_unit(value: Any) -> bool:
    return isinstance(value, (int, float)) and 0.0 <= float(value) <= 1.0


def _is_wheel(value: Any) -> bool:
    return isinstance(value, int) and -_WHEEL_LIMIT <= value <= _WHEEL_LIMIT


class InputSink(Protocol):
    """Injection backend. The controller never talks to Windows directly, so it
    can be unit-tested against a fake sink with no real input side effects."""

    def move_absolute(self, x: int, y: int) -> None: ...

    def mouse_button(self, button: str, action: str) -> None: ...

    def wheel(self, delta_x: int, delta_y: int) -> None: ...

    def key(self, code: str, action: str) -> None: ...

    def type_text(self, text: str) -> None: ...


class FakeInputSink:
    """Records calls instead of injecting. For tests."""

    def __init__(self) -> None:
        self.calls: list[tuple[Any, ...]] = []

    def move_absolute(self, x: int, y: int) -> None:
        self.calls.append(("move", x, y))

    def mouse_button(self, button: str, action: str) -> None:
        self.calls.append(("button", button, action))

    def wheel(self, delta_x: int, delta_y: int) -> None:
        self.calls.append(("wheel", delta_x, delta_y))

    def key(self, code: str, action: str) -> None:
        self.calls.append(("key", code, action))

    def type_text(self, text: str) -> None:
        self.calls.append(("text", text))


class InputController:
    """Validates control-channel input, maps coordinates, tracks pressed state,
    enforces sequence/rate limits, and drives release-all / watchdog.

    All timekeeping is passed in (``now``) so the logic is deterministic and
    testable. Returns whether a message was applied; unhandled or rejected
    messages return False and inject nothing.
    """

    def __init__(
        self,
        sink: InputSink,
        *,
        frame_width: int,
        frame_height: int,
        rate_limit_per_second: int = 120,
        action_rate_limit_per_second: int = 60,
        watchdog_seconds: float = 3.0,
    ) -> None:
        self._sink = sink
        self._frame_width = frame_width
        self._frame_height = frame_height
        self._rate_limit_per_second = rate_limit_per_second
        self._action_rate_limit_per_second = action_rate_limit_per_second
        self._watchdog_seconds = watchdog_seconds
        self._source: tuple[int, int] | None = None
        self._last_sequence = -1
        self._pressed_buttons: set[str] = set()
        self._pressed_keys: set[str] = set()
        self._move_times: deque[float] = deque()
        self._action_times: deque[float] = deque()
        self._last_activity: float | None = None

    def set_source_size(self, width: int, height: int) -> None:
        """Report the current captured desktop resolution (from the video track)
        so pointer coordinates can be inverted through the capture letterbox."""
        if width > 0 and height > 0:
            self._source = (width, height)

    def set_frame_size(self, width: int, height: int) -> None:
        """Update the encoded frame dimensions after a live quality change."""
        if width > 0 and height > 0:
            self._frame_width = width
            self._frame_height = height

    @property
    def pressed_count(self) -> int:
        return len(self._pressed_buttons) + len(self._pressed_keys)

    def handle(self, message: dict[str, Any], *, now: float) -> bool:
        sequence = message.get("sequence")
        if not isinstance(sequence, int) or sequence <= self._last_sequence:
            return False  # non-monotonic / replayed
        self._last_sequence = sequence

        event = message.get("event")
        data = message.get("data")
        if not isinstance(data, dict):
            return False

        applied = self._dispatch(event, data, now=now)
        if applied:
            self._last_activity = now
        return applied

    def _dispatch(self, event: Any, data: dict[str, Any], *, now: float) -> bool:
        if event == "pointer.move":
            return self._move(data, now=now)
        # Safety cleanup must never be blocked by a traffic limiter.
        if event == "control.release-all":
            self.release_all()
            return True
        if event not in {"pointer.button", "pointer.wheel", "key.down", "key.up", "text.input"}:
            return False
        # Releasing input must never be rate-limited (same principle as
        # control.release-all): a dropped "up" would leave a key or button stuck
        # down on the host. Only new presses/scrolls consume the action budget.
        is_release = event == "key.up" or (
            event == "pointer.button" and data.get("action") == "up"
        )
        if not is_release and not self._allow_action(now):
            return False
        if event == "pointer.button":
            return self._button(data)
        if event == "pointer.wheel":
            return self._wheel(data)
        if event == "key.down":
            return self._key(data, "down")
        if event == "key.up":
            return self._key(data, "up")
        if event == "text.input":
            return self._text(data)
        return False

    def _allow_action(self, now: float) -> bool:
        while self._action_times and now - self._action_times[0] >= 1.0:
            self._action_times.popleft()
        if len(self._action_times) >= self._action_rate_limit_per_second:
            return False
        self._action_times.append(now)
        return True

    def _move(self, data: dict[str, Any], *, now: float) -> bool:
        if self._source is None:
            return False
        x, y = data.get("x"), data.get("y")
        if not _is_unit(x) or not _is_unit(y):
            return False
        # Sliding-window rate limit: drop moves beyond the per-second cap.
        while self._move_times and now - self._move_times[0] > 1.0:
            self._move_times.popleft()
        if len(self._move_times) >= self._rate_limit_per_second:
            return False
        self._move_times.append(now)
        point = frame_to_desktop_absolute(
            float(x),
            float(y),
            source_width=self._source[0],
            source_height=self._source[1],
            frame_width=self._frame_width,
            frame_height=self._frame_height,
        )
        if point is None:
            return False
        self._sink.move_absolute(point.x, point.y)
        return True

    def _button(self, data: dict[str, Any]) -> bool:
        button, action = data.get("button"), data.get("action")
        if button not in _BUTTONS or action not in ("down", "up"):
            return False
        if action == "down":
            self._pressed_buttons.add(button)
        else:
            self._pressed_buttons.discard(button)
        self._sink.mouse_button(button, action)
        return True

    def _wheel(self, data: dict[str, Any]) -> bool:
        delta_x, delta_y = data.get("deltaX"), data.get("deltaY")
        if not _is_wheel(delta_x) or not _is_wheel(delta_y):
            return False
        self._sink.wheel(delta_x, delta_y)
        return True

    def _key(self, data: dict[str, Any], action: str) -> bool:
        code = data.get("code")
        # fullmatch (not match) so a trailing newline cannot slip past the
        # `$`-anchored pattern; the whole string must be an allowed key code.
        if not isinstance(code, str) or not _KEY_CODE_RE.fullmatch(code):
            return False
        if action == "down":
            self._pressed_keys.add(code)
        else:
            self._pressed_keys.discard(code)
        self._sink.key(code, action)
        return True

    def _text(self, data: dict[str, Any]) -> bool:
        """Composed text from the mobile soft keyboard (text.input). Stateless —
        characters are injected as unicode press/release pairs, so there is
        nothing for release-all/watchdog to track."""
        text = data.get("text")
        if not _is_safe_text(text):
            return False
        self._sink.type_text(text)
        return True

    def release_all(self) -> None:
        """Release every tracked button and key. Idempotent; safe to call on any
        teardown path (blur, close, watchdog, local stop)."""
        for button in sorted(self._pressed_buttons):
            self._sink.mouse_button(button, "up")
        for code in sorted(self._pressed_keys):
            self._sink.key(code, "up")
        self._pressed_buttons.clear()
        self._pressed_keys.clear()

    def watchdog_expired(self, now: float) -> bool:
        return (
            self._last_activity is not None
            and now - self._last_activity >= self._watchdog_seconds
        )

    def on_watchdog_tick(self, now: float) -> bool:
        """Called periodically. Releases all input if no activity within the
        watchdog window. Returns True if it fired."""
        if self.watchdog_expired(now):
            self.release_all()
            self._last_activity = None
            return True
        return False
