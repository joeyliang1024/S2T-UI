import asyncio
import hashlib
import struct
import time
import uuid

import anyio

from .core import fail, integer, now, safe
from .storage import UNCHANGED


def wav_header(size, rate):
    return struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF",
        size + 36,
        b"WAVE",
        b"fmt ",
        16,
        1,
        1,
        rate,
        rate * 2,
        2,
        16,
        b"data",
        size,
    )


class Recordings:
    def __init__(self, storage):
        self.storage = storage

    def key(self, recording_id):
        return "recording-" + safe(recording_id, 120)

    async def status(self, user_id, recording_id):
        value = await self.storage.get(user_id, self.key(recording_id))
        return None if value and value.get("state") == "deleted" else value

    async def append(self, user_id, recording_id, index, start, rate, audio):
        key = self.key(recording_id)
        if (
            not integer(index, 0, 99999)
            or not integer(start)
            or not integer(rate, 8000, 192000)
            or not audio
            or len(audio) % 2
            or len(audio) > 1024**2
            or start * 2 + len(audio) > 2 * 1024**3 - 44
        ):
            fail(400, "無效的 PCM chunk")
        digest = hashlib.sha256(audio).hexdigest()
        blob_key = f"chunks/{recording_id}/{index}-{digest}-{uuid.uuid4().hex}"
        entry = {"digest": digest, "blobKey": blob_key, "startSample": start, "samples": len(audio) // 2}

        def validate(value):
            if value.get("state") not in {"recording", "completed"}:
                fail(409, "錄音已停止")
            if value["sampleRate"] != rate:
                fail(409, "錄音取樣率不同")
            existing = value["chunks"].get(str(index))
            reserved = value.get("pendingChunks", {}).get(str(index))
            if (existing or reserved) and any((existing or reserved).get(field) != entry[field] for field in ("digest", "startSample", "samples")):
                fail(409, "相同序號的音訊內容不同")
            if existing:
                return True
            if value["state"] != "recording":
                fail(409, "錄音已停止")
            for other_index, chunk in {**value["chunks"], **value.get("pendingChunks", {})}.items():
                if other_index != str(index) and start < chunk["startSample"] + chunk["samples"] and start + entry["samples"] > chunk["startSample"]:
                    fail(409, "音訊 sample 範圍重疊")
            return False

        def reserve(current):
            value = current or {"sampleRate": rate, "chunks": {}, "contiguousChunks": 0, "persistedSamples": 0, "state": "recording"}
            if validate(value):
                return UNCHANGED
            # Commit the intent BEFORE writing a blob: a crash or failed store
            # leaves a tracked range, never an invisible orphan.
            value.setdefault("pendingChunks", {})[str(index)] = entry
            value["updatedAt"] = now()
            return value

        value = await self.storage.update(user_id, key, reserve)
        if not validate(value):
            # Immutable attempt objects let slow storage finish outside the SQL
            # pool. A later duplicate or cleanup can fence this attempt safely.
            published = False
            try:
                await self.storage.put_blob(user_id, blob_key, audio)
                async with self.storage.transaction(f"record:{user_id}:{key}") as tx:
                    value = await tx.get(user_id, key)
                    if not value:
                        fail(409, "錄音狀態已改變")
                    if not validate(value):
                        if value.get("pendingChunks", {}).get(str(index), {}).get("blobKey") != blob_key:
                            fail(409, "錄音分塊已由另一請求接手，請重試")
                        value["chunks"][str(index)] = entry
                        value.setdefault("pendingChunks", {}).pop(str(index), None)
                        value["maximumEndSample"] = max(value.get("maximumEndSample", 0), start + entry["samples"])
                        while str(value["contiguousChunks"]) in value["chunks"]:
                            chunk = value["chunks"][str(value["contiguousChunks"])]
                            if chunk["startSample"] != value["persistedSamples"]:
                                break
                            value["persistedSamples"] += chunk["samples"]
                            value["contiguousChunks"] += 1
                        value["updatedAt"] = now()
                        await tx.put(user_id, key, value)
                published = value["chunks"][str(index)]["blobKey"] == blob_key
            finally:
                if not published:
                    with anyio.CancelScope(shield=True):
                        try:
                            removable = False
                            def inspect(current):
                                nonlocal removable
                                removable = not current or not any(item.get("blobKey") == blob_key for item in [*current.get("chunks", {}).values(), *current.get("pendingChunks", {}).values()])
                                return UNCHANGED
                            # Acquire the publication lock: an ambiguous COMMIT
                            # must resolve before deciding this object is unused.
                            await self.storage.update(user_id, key, inspect)
                            if removable:
                                await self.storage.remove_blob(user_id, blob_key)
                        except Exception:
                            pass  # Capture-prefix cleanup retries uncertain objects.
        return {
            "durable": True,
            "contiguousChunks": value["contiguousChunks"],
            "persistedSamples": value["persistedSamples"],
        }

    async def finish(self, user_id, recording_id, count, samples):
        if not integer(count, 1, 100000) or not integer(samples, 1, (2 * 1024**3 - 44) // 2):
            fail(400, "無效的停止進度")

        def begin(value):
            if (
                not value
                or value.get("state") not in {"recording", "finishing", "completed"}
                or value["contiguousChunks"] != count
                or value["persistedSamples"] != samples
                or len(value["chunks"]) != count
            ):
                fail(409, "音訊尚未完整保存")
            return UNCHANGED if value["state"] == "completed" else {**value, "state": "finishing"}

        key = self.key(recording_id)
        token = uuid.uuid4().hex
        assembly_key = f"recording-audio/{recording_id}/{token}"
        lock = f"record:{user_id}:{key}"
        async with self.storage.transaction(lock) as tx:
            current = await tx.get(user_id, key)
            manifest = begin(current)
            if manifest is UNCHANGED:
                manifest = current
            else:
                if current.get("state") == "finishing" and current.get("finishUntil", 0) > time.time():
                    fail(503, "錄音正在完成中，請稍後重試")
                manifest.update(finishToken=token, finishUntil=time.time() + 180)
                manifest["assemblyKeys"] = list(dict.fromkeys([*manifest.get("assemblyKeys", []), assembly_key]))
                await tx.put(user_id, key, manifest)
        if manifest["state"] != "completed":
            committed, lost = False, False

            async def renew():
                nonlocal lost
                try:
                    while True:
                        await asyncio.sleep(15)
                        def extend(value):
                            nonlocal lost
                            if not value or value.get("state") != "finishing" or value.get("finishToken") != token:
                                lost = True
                                return UNCHANGED
                            return {**value, "finishUntil": time.time() + 180}
                        await self.storage.update(user_id, key, extend)
                        if lost:
                            return
                except asyncio.CancelledError:
                    raise
                except Exception:
                    lost = True

            async def stream():
                yield wav_header(samples * 2, manifest["sampleRate"])
                for index in range(count):
                    if lost:
                        fail(503, "錄音完成協調已失效，請重試")
                    entry = manifest["chunks"][str(index)]
                    audio = await self.storage.get_blob(user_id, entry["blobKey"])
                    if audio is None or len(audio) != entry["samples"] * 2 or hashlib.sha256(audio).hexdigest() != entry["digest"]:
                        fail(503, "持久化音訊驗證失敗")
                    yield audio

            heartbeat = asyncio.create_task(renew())
            try:
                # A unique object per attempt fences late workers. Object-store
                # I/O never keeps a SQL transaction open, including final publish.
                await self.storage.put_stream(user_id, assembly_key, stream())
                async with self.storage.transaction(lock) as tx:
                    current = await tx.get(user_id, key)
                    if lost or not current or current.get("state") != "finishing" or current.get("finishToken") != token or current.get("finishUntil", 0) <= time.time():
                        fail(409, "錄音完成狀態已改變，保留分段以供重試")
                    current.update(state="completed", audioKey=recording_id, assemblyKey=assembly_key, updatedAt=now())
                    current.pop("finishToken", None)
                    current.pop("finishUntil", None)
                    await tx.put(user_id, key, current)
                committed = True
            finally:
                heartbeat.cancel()
                await asyncio.gather(heartbeat, return_exceptions=True)
                if not committed:
                    with anyio.CancelScope(shield=True):
                        # Failed attempts remain recorded in assemblyKeys if
                        # cleanup itself is unavailable; do not drop the intent.
                        try:
                            removable = False
                            def release(value):
                                nonlocal removable
                                removable = not value or value.get("assemblyKey") != assembly_key
                                if value and value.get("state") == "finishing" and value.get("finishToken") == token:
                                    return {**value, "state": "recording", "finishUntil": 0}
                                return UNCHANGED
                            await self.storage.update(user_id, key, release)
                            if removable:
                                await self.storage.remove_blob(user_id, assembly_key)
                        except Exception:
                            pass
        return {
            "durable": True,
            "audioKey": recording_id,
            "persistedSamples": samples,
            "contiguousChunks": count,
        }

    async def remove(self, user_id, recording_id, proof=None):
        key = self.key(recording_id)
        if proof is not None and not isinstance(proof, dict):
            fail(400, "無效的錄音清理證明")
        # Session CAS uses this same lock. Acquire recording second everywhere
        # a cleanup needs both; append/finish only acquire recording.
        async with self.storage.transaction(f"record:{user_id}:sessions") as tx:
            if hasattr(tx, "connection"):
                await tx.connection.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", (f"record:{user_id}:{key}",))
            value = await tx.get(user_id, key)
            if value and value.get("state") == "deleted":
                return
            if value and value.get("state") == "finishing" and value.get("finishUntil", 0) > time.time():
                fail(409, "錄音仍在完成中，保留備份")
            snapshot = await tx.get(user_id, "sessions")
            sessions = snapshot.get("sessions", []) if isinstance(snapshot, dict) else snapshot or []
            if recording_id in audio_keys(sessions):
                fail(409, "錄音仍由正式紀錄使用")
            if proof is not None:
                session_id, audio_id = safe(proof.get("sessionId")), safe(proof.get("audioKey"))
                row = next((row for row in sessions if row.get("id") == session_id), None)
                if not row or audio_id == recording_id or row.get("audioKey") != audio_id or row.get("audioUnavailable") is not False or row.get("processingToken") != proof.get("processingToken") or row.get("processingState") in {"running", "queued"}:
                    fail(409, "替代錄音尚未確認保存")
                stream = await self.storage.blob_stream(user_id, await audio_blob_key(tx, user_id, audio_id))
                if stream is None:
                    fail(409, "替代音訊不存在，保留錄音備份")
                try:
                    if not await anext(stream, b""):
                        fail(409, "替代音訊為空，保留錄音備份")
                finally:
                    await stream.aclose()
            elif value and value.get("state") not in {"completed", "deleting"}:
                fail(409, "只能清理已完成的錄音備份")
            elif not value:
                return
            await tx.put(user_id, key, {**(value or {"chunks": {}}), "state": "deleting", "updatedAt": now()})
        # The durable deleting fence survives process failure. A failed delete
        # is retried against the same manifest; late uploads cannot resurrect it.
        value = await self.storage.get(user_id, key)
        if not value or value.get("state") == "deleted":
            return
        if value.get("state") != "deleting":
            fail(409, "錄音清理狀態已改變")
        # No SQL transaction is held while listing/deleting objects. The durable
        # fence rejects both late chunks and new session references.
        blobs = set(value.get("assemblyKeys", []))
        for prefix in (f"chunks/{recording_id}/", f"recording-audio/{recording_id}/"):
            blobs.update(await self.storage.list_blobs(user_id, prefix))
        blobs.add("audio/" + recording_id)  # Legacy captures remain cleanable.
        for blob_key in sorted(blobs, key=lambda name: (not name.startswith("chunks/"), name)):
            await self.storage.remove_blob(user_id, blob_key)
        async with self.storage.transaction(f"record:{user_id}:{key}") as tx:
            current = await tx.get(user_id, key)
            if current and current.get("state") == "deleting":
                await tx.put(user_id, key, {"state": "deleted", "updatedAt": now()})


async def audio_blob_key(reader, user_id, audio_id):
    # Capture IDs remain stable at the API boundary; finalized attempts are
    # immutable physical objects selected only by a committed manifest.
    value = await reader.get(user_id, "recording-" + audio_id) if len(audio_id) <= 120 else None
    if value and value.get("state") in {"deleting", "deleted"}:
        fail(404, "找不到音檔")
    return value["assemblyKey"] if value and value.get("state") == "completed" and value.get("assemblyKey") else "audio/" + audio_id



def audio_keys(sessions):
    return {
        key
        for session in sessions
        for key in [
            session.get("audioKey"),
            *(version.get("audioKey") for version in session.get("audioVersions") or []),
        ]
        if isinstance(key, str) and key
    }


async def session_snapshot(storage, user_id):
    value = await storage.get(user_id, "sessions")
    if value is None:
        return {"sessions": [], "version": 0}

    def repair(current):
        if current is None:
            return UNCHANGED
        sessions = (
            current
            if isinstance(current, list)
            else current.get("sessions")
            if isinstance(current, dict)
            else None
        )
        if not isinstance(sessions, list):
            fail(503, "紀錄儲存格式無法辨識，請先還原備份；未覆寫既有資料")
        if (
            isinstance(current, dict)
            and integer(current.get("version"))
            and (current["version"] > 0 or not sessions)
        ):
            return UNCHANGED
        import secrets

        return {"sessions": sessions, "version": 2**48 + secrets.randbelow(2**48 - 1)}

    if (
        isinstance(value, dict)
        and isinstance(value.get("sessions"), list)
        and integer(value.get("version"))
        and (value["version"] > 0 or not value["sessions"])
    ):
        return value
    return await storage.update(user_id, "sessions", repair)


class Compensation:
    def __init__(self, storage, settings):
        self.storage = storage
        self.grace = int(settings.env.get("S2T_STORAGE_COMPENSATION_GRACE_MS", 30000))

    async def protect(self, user_id, audio_id):
        import uuid

        token = str(uuid.uuid4())

        def refresh(entries):
            entries = entries or []
            current = next(
                (entry for entry in entries if entry["id"] == audio_id),
                {"id": audio_id, "createdAt": now()},
            )
            leases = [
                lease
                for lease in current.get("uploadLeases", [])
                if lease["token"] != token and lease["until"] > time.time() * 1000
            ]
            current.update(
                eligibleAfter=time.time() * 1000 + self.grace,
                uploadLeases=leases + [{"token": token, "until": time.time() * 1000 + 120000}],
            )
            return [entry for entry in entries if entry["id"] != audio_id] + [current]

        await self.storage.update(user_id, "audio-compensations", refresh)
        return token, refresh

    async def release(self, user_id, audio_id, token):
        def update(entries):
            return [
                {
                    **entry,
                    "eligibleAfter": time.time() * 1000 + self.grace,
                    "uploadLeases": [
                        lease for lease in entry.get("uploadLeases", []) if lease["token"] != token
                    ],
                }
                if entry["id"] == audio_id
                else entry
                for entry in (entries or [])
            ]

        await self.storage.update(user_id, "audio-compensations", update)

    async def reconcile(self, user_id, sessions):
        # Serialize reference checks with session CAS and lease refresh. A
        # caller's snapshot may already be stale when cleanup acquires locks.
        async with self.storage.transaction(f"record:{user_id}:sessions") as tx:
            if hasattr(tx, "connection"):
                await tx.connection.execute(
                    "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))",
                    (f"record:{user_id}:audio-compensations",),
                )
            snapshot = await tx.get(user_id, "sessions")
            referenced = audio_keys(
                snapshot["sessions"]
                if isinstance(snapshot, dict) and isinstance(snapshot.get("sessions"), list)
                else sessions
            )
            for entry in await tx.list(user_id, "recording-"):
                if (entry.get("value") or {}).get("state") in {
                    "recording",
                    "finishing",
                    "completed",
                }:
                    referenced.add(entry["key"][len("recording-") :])
            entries = await tx.get(user_id, "audio-compensations") or []
            keep = []
            for entry in entries:
                if entry["id"] in referenced:
                    continue
                if entry.get("eligibleAfter", 0) > time.time() * 1000 or any(
                    lease["until"] > time.time() * 1000 for lease in entry.get("uploadLeases", [])
                ):
                    keep.append(entry)
                    continue
                await self.storage.remove_blob(user_id, "audio/" + entry["id"])
            await tx.put(user_id, "audio-compensations", keep)
