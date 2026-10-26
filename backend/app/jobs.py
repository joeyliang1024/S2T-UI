"""Durable diarization jobs with renewable leases and atomic fenced commits."""

import asyncio
import copy
import tempfile
import time
import uuid
from pathlib import Path

import anyio

from .core import fail, now, safe
from .recordings import session_snapshot, audio_blob_key


def matches(session, job):
    if (
        session.get("id") != job["sessionId"]
        or job.get("payload", {}).get("processingToken")
        and session.get("processingToken") != job["payload"]["processingToken"]
    ):
        return False
    active = session.get("activeAudioVersionId")
    return (
        any(
            item.get("id") == active and item.get("audioKey") == job["audioKey"]
            for item in session.get("audioVersions", [])
        )
        if active
        else session.get("audioKey") == job["audioKey"]
    )


def finalize(session, turns):
    result = copy.deepcopy(session)
    for segment in result.get("segments", []):
        if segment.get("status") != "final" or segment.get("speakerManuallyEdited"):
            continue
        overlaps = [
            (
                max(
                    0,
                    min(segment["endMs"], turn["end"] * 1000)
                    - max(segment["startMs"], turn["start"] * 1000),
                ),
                turn,
            )
            for turn in turns
        ]
        if not overlaps:
            continue
        amount, winner = max(overlaps, key=lambda item: item[0])
        if amount / max(1, segment["endMs"] - segment["startMs"]) >= 0.35:
            segment.update(speaker=winner["speaker"], revision=segment.get("revision", 0) + 1)
            if "Department" in winner:
                segment["Department"] = winner["Department"]

    def timestamp(ms):
        return f"{int(ms // 60000):02}:{int(ms // 1000 % 60):02}"

    result["transcript"] = "\n\n".join(
        f"[{timestamp(segment['startMs'])}] {segment.get('speaker') or '未標記講者'}：{segment['sourceText']}"
        + ("\n" + segment["translatedText"] if segment.get("translatedText") else "")
        for segment in result.get("segments", [])
        if segment.get("status") == "final"
    )
    for version in result.get("audioVersions", []):
        if version["id"] == result.get("activeAudioVersionId", "original"):
            version.update(
                segments=copy.deepcopy(result["segments"]), transcript=result["transcript"]
            )
    result["processingState"] = (
        "failed"
        if result.get("processingError") or result.get("processingFailures")
        else "completed"
    )
    result.pop("processingStage", None)
    return result


JOB_COLUMNS = "id,user_id,session_id,audio_key,payload,state,attempts,lease_generation,lease_owner,extract(epoch from lease_until)*1000,error,created_at,updated_at"


def job_row(row):
    if row is None:
        return None
    result = dict(
        zip(
            (
                "id",
                "userId",
                "sessionId",
                "audioKey",
                "payload",
                "state",
                "attempts",
                "leaseGeneration",
                "leaseOwner",
                "leaseUntil",
                "error",
                "createdAt",
                "updatedAt",
            ),
            row,
        )
    )
    for key in ("createdAt", "updatedAt"):
        result[key] = result[key].isoformat()
    if result["leaseUntil"] is not None:
        result["leaseUntil"] = float(result["leaseUntil"])
    return result


class Jobs:
    def __init__(self, storage, auth, models, voiceprints, admission):
        self.storage, self.auth, self.models, self.voiceprints, self.admission = (
            storage,
            auth,
            models,
            voiceprints,
            admission,
        )
        self.owner = "python-" + str(uuid.uuid4())
        self.stopping = asyncio.Event()

    async def enqueue(self, user, data):
        safe(data.get("audioKey"))
        if not isinstance(data.get("sessionId"), str) or not data["sessionId"]:
            fail(400, "sessionId 必須有效")
        payload = {
            "user": {key: user[key] for key in ("id", "NT", "Department")},
            "modelId": "managed-diarization",
            **{
                key: data[key]
                for key in ("processingToken", "localModel")
                if isinstance(data.get(key), str)
            },
        }
        snapshot = await session_snapshot(self.storage, user["id"])
        target = next(
            (item for item in snapshot["sessions"] if item["id"] == data["sessionId"]), {}
        )
        payload["audioSeconds"] = max(1, target.get("durationMs", 60000) / 1000)
        async with self.storage.transaction("jobs-claim") as tx:
            if hasattr(tx, "connection"):
                from psycopg.types.json import Jsonb

                row = await (
                    await tx.connection.execute(
                        f"SELECT {JOB_COLUMNS} FROM s2t_diarization_jobs WHERE user_id=%s AND session_id=%s AND audio_key=%s FOR UPDATE",
                        (user["id"], data["sessionId"], data["audioKey"]),
                    )
                ).fetchone()
                job = job_row(row)
                if (
                    job
                    and payload.get("processingToken")
                    and job["payload"].get("processingToken") == payload["processingToken"]
                ):
                    return job
                job_id = job["id"] if job else str(uuid.uuid4())
                row = await (
                    await tx.connection.execute(
                        f"INSERT INTO s2t_diarization_jobs(id,user_id,session_id,audio_key,payload) VALUES(%s,%s,%s,%s,%s) ON CONFLICT(user_id,session_id,audio_key) DO UPDATE SET payload=excluded.payload,state='queued',attempts=0,lease_owner=NULL,lease_until=NULL,error=NULL,updated_at=now() RETURNING {JOB_COLUMNS}",
                        (job_id, user["id"], data["sessionId"], data["audioKey"], Jsonb(payload)),
                    )
                ).fetchone()
                return job_row(row)
            value = await tx.get("diarization-system", "jobs") or {"jobs": []}
            job = next(
                (
                    item
                    for item in value["jobs"]
                    if item["userId"] == user["id"]
                    and item["sessionId"] == data["sessionId"]
                    and item["audioKey"] == data["audioKey"]
                ),
                None,
            )
            if (
                job
                and payload.get("processingToken")
                and job["payload"].get("processingToken") == payload["processingToken"]
            ):
                return job
            if not job:
                job = {
                    "id": str(uuid.uuid4()),
                    "userId": user["id"],
                    "sessionId": data["sessionId"],
                    "audioKey": data["audioKey"],
                    "createdAt": now(),
                    "leaseGeneration": 0,
                }
                value["jobs"].append(job)
            job.update(
                payload=payload,
                state="queued",
                attempts=0,
                leaseOwner=None,
                leaseUntil=None,
                error=None,
                updatedAt=now(),
            )
            await tx.put("diarization-system", "jobs", value)
            return job

    async def get(self, user_id, job_id):
        safe(job_id)
        if self.storage.pool:
            async with self.storage.pool.connection() as connection:
                return job_row(
                    await (
                        await connection.execute(
                            f"SELECT {JOB_COLUMNS} FROM s2t_diarization_jobs WHERE id=%s AND user_id=%s",
                            (job_id, user_id),
                        )
                    ).fetchone()
                )
        return next(
            (
                job
                for job in (await self.storage.get("diarization-system", "jobs") or {}).get(
                    "jobs", []
                )
                if job["id"] == job_id and job["userId"] == user_id
            ),
            None,
        )

    async def remove(self, user_id, job_id):
        safe(job_id)
        if self.storage.pool:
            async with self.storage.pool.connection() as connection:
                await connection.execute(
                    "DELETE FROM s2t_diarization_jobs WHERE id=%s AND user_id=%s", (job_id, user_id)
                )
        else:
            await self.storage.update(
                "diarization-system",
                "jobs",
                lambda value: {
                    "jobs": [
                        job
                        for job in (value or {}).get("jobs", [])
                        if not (job["id"] == job_id and job["userId"] == user_id)
                    ]
                },
            )

    async def claim(self):
        async with self.storage.transaction("jobs-claim") as tx:
            if hasattr(tx, "connection"):
                row = await (
                    await tx.connection.execute(
                        "SELECT j.id FROM s2t_diarization_jobs j JOIN s2t_users u ON u.id=j.user_id WHERE u.deletion_state='active' AND j.state IN ('queued','running') AND (j.lease_until IS NULL OR j.lease_until<now()) ORDER BY j.created_at FOR UPDATE OF j SKIP LOCKED LIMIT 1"
                    )
                ).fetchone()
                if not row:
                    return None
                return job_row(
                    await (
                        await tx.connection.execute(
                            f"UPDATE s2t_diarization_jobs SET state='running',attempts=attempts+1,lease_generation=lease_generation+1,lease_owner=%s,lease_until=now()+interval '5 minutes',updated_at=now() WHERE id=%s RETURNING {JOB_COLUMNS}",
                            (self.owner, row[0]),
                        )
                    ).fetchone()
                )
            value = await tx.get("diarization-system", "jobs") or {"jobs": []}
            accounts = await self.auth.accounts(tx)
            active = {user["id"] for user in accounts if user.get("deletionState") != "deleting"}
            job = next(
                (
                    job
                    for job in sorted(value["jobs"], key=lambda job: job["createdAt"])
                    if job["userId"] in active
                    and job["state"] in {"queued", "running"}
                    and (job.get("leaseUntil") or 0) < time.time() * 1000
                ),
                None,
            )
            if not job:
                return None
            job.update(
                state="running",
                attempts=job["attempts"] + 1,
                leaseGeneration=job.get("leaseGeneration", 0) + 1,
                leaseOwner=self.owner,
                leaseUntil=time.time() * 1000 + 300000,
                updatedAt=now(),
            )
            await tx.put("diarization-system", "jobs", value)
            return copy.deepcopy(job)

    def owned(self, value, job):
        return (
            value
            and value.get("state") == "running"
            and value.get("leaseOwner") == self.owner
            and value.get("leaseGeneration") == job["leaseGeneration"]
            and (value.get("leaseUntil") or 0) > time.time() * 1000
        )

    async def transition(self, job, error=None, renew=False):
        retry = error and error.startswith("retry:")
        async with self.storage.transaction("jobs-claim") as tx:
            if hasattr(tx, "connection"):
                if renew:
                    query = "UPDATE s2t_diarization_jobs SET lease_until=now()+interval '5 minutes',updated_at=now() WHERE id=%s AND lease_owner=%s AND lease_generation=%s AND state='running' AND lease_until>now() RETURNING id"
                    parameters = (job["id"], self.owner, job["leaseGeneration"])
                else:
                    query = "UPDATE s2t_diarization_jobs SET state=%s,error=%s,lease_owner=NULL,lease_until=CASE WHEN %s THEN now()+interval '10 seconds' ELSE NULL END,updated_at=now() WHERE id=%s AND lease_owner=%s AND lease_generation=%s AND state='running' AND lease_until>now() RETURNING id"
                    parameters = (
                        "queued" if retry else "failed" if error else "completed",
                        error[:1000] if error else None,
                        bool(retry),
                        job["id"],
                        self.owner,
                        job["leaseGeneration"],
                    )
                return bool(await (await tx.connection.execute(query, parameters)).fetchone())
            value = await tx.get("diarization-system", "jobs") or {"jobs": []}
            current = next((item for item in value["jobs"] if item["id"] == job["id"]), None)
            if not self.owned(current, job):
                return False
            if renew:
                current["leaseUntil"] = time.time() * 1000 + 300000
            else:
                current.update(
                    state="queued" if retry else "failed" if error else "completed",
                    error=error[:1000] if error else None,
                    leaseOwner=None,
                    leaseUntil=time.time() * 1000 + 10000 if retry else None,
                    updatedAt=now(),
                )
            await tx.put("diarization-system", "jobs", value)
            return True

    async def commit(self, job, version, snapshot):
        async with self.storage.transaction(f"record:{job['userId']}:sessions") as tx:
            if hasattr(tx, "connection"):
                user = await (
                    await tx.connection.execute(
                        "SELECT deletion_state FROM s2t_users WHERE id=%s FOR SHARE",
                        (job["userId"],),
                    )
                ).fetchone()
                row = await (
                    await tx.connection.execute(
                        f"SELECT {JOB_COLUMNS} FROM s2t_diarization_jobs WHERE id=%s FOR UPDATE",
                        (job["id"],),
                    )
                ).fetchone()
                current = job_row(row)
                if not user or user[0] != "active" or not self.owned(current, job):
                    return "lost"
            else:
                value = await tx.get("diarization-system", "jobs") or {"jobs": []}
                current = next((item for item in value["jobs"] if item["id"] == job["id"]), None)
                user = await self.auth.account(user_id=job["userId"], tx=tx)
                if (
                    not user
                    or user.get("deletionState") == "deleting"
                    or not self.owned(current, job)
                ):
                    return "lost"
            previous = await tx.get(job["userId"], "sessions")
            if not previous or previous.get("version") != version:
                return "conflict"
            await tx.put(job["userId"], "sessions", snapshot)
            if hasattr(tx, "connection"):
                await tx.connection.execute(
                    "UPDATE s2t_diarization_jobs SET state='completed',error=NULL,lease_owner=NULL,lease_until=NULL,updated_at=now() WHERE id=%s",
                    (job["id"],),
                )
            else:
                current.update(
                    state="completed", error=None, leaseOwner=None, leaseUntil=None, updatedAt=now()
                )
                await tx.put("diarization-system", "jobs", value)
            return "committed"

    async def execute(self, job):
        from fastapi import HTTPException

        try:
            # Deletion waits for in-flight account work, including its staged
            # audio. The dedicated advisory session never occupies query pool
            # capacity while native inference is running.
            async with self.storage.account_guard(job["userId"]):
                return await self._execute(job)
        except HTTPException as error:
            if error.status_code not in {401, 409}:
                await self.transition(job, "retry:帳號工作協調暫時不可用")

    async def _execute(self, job):
        lost = False

        async def heartbeat():
            nonlocal lost
            try:
                while True:
                    await asyncio.sleep(20)
                    if not await self.transition(job, renew=True):
                        lost = True
                        return
            except asyncio.CancelledError:
                raise
            except Exception:
                lost = True

        renewal = asyncio.create_task(heartbeat())
        try:
            if job["attempts"] > int(
                self.models.settings.env.get("S2T_DIARIZATION_JOB_MAX_ATTEMPTS", 10)
            ):
                raise ValueError("超過最大重試次數")
            snapshot = await session_snapshot(self.storage, job["userId"])
            target = next(
                (item for item in snapshot["sessions"] if item["id"] == job["sessionId"]), None
            )
            if not target:
                raise ValueError("retry:紀錄尚未同步完成")
            if (
                job["payload"].get("processingToken")
                and target.get("processingToken") == job["payload"]["processingToken"]
                and target.get("processingState") == "running"
                and target.get("processingStage") != "diarization"
            ):
                raise ValueError("retry:紀錄尚未完成尾段處理")
            if not matches(target, job):
                if (
                    job["payload"].get("processingToken")
                    and target.get("processingToken") != job["payload"]["processingToken"]
                ):
                    await self.transition(job)
                    return
                raise ValueError("retry:音訊版本尚未同步")
            stream = await self.storage.blob_stream(job["userId"], await audio_blob_key(self.storage, job["userId"], job["audioKey"]))
            if stream is None:
                raise ValueError("retry:音檔尚未保存")
            with tempfile.TemporaryDirectory(prefix="s2t-job-") as directory:
                filename = Path(directory) / "input.wav"
                async with await anyio.open_file(filename, "wb") as output:
                    async for chunk in stream:
                        await output.write(chunk)
                async with self.admission.capacity("background"):
                    result = await self.models.diarize(
                        filename, local_model=job["payload"].get("localModel", "")
                    )
                    turns = await self.voiceprints.label(
                        job["userId"], filename, result["exclusive_diarization"]
                    )
            if not turns:
                raise ValueError("講者分離未回傳有效區段")
            for _ in range(4):
                snapshot = await session_snapshot(self.storage, job["userId"])
                if not any(matches(item, job) for item in snapshot["sessions"]):
                    raise ValueError("retry:紀錄版本已改變")
                value = {
                    "version": snapshot["version"] + 1,
                    "sessions": [
                        finalize(item, turns) if matches(item, job) else item
                        for item in snapshot["sessions"]
                    ],
                }
                if lost:
                    return
                committed = await self.commit(job, snapshot["version"], value)
                if committed in {"lost", "committed"}:
                    return
            raise ValueError("retry:紀錄已更新，請重試")
        except asyncio.CancelledError:
            raise
        except Exception as error:
            if not lost:
                await self.transition(
                    job, str(error) if isinstance(error, ValueError) else "retry:背景服務暫時不可用"
                )
        finally:
            renewal.cancel()
            await asyncio.gather(renewal, return_exceptions=True)

    async def loop(self):
        import logging

        while not self.stopping.is_set():
            try:
                job = await self.claim()
                if job:
                    await self.execute(job)
                    continue
            except asyncio.CancelledError:
                raise
            except Exception:
                logging.getLogger("s2t").exception("background job polling failed")
            try:
                await asyncio.wait_for(self.stopping.wait(), 1)
            except asyncio.TimeoutError:
                pass
