"""Sandboxed catalog + path resolution for downloads (agent -> viewer, ADR-014).

The viewer may only see and pull files that sit directly inside one dedicated
``Outgoing`` folder. Names are validated with the same sanitizer used for
uploads, symlinks are skipped, and a resolved path is confirmed to remain a
regular file whose parent is exactly the Outgoing folder — so a crafted name or
a symlink can never read outside it. Kept free of WebRTC/Windows so the security
logic is unit-testable against a real temp directory.
"""

from __future__ import annotations

from pathlib import Path

from .file_transfer import MAX_FILE_BYTES, sanitize_filename

MAX_CATALOG_ENTRIES = 500


def list_outgoing(outgoing_dir: Path) -> list[dict[str, object]]:
    """Return ``[{name, size}]`` for regular, non-symlink files directly in the
    Outgoing folder that pass the same name policy as uploads. Never raises."""
    try:
        children = sorted(outgoing_dir.iterdir(), key=lambda item: item.name.lower())
    except OSError:
        return []
    entries: list[dict[str, object]] = []
    for child in children:
        try:
            if child.is_symlink() or not child.is_file():
                continue
            size = child.stat().st_size
        except OSError:
            continue
        if size > MAX_FILE_BYTES:
            continue
        if sanitize_filename(child.name) is None:
            continue
        entries.append({"name": child.name, "size": size})
        if len(entries) >= MAX_CATALOG_ENTRIES:
            break
    return entries


def resolve_outgoing_file(outgoing_dir: Path, name: object) -> Path | None:
    """Map a viewer-supplied name to a real file inside ``outgoing_dir``, or None
    if it is unsafe/missing. Rejects traversal, symlink escape, non-files, and
    anything over the size cap."""
    safe = sanitize_filename(name)
    if safe is None:
        return None
    try:
        base = outgoing_dir.resolve()
        candidate = (base / safe).resolve()
    except OSError:
        return None
    # After resolving symlinks the real file must live directly in the folder.
    if candidate.parent != base:
        return None
    try:
        if not candidate.is_file() or candidate.stat().st_size > MAX_FILE_BYTES:
            return None
    except OSError:
        return None
    return candidate
