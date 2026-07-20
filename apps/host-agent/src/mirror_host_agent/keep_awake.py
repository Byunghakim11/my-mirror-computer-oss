"""Windows-only keep-awake and display-wake control.

Uses ``SetThreadExecutionState`` so the home PC's SYSTEM never sleeps while the
agent is running, while still letting the DISPLAY turn off on its own to save
power. When a viewer connects, :func:`wake_display` briefly asserts the
display-required flag to turn the monitor back on, then reverts to the
system-only keep-awake state so the display is not held on forever.

No-op (and import-safe) on non-Windows platforms so the rest of the codebase
and the test suite can import and call these functions on any OS.
"""

from __future__ import annotations

import logging
import sys

LOGGER = logging.getLogger("mirror_host_agent.keep_awake")

# SetThreadExecutionState flags (winbase.h).
ES_CONTINUOUS = 0x80000000
ES_SYSTEM_REQUIRED = 0x00000001
ES_DISPLAY_REQUIRED = 0x00000002

_KEEP_SYSTEM_AWAKE = ES_CONTINUOUS | ES_SYSTEM_REQUIRED
_WAKE_DISPLAY = ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED
_ALLOW_SLEEP = ES_CONTINUOUS


def _set_execution_state(flags: int) -> bool:
    """Call the real Win32 API. Isolated so tests can monkeypatch this one
    function instead of reaching into ctypes. No-op (returns False) off
    Windows or if the call fails for any reason."""
    if sys.platform != "win32":
        return False
    try:
        import ctypes

        result = ctypes.windll.kernel32.SetThreadExecutionState(flags)
        return bool(result)
    except Exception:  # noqa: BLE001 - never fatal
        LOGGER.warning("SetThreadExecutionState failed for flags=0x%08x", flags)
        return False


def prevent_system_sleep() -> None:
    """Keep the SYSTEM awake but allow the DISPLAY to turn off. Idempotent.

    Delegates the actual platform check to :func:`_set_execution_state`
    (a no-op off Windows), so this function stays safe to call from any OS.
    """
    if not _set_execution_state(_KEEP_SYSTEM_AWAKE):
        LOGGER.warning("Could not prevent system sleep")


def wake_display() -> None:
    """Briefly turn the display on, then revert to the system-only keep-awake
    state so the display is not held on indefinitely."""
    if not _set_execution_state(_WAKE_DISPLAY):
        LOGGER.warning("Could not wake display")
        return
    prevent_system_sleep()


def allow_sleep() -> None:
    """Release the keep-awake request on shutdown."""
    if not _set_execution_state(_ALLOW_SLEEP):
        LOGGER.warning("Could not release keep-awake state")


__all__ = [
    "ES_CONTINUOUS",
    "ES_DISPLAY_REQUIRED",
    "ES_SYSTEM_REQUIRED",
    "allow_sleep",
    "prevent_system_sleep",
    "wake_display",
]
