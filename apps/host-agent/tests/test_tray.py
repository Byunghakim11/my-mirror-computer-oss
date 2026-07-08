from __future__ import annotations

import unittest

from mirror_host_agent.tray import TrayController


class TrayControllerTests(unittest.TestCase):
    def test_toggle_updates_local_policy_callback(self) -> None:
        changes: list[bool] = []
        tray = TrayController(
            control_enabled=False,
            on_control_change=changes.append,
            on_emergency_lock=lambda: None,
        )

        tray.toggle_control()

        self.assertTrue(tray.control_enabled)
        self.assertEqual(changes, [True])

    def test_emergency_lock_is_one_way_and_overrides_status(self) -> None:
        locks: list[bool] = []
        tray = TrayController(
            control_enabled=True,
            on_control_change=lambda _enabled: None,
            on_emergency_lock=lambda: locks.append(True),
        )

        tray.set_status("controlling")
        tray.emergency_lock()
        tray.toggle_control()
        tray.set_status("online")

        self.assertTrue(tray.locked)
        self.assertFalse(tray.control_enabled)
        self.assertEqual(tray.status, "locked")
        self.assertEqual(locks, [True])


if __name__ == "__main__":
    unittest.main()
