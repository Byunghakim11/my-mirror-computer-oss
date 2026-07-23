"""Tests for the signaling health watchdog (self-restart on wedged connection)."""

from __future__ import annotations

import threading
import time
import unittest

from mirror_host_agent.signaling_watchdog import SignalingWatchdog


class SignalingWatchdogTests(unittest.TestCase):
    def test_fires_on_stale(self) -> None:
        fired = threading.Event()
        watchdog = SignalingWatchdog(
            seconds_since_healthy=lambda: 999.0,
            on_stale=fired.set,
            stale_threshold_seconds=1.0,
            check_interval_seconds=0.02,
        )
        watchdog.start()
        try:
            self.assertTrue(fired.wait(timeout=2.0))
        finally:
            watchdog.stop()

    def test_does_not_fire_while_healthy(self) -> None:
        fired = threading.Event()
        watchdog = SignalingWatchdog(
            seconds_since_healthy=lambda: 0.0,
            on_stale=fired.set,
            stale_threshold_seconds=1.0,
            check_interval_seconds=0.02,
        )
        watchdog.start()
        try:
            self.assertFalse(fired.wait(timeout=0.3))
        finally:
            watchdog.stop()

    def test_fires_only_once(self) -> None:
        calls = []
        lock = threading.Lock()

        def on_stale() -> None:
            with lock:
                calls.append(1)

        watchdog = SignalingWatchdog(
            seconds_since_healthy=lambda: 999.0,
            on_stale=on_stale,
            stale_threshold_seconds=0.0,
            check_interval_seconds=0.02,
        )
        watchdog.start()
        time.sleep(0.3)
        watchdog.stop()
        self.assertEqual(len(calls), 1)

    def test_read_error_does_not_kill_the_watchdog(self) -> None:
        fired = threading.Event()
        state = {"first": True}

        def flaky() -> float:
            if state["first"]:
                state["first"] = False
                raise RuntimeError("transient")
            return 999.0

        watchdog = SignalingWatchdog(
            seconds_since_healthy=flaky,
            on_stale=fired.set,
            stale_threshold_seconds=1.0,
            check_interval_seconds=0.02,
        )
        watchdog.start()
        try:
            # Survives the first raising read and still fires on the next.
            self.assertTrue(fired.wait(timeout=2.0))
        finally:
            watchdog.stop()


if __name__ == "__main__":
    unittest.main()
