from __future__ import annotations

import hashlib
import tempfile
import unittest
from pathlib import Path

from mirror_host_agent.file_transfer import (
    FileReceiver,
    FileTransferError,
    is_blocked_extension,
    sanitize_filename,
)


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class SanitizeFilenameTests(unittest.TestCase):
    def test_accepts_plain_names(self) -> None:
        self.assertEqual(sanitize_filename("report.pdf"), "report.pdf")
        self.assertEqual(sanitize_filename("사진 01.jpg"), "사진 01.jpg")

    def test_rejects_traversal_and_paths(self) -> None:
        for name in ["../secret", "..", ".", "a/b.txt", "a\\b.txt", "C:evil", "x\x00y"]:
            self.assertIsNone(sanitize_filename(name), name)

    def test_rejects_hidden_reserved_and_illegal(self) -> None:
        for name in [".env", "CON", "nul.txt", 'a"b.txt', "a?b.txt", "trailing. "]:
            self.assertIsNone(sanitize_filename(name), name)

    def test_rejects_non_string_and_oversize(self) -> None:
        self.assertIsNone(sanitize_filename(42))
        self.assertIsNone(sanitize_filename("a" * 256))

    def test_blocked_extensions(self) -> None:
        self.assertTrue(is_blocked_extension("setup.EXE"))
        self.assertTrue(is_blocked_extension("run.ps1"))
        self.assertFalse(is_blocked_extension("photo.png"))


class FileReceiverTests(unittest.TestCase):
    def setUp(self) -> None:
        self._temp = tempfile.TemporaryDirectory()
        self.incoming = Path(self._temp.name) / "Incoming"

    def tearDown(self) -> None:
        self._temp.cleanup()

    def _receiver(self, **kwargs: object) -> FileReceiver:
        return FileReceiver(self.incoming, **kwargs)  # type: ignore[arg-type]

    def test_happy_path_writes_verified_file(self) -> None:
        data = b"hello remote file" * 1000
        receiver = self._receiver()
        receiver.begin("note.txt", len(data), _sha256(data))
        receiver.write_chunk(data[:5000])
        receiver.write_chunk(data[5000:])
        result = receiver.finish()
        self.assertEqual(result.path, self.incoming / "note.txt")
        self.assertEqual(result.path.read_bytes(), data)
        self.assertEqual(result.size, len(data))
        # No leftover temp/part files.
        self.assertEqual([p.name for p in self.incoming.iterdir()], ["note.txt"])

    def test_rejects_blocked_type(self) -> None:
        receiver = self._receiver()
        with self.assertRaises(FileTransferError) as ctx:
            receiver.begin("malware.exe", 10, _sha256(b"x"))
        self.assertEqual(ctx.exception.code, "BLOCKED_TYPE")

    def test_rejects_traversal_name(self) -> None:
        receiver = self._receiver()
        with self.assertRaises(FileTransferError) as ctx:
            receiver.begin("../../etc/passwd", 10, _sha256(b"x"))
        self.assertEqual(ctx.exception.code, "INVALID_NAME")

    def test_rejects_oversize_offer(self) -> None:
        receiver = self._receiver(max_bytes=100)
        with self.assertRaises(FileTransferError) as ctx:
            receiver.begin("big.bin", 101, _sha256(b"x"))
        self.assertEqual(ctx.exception.code, "SIZE_REJECTED")

    def test_aborts_when_chunks_exceed_declared_size(self) -> None:
        receiver = self._receiver()
        receiver.begin("note.txt", 4, _sha256(b"data"))
        with self.assertRaises(FileTransferError) as ctx:
            receiver.write_chunk(b"toolong")
        self.assertEqual(ctx.exception.code, "SIZE_EXCEEDED")
        self.assertFalse(self.incoming.exists() and any(self.incoming.iterdir()))

    def test_digest_mismatch_discards_file(self) -> None:
        data = b"honest bytes"
        receiver = self._receiver()
        receiver.begin("note.txt", len(data), _sha256(b"different"))
        receiver.write_chunk(data)
        with self.assertRaises(FileTransferError) as ctx:
            receiver.finish()
        self.assertEqual(ctx.exception.code, "DIGEST_MISMATCH")
        self.assertFalse(list(self.incoming.iterdir()))

    def test_size_mismatch_discards_file(self) -> None:
        receiver = self._receiver()
        receiver.begin("note.txt", 10, _sha256(b"short"))
        receiver.write_chunk(b"short")  # only 5 of declared 10
        with self.assertRaises(FileTransferError) as ctx:
            receiver.finish()
        self.assertEqual(ctx.exception.code, "SIZE_MISMATCH")

    def test_never_overwrites_existing_file(self) -> None:
        self.incoming.mkdir(parents=True)
        (self.incoming / "note.txt").write_bytes(b"original")
        data = b"new"
        receiver = self._receiver()
        receiver.begin("note.txt", len(data), _sha256(data))
        receiver.write_chunk(data)
        result = receiver.finish()
        self.assertEqual(result.path, self.incoming / "note (1).txt")
        self.assertEqual((self.incoming / "note.txt").read_bytes(), b"original")

    def test_mark_of_the_web_hook_runs_on_success(self) -> None:
        marked: list[Path] = []
        data = b"data"
        receiver = self._receiver(mark_of_the_web=marked.append)
        receiver.begin("note.txt", len(data), _sha256(data))
        receiver.write_chunk(data)
        result = receiver.finish()
        self.assertEqual(marked, [result.path])

    def test_abort_removes_temp(self) -> None:
        receiver = self._receiver()
        receiver.begin("note.txt", 10, _sha256(b"x"))
        receiver.write_chunk(b"partial")
        receiver.abort()
        self.assertFalse(list(self.incoming.iterdir()))


if __name__ == "__main__":
    unittest.main()
