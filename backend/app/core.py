"""Configuration and bounded request parsing shared by the Python services."""

import hashlib
import json
import math
import os
import re
import zlib
import anyio
from datetime import datetime, timezone
from pathlib import Path

from fastapi import HTTPException, Request


def fail(status, message):
    raise HTTPException(status, message)


def now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def integer(value, minimum=0, maximum=2**53 - 1):
    return type(value) is int and minimum <= value <= maximum


def safe(value, maximum=160):
    if not isinstance(value, str) or not re.fullmatch(
        r"[A-Za-z0-9][A-Za-z0-9._-]{0,%d}" % (maximum - 1), value
    ):
        fail(400, "無效的識別碼")
    return value


def digest(value):
    return hashlib.sha256(value if isinstance(value, bytes) else value.encode()).hexdigest()


async def read_body(request: Request, maximum):
    length = request.headers.get("content-length")
    if length and (not length.isdigit() or int(length) > maximum):
        fail(413, "請求內容超過大小上限")
    output = bytearray()
    async for chunk in request.stream():
        if len(output) + len(chunk) > maximum:
            fail(413, "請求內容超過大小上限")
        output.extend(chunk)
    return bytes(output)


async def read_json(request, maximum=256 * 1024, compressed=False):
    encoding = request.headers.get("content-encoding", "identity").lower()
    if encoding != "identity" and not (compressed and encoding == "gzip"):
        fail(415, "不支援此壓縮格式")
    raw = await read_body(request, min(maximum, 8 * 1024**2) if encoding == "gzip" else maximum)
    decode = lambda: decode_json(raw, encoding, maximum)
    if encoding == "gzip" or len(raw) > 65536:
        return await anyio.to_thread.run_sync(decode)
    return decode()


def decode_json(raw, encoding, maximum):
    if encoding == "gzip":
        decoder = zlib.decompressobj(16 + zlib.MAX_WBITS)
        try:
            raw = decoder.decompress(raw, maximum + 1)
            if len(raw) > maximum or decoder.unconsumed_tail:
                fail(413, "解壓縮後超過大小上限")
            if not decoder.eof or decoder.unused_data:
                fail(400, "壓縮資料無效")
        except zlib.error:
            fail(400, "壓縮資料無效")
    try:
        value = json.loads(raw, parse_constant=lambda x: fail(400, "JSON 數字無效"))
    except (ValueError, UnicodeDecodeError):
        fail(400, "請求格式必須是 JSON")
    if not isinstance(value, dict):
        fail(400, "請求必須是物件")
    return value


class Settings:
    def __init__(self, environment=None):
        self.env = dict(os.environ if environment is None else environment)
        self.root = Path(self.env.get("S2T_DATA_DIR") or "data").expanduser().resolve()
        self.models = Path(self.env.get("S2T_MODEL_DIR") or "models").expanduser().resolve()
        self.distributed = self.env.get("S2T_KUBERNETES_MODE") == "true"
        self.production = self.env.get("NODE_ENV") == "production" or self.distributed
        self.role = self.env.get("S2T_PROCESS_ROLE") or "all"
        if self.role not in {"all", "api", "audio-service", "audio-worker"}:
            raise ValueError("Invalid S2T_PROCESS_ROLE")
        self.pg = self.group(
            "PostgreSQL", ["HOST", "PORT", "DB_NAME", "USER", "PASSWORD"], "S2T_POSTGRES_"
        )
        self.s3 = self.group(
            "MinIO", ["ENDPOINT", "BUCKET", "ACCESS_KEY", "SECRET_KEY"], "S2T_MINIO_"
        )
        self.milvus = self.group(
            "Milvus", ["ENDPOINT", "DB_NAME", "COLLECTION", "TOKEN"], "S2T_MILVUS_"
        )
        if self.distributed and not (self.pg and self.s3 and self.env.get("S2T_AUTH_SECRET")):
            raise ValueError("多 Pod 必須設定 PostgreSQL、MinIO 與共享 S2T_AUTH_SECRET")
        if self.production and not self.env.get("S2T_AUTH_SECRET"):
            raise ValueError("正式環境必須設定 S2T_AUTH_SECRET")
        if (
            self.env.get("S2T_COOKIE_SAME_SITE") == "none"
            and self.env.get("S2T_COOKIE_SECURE") != "true"
        ):
            raise ValueError("SameSite=None requires Secure cookies")

    def group(self, label, fields, prefix):
        values = {field: self.env.get(prefix + field, "").strip() for field in fields}
        if any(values.values()) and not all(values.values()):
            raise ValueError(f"{label} 設定不完整")
        return values if all(values.values()) else None

    def service(self, purpose):
        return {
            key: self.env.get(f"S2T_{purpose.upper()}_{suffix}", "").strip()
            for key, suffix in [("endpoint", "ENDPOINT"), ("model", "MODEL"), ("apiKey", "API_KEY")]
        }

    def initialize_files(self):
        source = Path(__file__).resolve().parents[1] / "resources"
        for kind in ("prompt", "template"):
            target = self.root / kind
            target.mkdir(parents=True, exist_ok=True)
            if kind == "template" and any(target.glob("*.md")):
                continue
            for file in (source / kind).glob("*"):
                if (
                    file.suffix.lower() in {".json", ".md", ".markdown"}
                    and not (target / file.name).exists()
                ):
                    try:
                        with (target / file.name).open("xb") as output:
                            output.write(file.read_bytes())
                    except FileExistsError:
                        pass


MODEL_KEYS = "selectedModelId selectedTranslationModelId modelProfiles translationProfiles diarizationProfiles summaryEndpoint summaryModel summaryRequiresApiKey diarizationEndpoint diarizationModel diarizationRequiresApiKey embeddingEndpoint embeddingModel embeddingRequiresApiKey translationEndpoint translationModel translationRequiresApiKey".split()
MANAGED_KEYS = (
    MODEL_KEYS
    + "translationLoadStrategy kaiserResampleEnabled sileroVadEnabled dynaudnormEnabled".split()
)
BOUNDS = dict(
    minSpeechMs=(40, 2000),
    minSilenceMs=(50, 5000),
    preRollMs=(0, 1000),
    noiseFloorOffsetDb=(3, 40),
    chunkMinMs=(200, 6000),
    chunkMaxMs=(200, 6000),
    translationAggregationMs=(0, 2000),
    translationThrottledMs=(100, 10000),
    translationSentenceWaitMs=(0, 15000),
    translationConcurrency=(1, 4),
    translationTemperature=(0, 2),
)


def admin_parameters(value):
    if not isinstance(value, dict):
        fail(400, "進階參數必須是物件")
    for key, number in value.items():
        if (
            key not in BOUNDS
            or type(number) not in (int, float)
            or not math.isfinite(number)
            or not BOUNDS[key][0] <= number <= BOUNDS[key][1]
            or (key != "translationTemperature" and int(number) != number)
        ):
            fail(400, f"進階參數 {key} 無效")
    if value.get("chunkMinMs", 200) > value.get("chunkMaxMs", 6000) or value.get(
        "minSpeechMs", 120
    ) > value.get("chunkMaxMs", 3000):
        fail(400, "語音切段參數範圍無效")
    return value
