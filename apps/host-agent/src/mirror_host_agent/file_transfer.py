"""Sandboxed file receive for remote transfer (M4, ADR-014).

Files are transferred peer-to-peer over a dedicated WebRTC DataChannel and never
touch the signaling server. On the home PC the agent only ever writes into one
dedicated ``Incoming`` folder: filenames are sanitized to a bare basename (no
traversal, no absolute paths, no reserved names), executables/scripts are
blocked, the size is capped and enforced against the declared length, chunks are
streamed to a temp file, and only a SHA-256 match triggers an atomic rename into
the folder. Names/paths/hashes are not persisted anywhere else.

Kept free of WebRTC and (mostly) of Windows so the security logic is unit
testable against a real temp directory. The Mark-of-the-Web tag is applied by an
optional injected hook so the platform bit stays out of the core.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

MAX_FILE_BYTES = 500 * 1024 * 1024  # ADR-014 initial cap
MAX_FILENAME_LENGTH = 255
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")

# Executables / scripts are blocked by default (ADR-014): a received file must be
# inert data, never something that can run on the host. Compared case-folded.
BLOCKED_EXTENSIONS = frozenset(
    {
        ".exe", ".com", ".scr", ".pif", ".msi", ".msp", ".mst",
        ".bat", ".cmd", ".ps1", ".psm1", ".vbs", ".vbe", ".js", ".jse",
        ".ws", ".wsf", ".wsh", ".hta", ".cpl", ".jar", ".reg", ".lnk",
        ".dll", ".sys", ".scf", ".inf", ".gadget", ".application", ".appref-ms",
    }
)

# Windows reserved device names (any extension) — never a legal filename.
_RESERVED_STEMS = frozenset(
    {"con", "prn", "aux", "nul"}
    | {f"com{index}" for index in range(1, 10)}
    | {f"lpt{index}" for index in range(1, 10)}
)


def sanitize_filename(name: object) -> str | None:
    """Reduce a client-supplied name to a safe bare basename, or None if it
    cannot be made safe. Rejects (rather than strips) traversal so a hostile
    name never silently maps onto an unexpected file."""
    if not isinstance(name, str) or not 1 <= len(name) <= MAX_FILENAME_LENGTH:
        return None
    # No directory components, drive letters, or NT stream separators.
    if any(sep in name for sep in ("/", "\\", "\x00")) or ":" in name:
        return None
    if name in (".", "..") or name.startswith("."):
        return None
    # Control characters and characters illegal in Windows filenames.
    if any(ord(ch) < 0x20 for ch in name) or re.search(r'[<>:"|?*]', name):
        return None
    # A trailing dot/space is stripped by Windows and can defeat extension checks.
    if name != name.rstrip(" ."):
        return None
    if Path(name).stem.lower() in _RESERVED_STEMS:
        return None
    return name


def is_blocked_extension(name: str) -> bool:
    return Path(name).suffix.lower() in BLOCKED_EXTENSIONS


def _unique_destination(directory: Path, name: str) -> Path:
    """Never overwrite (ADR-014): 'file.txt' -> 'file (1).txt' on collision."""
    candidate = directory / name
    if not candidate.exists():
        return candidate
    stem, suffix = Path(name).stem, Path(name).suffix
    for index in range(1, 10_000):
        alternative = directory / f"{stem} ({index}){suffix}"
        if not alternative.exists():
            return alternative
    raise FileTransferError("TOO_MANY_COLLISIONS")


class FileTransferError(Exception):
    """Carries a stable protocol error code (``.code``)."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class ReceivedFile:
    path: Path
    size: int


class FileReceiver:
    """One in-progress receive into ``incoming_dir``. Single-use: begin -> many
    write_chunk -> finish/abort. The agent holds at most one at a time."""

    def __init__(
        self,
        incoming_dir: Path,
        *,
        max_bytes: int = MAX_FILE_BYTES,
        mark_of_the_web: Callable[[Path], None] | None = None,
    ) -> None:
        self._incoming_dir = incoming_dir
        self._max_bytes = max_bytes
        self._mark_of_the_web = mark_of_the_web
        self._name: str | None = None
        self._declared_size = 0
        self._declared_sha256 = ""
        self._received = 0
        self._digest = hashlib.sha256()
        self._temp_path: Path | None = None
        self._handle = None
        self._finished = False

    @property
    def active(self) -> bool:
        return self._temp_path is not None and not self._finished

    def begin(self, name: object, size: object, sha256: object) -> str:
        """Validate the offer and open a temp file. Returns the safe basename
        that will be used, or raises FileTransferError with a code."""
        if self._temp_path is not None:
            raise FileTransferError("ALREADY_ACTIVE")
        safe = sanitize_filename(name)
        if safe is None:
            raise FileTransferError("INVALID_NAME")
        if is_blocked_extension(safe):
            raise FileTransferError("BLOCKED_TYPE")
        if not isinstance(size, int) or isinstance(size, bool) or not 0 <= size <= self._max_bytes:
            raise FileTransferError("SIZE_REJECTED")
        if not isinstance(sha256, str) or not _SHA256_RE.match(sha256):
            raise FileTransferError("BAD_DIGEST")

        self._incoming_dir.mkdir(parents=True, exist_ok=True)
        # Temp file lives in the destination dir so the finishing rename is
        # atomic (same filesystem). The .part suffix marks it incomplete.
        temp = self._incoming_dir / f".{safe}.{sha256[:12]}.part"
        self._handle = temp.open("wb")
        self._temp_path = temp
        self._name = safe
        self._declared_size = size
        self._declared_sha256 = sha256
        return safe

    def write_chunk(self, data: bytes) -> None:
        if self._handle is None or self._finished:
            raise FileTransferError("NOT_ACTIVE")
        if not isinstance(data, (bytes, bytearray)):
            raise FileTransferError("BAD_CHUNK")
        self._received += len(data)
        if self._received > self._declared_size:
            # A peer sending more than it declared is aborted, not trusted.
            self.abort()
            raise FileTransferError("SIZE_EXCEEDED")
        self._digest.update(data)
        self._handle.write(data)

    def finish(self) -> ReceivedFile:
        if self._handle is None or self._finished:
            raise FileTransferError("NOT_ACTIVE")
        self._handle.close()
        self._handle = None
        assert self._temp_path is not None and self._name is not None
        if self._received != self._declared_size:
            self._discard_temp()
            raise FileTransferError("SIZE_MISMATCH")
        if self._digest.hexdigest() != self._declared_sha256:
            self._discard_temp()
            raise FileTransferError("DIGEST_MISMATCH")
        destination = _unique_destination(self._incoming_dir, self._name)
        self._temp_path.replace(destination)  # atomic on the same filesystem
        self._temp_path = None
        self._finished = True
        if self._mark_of_the_web is not None:
            try:
                self._mark_of_the_web(destination)
            except OSError:
                pass  # marking is best-effort; the file is already safe-by-policy
        return ReceivedFile(path=destination, size=self._declared_size)

    def abort(self) -> None:
        if self._handle is not None:
            try:
                self._handle.close()
            except OSError:
                pass
            self._handle = None
        self._discard_temp()
        self._finished = True

    def _discard_temp(self) -> None:
        if self._temp_path is not None:
            try:
                self._temp_path.unlink(missing_ok=True)
            except OSError:
                pass
            self._temp_path = None
