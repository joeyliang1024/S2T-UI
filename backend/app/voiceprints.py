import asyncio
import json
import math
import statistics
import time
import uuid

import anyio

from .core import fail, now, safe


def cosine(left, right):
    if len(left) != len(right):
        return 0
    denominator = math.sqrt(sum(x * x for x in left) * sum(x * x for x in right))
    return sum(a * b for a, b in zip(left, right)) / denominator if denominator else 0


def identities(matches):
    grouped = {}
    for match in matches:
        key = match["NT"].strip().lower()
        if key and (key not in grouped or match["score"] > grouped[key]["score"]):
            grouped[key] = match
    return sorted(grouped.values(), key=lambda item: item["score"], reverse=True)


class Voiceprints:
    def __init__(self, storage, settings, audio, client):
        self.storage, self.settings, self.audio, self.client = storage, settings, audio, client
        self.threshold = float(settings.env.get("S2T_VOICEPRINT_THRESHOLD", 0.65))
        self.margin = float(settings.env.get("S2T_VOICEPRINT_MARGIN", 0.05))
        self.fast_score = float(settings.env.get("S2T_VOICEPRINT_FAST_SCORE", 0.75))
        self.fast_margin = float(settings.env.get("S2T_VOICEPRINT_FAST_MARGIN", 0.15))
        self.minimum_blocks = int(settings.env.get("S2T_VOICEPRINT_MIN_BLOCKS", 2))
        self.candidate_limit = int(settings.env.get("S2T_VOICEPRINT_CANDIDATE_BLOCKS", 3))
        self.model = settings.env.get(
            "S2T_VOICEPRINT_EMBEDDING_MODEL_NAME",
            "3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx",
        )
        self.version = settings.env.get("S2T_VOICEPRINT_EMBEDDING_VERSION", "sherpa-onnx-v1")
        self.collection_lock = asyncio.Lock()
        self.dimension = None

    async def milvus(self, path, **data):
        config = self.settings.milvus
        endpoint = config["ENDPOINT"]
        if "://" not in endpoint:
            endpoint = "http://" + endpoint
        response = await self.client.post(
            endpoint.rstrip("/") + "/v2/vectordb/" + path,
            headers={"authorization": "Bearer " + config["TOKEN"]},
            json={"dbName": config["DB_NAME"], "collectionName": config["COLLECTION"], **data},
            timeout=30,
        )
        result = response.json()
        if not response.is_success or result.get("code") != 0:
            fail(503, "聲紋向量儲存暫時不可用")
        return result.get("data", {})

    async def ensure_collection(self, dimension):
        if self.dimension == dimension:
            return
        async with self.collection_lock:
            exists = await self.milvus("collections/has")
            if not (
                exists is True
                or isinstance(exists, dict)
                and (exists.get("value") or exists.get("has"))
            ):
                try:
                    await self.milvus(
                        "collections/create",
                        dimension=dimension,
                        primaryFieldName="id",
                        idType="VarChar",
                        vectorFieldName="embedding",
                        metricType="COSINE",
                        autoId=False,
                        enableDynamicField=True,
                        params={"max_length": "256", "consistencyLevel": "Strong"},
                    )
                except Exception:
                    exists = await self.milvus("collections/has")
                    if not (exists is True or isinstance(exists, dict) and exists.get("value")):
                        raise
            await self.milvus("collections/load")
            self.dimension = dimension

    async def vector_put(self, user_id, record):
        if self.settings.milvus:
            await self.ensure_collection(len(record["embedding"]))
            await self.milvus("entities/upsert", data=[record])
        elif self.storage.pool:
            from psycopg.types.json import Jsonb

            async with self.storage.pool.connection() as connection:
                await connection.execute(
                    "INSERT INTO s2t_python_vectors(id,user_id,value) VALUES(%s,%s,%s) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
                    (record["id"], user_id, Jsonb(record)),
                )
        else:
            file = self.settings.root / "vectors.json"
            async with self.storage.transaction("vectors"):
                records = json.loads(file.read_text()) if file.exists() else []
                records = [item for item in records if item["id"] != record["id"]] + [record]
                temporary = file.with_suffix(".python.tmp")
                temporary.write_text(json.dumps(records))
                temporary.replace(file)

    async def vector_remove(self, user_id, vector_id):
        safe(vector_id)
        if self.settings.milvus:
            exists = await self.milvus("collections/has")
            if exists is True or isinstance(exists, dict) and exists.get("value"):
                await self.milvus("entities/delete", filter="id in " + json.dumps([vector_id]))
        elif self.storage.pool:
            async with self.storage.pool.connection() as connection:
                await connection.execute(
                    "DELETE FROM s2t_python_vectors WHERE id=%s AND user_id=%s",
                    (vector_id, user_id),
                )
        else:
            file = self.settings.root / "vectors.json"
            async with self.storage.transaction("vectors"):
                records = json.loads(file.read_text()) if file.exists() else []
                temporary = file.with_suffix(".python.tmp")
                temporary.write_text(
                    json.dumps([item for item in records if item["id"] != vector_id])
                )
                temporary.replace(file)

    async def own(self, user_id):
        return await self.storage.get(user_id, "voiceprints") or []

    async def visible(self, user_id):
        authorization = await self.storage.get(user_id, "sharing-authorization") or {}
        if self.storage.pool:
            async with self.storage.pool.connection() as connection:
                rows = await (
                    await connection.execute(
                        "SELECT scope,value FROM s2t_config_records WHERE record_key='voiceprints'"
                    )
                ).fetchall()
        else:
            async with self.storage.transaction() as tx:
                rows = [
                    (key[: -len(":voiceprints")], entry["value"])
                    for key, entry in tx.records.items()
                    if key.endswith(":voiceprints")
                ]
        result = []
        for owner, values in rows:
            owner_auth = await self.storage.get(owner, "sharing-authorization") or {}
            for item in values if isinstance(values, list) else []:
                if (
                    item.get("embeddingModel") != self.model
                    or item.get("embeddingVersion") != self.version
                ):
                    continue
                shared = (
                    authorization.get("approved") is True
                    and owner_auth.get("approved") is True
                    and (
                        item.get("sharingScope") == "organization"
                        or item.get("sharingScope") == "department"
                        and authorization.get("department")
                        and authorization["department"] == owner_auth.get("department")
                    )
                )
                if owner == user_id or shared:
                    result.append(item["id"])
        return result

    async def matches(self, embedding, allowed):
        if not allowed:
            return []
        if self.settings.milvus:
            await self.ensure_collection(len(embedding))
            result = []
            for offset in range(0, len(allowed), 50):
                batch = allowed[offset : offset + 50]
                output = await self.milvus(
                    "entities/search",
                    annsField="embedding",
                    data=[embedding],
                    filter="id in " + json.dumps(batch),
                    limit=len(batch),
                    outputFields=["id", "NT", "Department"],
                    searchParams={"metricType": "COSINE"},
                    consistencyLevel="Strong",
                )
                for item in output.get("results", []) if isinstance(output, dict) else output:
                    result.append(
                        {**item, "score": float(item.get("score", item.get("distance", 0)))}
                    )
            return identities(result)
        if self.storage.pool:
            async with self.storage.pool.connection() as connection:
                rows = await (
                    await connection.execute(
                        "SELECT value FROM s2t_python_vectors WHERE id=ANY(%s)", (allowed,)
                    )
                ).fetchall()
                values = [row[0] for row in rows]
        else:
            file = self.settings.root / "vectors.json"
            values = await anyio.to_thread.run_sync(
                lambda: json.loads(file.read_text()) if file.exists() else []
            )
        selected = set(allowed)
        return identities(
            [
                {key: item[key] for key in ("id", "NT", "Department")}
                | {"score": cosine(embedding, item["embedding"])}
                for item in values
                if item["id"] in selected
            ]
        )

    async def enroll(self, user, filename, scope, consent):
        if scope not in {"private", "department", "organization"}:
            fail(400, "無效的共享範圍")
        authorization = await self.storage.get(user["id"], "sharing-authorization") or {}
        if scope != "private" and (consent != "true" or authorization.get("approved") is not True):
            fail(403, "聲紋共享需要使用者同意與管理者授權")
        quality = await self.audio.invoke("embedding", filename, {"enroll": True})
        vector_id = "vp-" + str(uuid.uuid4())
        entry = {
            "id": vector_id,
            "createdAt": now(),
            "NT": user["NT"],
            "Department": user["Department"],
            "dimensions": len(quality["embedding"]),
            "embeddingModel": self.model,
            "embeddingVersion": self.version,
            "sharingScope": scope,
            "sampleDurationMs": quality["durationMs"],
            "sampleRmsDbfs": quality["rmsDbfs"],
        }
        await self.storage.update(
            user["id"],
            "voiceprint-compensations",
            lambda value: (
                (value or [])
                + [
                    {
                        "id": vector_id,
                        "type": "enroll-cleanup",
                        "createdAt": now(),
                        "eligibleAfter": time.time() * 1000 + 120000,
                    }
                ]
            ),
        )
        await self.vector_put(
            user["id"],
            {
                "id": vector_id,
                "NT": user["NT"],
                "Department": user["Department"],
                "embedding": quality["embedding"],
            },
        )
        if self.storage.pool:
            async with self.storage.pool.connection() as connection:
                await connection.execute(
                    "INSERT INTO s2t_voiceprint_records(vector_id,user_id,embedding_model,embedding_version,sharing_scope) VALUES(%s,%s,%s,%s,%s)",
                    (vector_id, user["id"], self.model, self.version, scope),
                )
        await self.storage.update(user["id"], "voiceprints", lambda value: (value or []) + [entry])
        await self.storage.update(
            user["id"],
            "voiceprint-compensations",
            lambda value: [item for item in (value or []) if item["id"] != vector_id],
        )
        return entry

    async def delete(self, user_id, vector_id):
        await self.storage.update(
            user_id,
            "voiceprint-compensations",
            lambda value: (value or []) + [{"id": vector_id, "type": "delete", "createdAt": now()}],
        )
        await self.vector_remove(user_id, vector_id)
        if self.storage.pool:
            async with self.storage.pool.connection() as connection:
                await connection.execute(
                    "DELETE FROM s2t_voiceprint_records WHERE vector_id=%s AND user_id=%s",
                    (vector_id, user_id),
                )
        await self.storage.update(
            user_id,
            "voiceprints",
            lambda value: [item for item in (value or []) if item["id"] != vector_id],
        )
        await self.storage.update(
            user_id,
            "voiceprint-compensations",
            lambda value: [item for item in (value or []) if item["id"] != vector_id],
        )

    async def reconcile(self, user_id):
        own = {item["id"] for item in await self.own(user_id)}
        for entry in await self.storage.get(user_id, "voiceprint-compensations") or []:
            if entry.get("eligibleAfter", 0) > time.time() * 1000:
                continue
            if entry.get("type") == "delete" or entry["id"] not in own:
                await self.delete(user_id, entry["id"])
            else:
                await self.storage.update(
                    user_id,
                    "voiceprint-compensations",
                    lambda value: [item for item in (value or []) if item["id"] != entry["id"]],
                )

    async def identify(self, user_id, filename):
        allowed = await self.visible(user_id)
        quality = await self.audio.invoke("embedding", filename)
        matches = await self.matches(quality["embedding"], allowed)
        best = matches[0] if matches else None
        accepted = (
            best
            and best["score"] >= self.threshold
            and (len(matches) < 2 or best["score"] - matches[1]["score"] >= self.margin)
        )
        return {
            "threshold": self.threshold,
            "margin": self.margin,
            "match": best if accepted else None,
        }

    async def label(self, user_id, filename, turns):
        allowed = await self.visible(user_id)
        if not allowed or not turns:
            return turns
        blocks = await self.audio.invoke(
            "speaker-embeddings", filename, {"turns": turns, "matching": True}
        )
        recognized = {}
        for speaker, vectors in blocks.items():
            first = (await self.matches(vectors[0], allowed))[: self.candidate_limit]
            if not first:
                continue
            best = first[0]
            if best["score"] >= self.fast_score and (
                len(first) < 2 or best["score"] - first[1]["score"] >= self.fast_margin
            ):
                recognized[speaker] = best
                continue
            scores = {item["NT"].lower(): [item["score"]] for item in first}
            for vector in vectors[1:]:
                matches = {
                    item["NT"].lower(): item["score"]
                    for item in await self.matches(vector, allowed)
                }
                for name in scores:
                    scores[name].append(matches.get(name, 0))
            ranked = sorted(
                [
                    {
                        **candidate,
                        "score": statistics.median(scores[candidate["NT"].lower()]),
                        "hits": sum(
                            score >= self.threshold for score in scores[candidate["NT"].lower()]
                        ),
                    }
                    for candidate in first
                ],
                key=lambda item: item["score"],
                reverse=True,
            )
            best = ranked[0]
            if (
                best["score"] >= self.threshold
                and best["hits"] >= self.minimum_blocks
                and (len(ranked) < 2 or best["score"] - ranked[1]["score"] >= self.margin)
            ):
                recognized[speaker] = best
        return [
            {
                **turn,
                "speaker": recognized[turn["speaker"]]["NT"],
                "Department": recognized[turn["speaker"]]["Department"],
                "matchScore": recognized[turn["speaker"]]["score"],
            }
            if turn["speaker"] in recognized
            else turn
            for turn in turns
        ]
