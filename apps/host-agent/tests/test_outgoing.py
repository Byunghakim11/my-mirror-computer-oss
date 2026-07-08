"""Tests for the sandboxed download catalog + path resolution (outgoing.py)."""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from mirror_host_agent.outgoing import (  # noqa: E402
    list_outgoing,
    resolve_outgoing_file,
)


class ListOutgoingTests(unittest.TestCase):
    def test_lists_regular_files_with_sizes(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            (base / "a.txt").write_bytes(b"hello")
            (base / "b.bin").write_bytes(b"\x00\x01\x02")
            (base / "nested").mkdir()  # directories are not listed
            entries = list_outgoing(base)
            names = {entry["name"]: entry["size"] for entry in entries}
            self.assertEqual(names, {"a.txt": 5, "b.bin": 3})

    def test_missing_directory_is_empty(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            self.assertEqual(list_outgoing(Path(temp) / "nope"), [])

    def test_skips_unsafe_names(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            (base / "ok.txt").write_bytes(b"x")
            (base / ".hidden").write_bytes(b"x")  # leading dot rejected by policy
            names = {entry["name"] for entry in list_outgoing(base)}
            self.assertEqual(names, {"ok.txt"})


class ResolveOutgoingFileTests(unittest.TestCase):
    def test_resolves_a_file_in_the_folder(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            (base / "doc.pdf").write_bytes(b"data")
            resolved = resolve_outgoing_file(base, "doc.pdf")
            self.assertIsNotNone(resolved)
            self.assertEqual(resolved.name, "doc.pdf")  # type: ignore[union-attr]

    def test_rejects_traversal_and_absolute_names(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp) / "Outgoing"
            base.mkdir()
            (Path(temp) / "secret.txt").write_bytes(b"top secret")
            self.assertIsNone(resolve_outgoing_file(base, "../secret.txt"))
            self.assertIsNone(resolve_outgoing_file(base, "..\\secret.txt"))
            self.assertIsNone(resolve_outgoing_file(base, "C:\\Windows\\notepad.exe"))

    def test_rejects_missing_and_directories(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            (base / "sub").mkdir()
            self.assertIsNone(resolve_outgoing_file(base, "sub"))
            self.assertIsNone(resolve_outgoing_file(base, "ghost.txt"))


if __name__ == "__main__":
    unittest.main()
