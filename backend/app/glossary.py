"""Shared CSV terminology; file I/O and parsing stay off the async event loop."""

import csv
import asyncio
import logging
from pathlib import Path

import anyio

from .core import fail


NO_MATCH = "本次無匹配術語, 請依據場內情境自由發揮專業翻譯"
logger = logging.getLogger(__name__)


def matched_glossary(text, rows):
    """Case-sensitive substring matching, preserving the CSV row order."""
    return (
        "\n".join(f"{jargon}->{translation}" for jargon, translation in rows if jargon in text)
        or NO_MATCH
    )


class CsvGlossary:
    def __init__(self, path):
        self.path = Path(path)
        self.version = None
        self.rows = ()
        self.inflight = None
        self.missing_warned = False

    async def load_glossary(self):
        # Concurrent requests share one file check rather than queueing one
        # thread-pool round trip per caller. Sequential requests still recheck
        # the file; there is no stale-cache TTL.
        if self.inflight is None or self.inflight.done():
            self.inflight = asyncio.create_task(self._read())
            self.inflight.add_done_callback(lambda task: None if task.cancelled() else task.exception())
        return await asyncio.shield(self.inflight)

    async def _read(self):
        try:
            return await anyio.to_thread.run_sync(self._load)
        except (OSError, UnicodeError, csv.Error, ValueError):
            logger.exception("Cannot load translation jargon CSV: %s", self.path)
            fail(503, "翻譯術語 CSV 無法讀取或格式無效，請檢查 jargon 與 az_jargon_listen 欄位")

    def _load(self):
        try:
            metadata = self.path.stat()
        except FileNotFoundError:
            self.version, self.rows = None, ()
            if not self.missing_warned:
                logger.warning("Translation jargon CSV not found: %s", self.path)
                self.missing_warned = True
            return self.rows
        version = (metadata.st_dev, metadata.st_ino, metadata.st_mtime_ns, metadata.st_size)
        if self.version == version:
            return self.rows
        # UTF-8 BOM and quoted commas/newlines are supported by the CSV reader.
        with self.path.open(encoding="utf-8-sig", newline="") as source:
            reader = csv.DictReader(source, strict=True)
            fields = [field.strip() for field in reader.fieldnames or []]
            if len(fields) != len(set(fields)) or not {"jargon", "az_jargon_listen"}.issubset(
                fields
            ):
                raise ValueError("CSV requires unique jargon and az_jargon_listen columns")
            reader.fieldnames = fields
            rows = []
            for row in reader:
                if None in row:
                    raise ValueError("CSV row contains unexpected columns")
                jargon = (row.get("jargon") or "").strip()
                translation = (row.get("az_jargon_listen") or "").strip()
                if jargon and translation:
                    rows.append((jargon, translation))
        self.rows, self.version = tuple(rows), version
        self.missing_warned = False
        return self.rows
