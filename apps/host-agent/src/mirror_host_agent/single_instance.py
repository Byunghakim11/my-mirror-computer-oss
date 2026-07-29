"""Allow only one agent process at a time (Windows named mutex).

Multiple concurrent agents are always a bug: the signaling room is
single-session, so they evict each other in a loop, each one keeps a screen
capture alive, and CPU climbs while nothing works. That used to happen whenever
a restart left the previous process alive (``schtasks /End`` does not always
reap the python child).

``acquire()`` returns a handle when this process is the only agent, or None when
another one already holds the mutex — in which case the caller should exit
immediately. Off Windows (tests, CI) it always succeeds.
"""

from __future__ import annotations

import ctypes
import logging
import sys
from ctypes import wintypes
from typing import Any

LOGGER = logging.getLogger("mirror_host_agent.single_instance")

# Global\ so the guard also spans elevated/non-elevated sessions of the same
# machine — exactly the mix a scheduled task plus a manual run produces.
MUTEX_NAME = "Global\\MirrorHostAgent.SingleInstance"

_ERROR_ALREADY_EXISTS = 183
# CreateMutexW on an existing Global\ object we may not open (the scheduled task
# creates it elevated; a manual non-elevated run gets ACCESS_DENIED). The object
# existing at all means another agent holds it, so this must refuse — treating it
# as "guard unavailable" is what previously let duplicate agents pile up.
_ERROR_ACCESS_DENIED = 5


def acquire(name: str = MUTEX_NAME) -> Any | None:
    """Return a mutex handle if no other agent is running, else None.

    The handle must be kept alive for the process lifetime (Windows releases it
    automatically when the process exits, including on a hard kill).
    """
    if sys.platform != "win32":
        return object()
    try:
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateMutexW.argtypes = (
            wintypes.LPVOID,
            wintypes.BOOL,
            wintypes.LPCWSTR,
        )
        kernel32.CreateMutexW.restype = wintypes.HANDLE
        handle = kernel32.CreateMutexW(None, True, name)
        last_error = ctypes.get_last_error()
        if not handle:
            if last_error == _ERROR_ACCESS_DENIED:
                # The named object exists but belongs to a more privileged
                # session (the elevated scheduled task) — another agent is
                # running, so refuse rather than starting a duplicate.
                LOGGER.warning("Another agent instance holds the guard (access denied)")
                return None
            # Could not create the mutex for another reason (e.g. name policy):
            # fail open so a guard problem never prevents the agent from running.
            LOGGER.warning("Single-instance guard unavailable (error %d)", last_error)
            return object()
        if last_error == _ERROR_ALREADY_EXISTS:
            kernel32.CloseHandle(handle)
            return None
        return handle
    except Exception as error:  # noqa: BLE001 - guard must never break startup
        LOGGER.warning(
            "Single-instance guard failed (%s); continuing", type(error).__name__
        )
        return object()
