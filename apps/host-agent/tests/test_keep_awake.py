from __future__ import annotations

import unittest
from unittest.mock import patch

from mirror_host_agent import keep_awake


class KeepAwakeTests(unittest.TestCase):
    """Platform-independent: `_set_execution_state` is monkeypatched so these
    assertions run the same on Windows, macOS, and Linux CI."""

    def test_prevent_system_sleep_sets_continuous_and_system_required(self) -> None:
        with patch.object(
            keep_awake, "_set_execution_state", return_value=True
        ) as mock_call:
            keep_awake.prevent_system_sleep()

        mock_call.assert_called_once_with(
            keep_awake.ES_CONTINUOUS | keep_awake.ES_SYSTEM_REQUIRED
        )

    def test_wake_display_sets_display_required_then_reverts(self) -> None:
        with patch.object(
            keep_awake, "_set_execution_state", return_value=True
        ) as mock_call:
            keep_awake.wake_display()

        self.assertEqual(mock_call.call_count, 2)
        first_flags, second_flags = (
            call.args[0] for call in mock_call.call_args_list
        )
        self.assertEqual(
            first_flags,
            keep_awake.ES_CONTINUOUS
            | keep_awake.ES_SYSTEM_REQUIRED
            | keep_awake.ES_DISPLAY_REQUIRED,
        )
        self.assertEqual(
            second_flags, keep_awake.ES_CONTINUOUS | keep_awake.ES_SYSTEM_REQUIRED
        )

    def test_wake_display_does_not_revert_when_initial_call_fails(self) -> None:
        with patch.object(
            keep_awake, "_set_execution_state", return_value=False
        ) as mock_call:
            keep_awake.wake_display()

        mock_call.assert_called_once_with(
            keep_awake.ES_CONTINUOUS
            | keep_awake.ES_SYSTEM_REQUIRED
            | keep_awake.ES_DISPLAY_REQUIRED
        )

    def test_allow_sleep_sets_continuous_only(self) -> None:
        with patch.object(
            keep_awake, "_set_execution_state", return_value=True
        ) as mock_call:
            keep_awake.allow_sleep()

        mock_call.assert_called_once_with(keep_awake.ES_CONTINUOUS)

    def test_set_execution_state_is_a_no_op_off_windows(self) -> None:
        with patch.object(keep_awake.sys, "platform", "linux"):
            result = keep_awake._set_execution_state(keep_awake.ES_CONTINUOUS)

        self.assertFalse(result)


if __name__ == "__main__":
    unittest.main()
