"""Self-heal a wedged signaling connection by restarting the agent process.

The agent's reconnect loop retries on any *exception*, but some drops don't
raise: a half-open TCP socket can leave the read loop waiting forever, and a
blocked event loop stops making progress entirely. In those cases the agent
shows "connected" while actually being offline, and only a manual restart
recovers it.

This watchdog runs on its own thread (so it works even if the asyncio loop is
frozen) and polls "seconds since the signaling was last healthy". Once that
exceeds a threshold it fires a one-shot restart callback and stops. Healthy
progress is reported by the agent on connect, on each heartbeat send, and on
each received message, so a working (even idle) connection keeps it fresh.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable

LOGGER = logging.getLogger("mirror_host_agent.signaling_watchdog")

DEFAULT_STALE_THRESHOLD_SECONDS = 90.0
DEFAULT_CHECK_INTERVAL_SECONDS = 10.0


class SignalingWatchdog:
    """Fire ``on_stale`` once when the signaling connection stays unhealthy."""

    def __init__(
        self,
        *,
        seconds_since_healthy: Callable[[], float],
        on_stale: Callable[[], None],
        stale_threshold_seconds: float = DEFAULT_STALE_THRESHOLD_SECONDS,
        check_interval_seconds: float = DEFAULT_CHECK_INTERVAL_SECONDS,
    ) -> None:
        self._seconds_since_healthy = seconds_since_healthy
        self._on_stale = on_stale
        self._threshold = stale_threshold_seconds
        self._interval = check_interval_seconds
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(
            target=self._run, name="signaling-watchdog", daemon=True
        )
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _run(self) -> None:
        # Wait one interval before the first check so startup has time to connect.
        while not self._stop.wait(self._interval):
            try:
                stale = self._seconds_since_healthy()
            except Exception:  # noqa: BLE001 - never let the watchdog die on a read
                continue
            if stale > self._threshold:
                LOGGER.warning(
                    "Signaling stale for %.0fs (> %.0fs); self-restarting agent",
                    stale,
                    self._threshold,
                )
                self._stop.set()
                try:
                    self._on_stale()
                except Exception as error:  # noqa: BLE001 - best-effort restart
                    LOGGER.warning(
                        "Watchdog restart callback failed: %s", type(error).__name__
                    )
                return
