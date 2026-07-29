"""Tests for the single-instance guard (prevents concurrent agents)."""

from __future__ import annotations

import sys
import unittest

from mirror_host_agent import single_instance


class SingleInstanceTests(unittest.TestCase):
    def test_first_acquire_succeeds(self) -> None:
        handle = single_instance.acquire("Global\\MirrorHostAgentTest.First")
        self.assertIsNotNone(handle)

    @unittest.skipUnless(sys.platform == "win32", "named mutex is Windows-only")
    def test_second_acquire_of_same_name_is_refused(self) -> None:
        name = "Global\\MirrorHostAgentTest.Duplicate"
        first = single_instance.acquire(name)
        self.assertIsNotNone(first)
        # A second acquire while the first handle is still open must be refused,
        # which is what makes a duplicate agent exit instead of fighting the
        # running one over the single-session room.
        second = single_instance.acquire(name)
        self.assertIsNone(second)

    def test_never_raises_on_bad_name(self) -> None:
        # Guard failures must fail open (return a truthy sentinel), never crash
        # startup.
        result = single_instance.acquire("\\\\?\\invalid" + "x" * 300)
        self.assertIsNotNone(result)


if __name__ == "__main__":
    unittest.main()
