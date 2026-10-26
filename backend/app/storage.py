"""Durable adapters. PostgreSQL transactions coordinate all Python replicas.

The local JSON layout and S3 object keys match existing Web installations.
Local mode is explicitly single-host; multi-Pod startup rejects local stores.
"""

import asyncio
import copy
import fcntl
import json
import os
import secrets
import re
import functools
import time
from contextlib import asynccontextmanager
from pathlib import Path

import anyio
import orjson

from .core import fail, integer, now, safe

UNCHANGED = object()


async def file_lock(handle, mode):
    deadline = time.monotonic() + 15
    while True:
        try:
            fcntl.flock(handle, mode | fcntl.LOCK_NB)
            return
        except BlockingIOError:
            if time.monotonic() >= deadline:
                fail(503, "本機 storage 正由另一個程序使用，請稍後重試")
            await asyncio.sleep(0.02)


def measured(operation):
    def decorate(function):
        @functools.wraps(function)
        async def call(self, *args, **kwargs):
            started, outcome = time.monotonic(), "success"
            try:
                return await function(self, *args, **kwargs)
            except BaseException:
                outcome = "error"
                raise
            finally:
                observer = getattr(self, "observe", None)
                if observer:
                    observer(operation, outcome, time.monotonic() - started)

        return call

    return decorate


class LocalTransaction:
    def __init__(self, records):
        self.records = records
        self.changed = False

    async def get(self, scope, key):
        return copy.deepcopy(self.records.get(f"{safe(scope)}:{safe(key)}", {}).get("value"))

    async def put(self, scope, key, value):
        if re.fullmatch(r"[0-9a-f-]{36}", scope):
            account = next(
                (
                    entry["value"]
                    for name, entry in self.records.items()
                    if name.startswith("auth:account-")
                    and entry.get("value", {}).get("id") == scope
                ),
                None,
            )
            if not account or account.get("deletionState") == "deleting":
                fail(409, "帳號已不存在或正在刪除中")
        self.records[f"{safe(scope)}:{safe(key)}"] = {
            "value": copy.deepcopy(value),
            "updatedAt": now(),
        }
        self.changed = True

    async def remove(self, scope, key):
        self.records.pop(f"{safe(scope)}:{safe(key)}", None)
        self.changed = True

    async def list(self, scope, prefix=""):
        root = safe(scope) + ":"
        return [
            {"key": key[len(root) :], **copy.deepcopy(value)}
            for key, value in self.records.items()
            if key.startswith(root + prefix)
        ]


class PostgresTransaction:
    def __init__(self, connection):
        self.connection = connection

    async def get(self, scope, key):
        row = await (
            await self.connection.execute(
                "SELECT value FROM s2t_config_records WHERE scope=%s AND record_key=%s",
                (safe(scope), safe(key)),
            )
        ).fetchone()
        return row[0] if row else None

    async def put(self, scope, key, value):
        from psycopg.types.json import Jsonb

        if re.fullmatch(r"[0-9a-f-]{36}", scope):
            # Preserve the account-deletion row lock in the same atomic command,
            # avoiding a separate SELECT round trip on every durable checkpoint.
            cursor = await self.connection.execute(
                "WITH owner AS MATERIALIZED (SELECT id FROM s2t_users WHERE id=%s AND deletion_state='active' FOR SHARE) "
                "INSERT INTO s2t_config_records(scope,record_key,value) SELECT id,%s,%s FROM owner "
                "ON CONFLICT(scope,record_key) DO UPDATE SET value=excluded.value,updated_at=now()",
                (safe(scope), safe(key), Jsonb(value)),
            )
            if not cursor.rowcount:
                fail(409, "帳號已不存在或正在刪除中")
        else:
            await self.connection.execute(
                "INSERT INTO s2t_config_records(scope,record_key,value) VALUES(%s,%s,%s) ON CONFLICT(scope,record_key) DO UPDATE SET value=excluded.value,updated_at=now()",
                (safe(scope), safe(key), Jsonb(value)),
            )

    async def remove(self, scope, key):
        await self.connection.execute(
            "DELETE FROM s2t_config_records WHERE scope=%s AND record_key=%s",
            (safe(scope), safe(key)),
        )

    async def list(self, scope, prefix=""):
        rows = await (
            await self.connection.execute(
                "SELECT record_key,value,updated_at FROM s2t_config_records WHERE scope=%s AND starts_with(record_key,%s) ORDER BY record_key",
                (safe(scope), prefix),
            )
        ).fetchall()
        return [{"key": row[0], "value": row[1], "updatedAt": row[2].isoformat()} for row in rows]


class Storage:
    def __init__(self, settings):
        self.settings = settings
        self.file = settings.root / "config.json"
        self.pool = None
        self.health_pool = None
        self.fence_pool = None
        self.s3_context = self.s3 = None
        self.local_lock = asyncio.Lock()
        self.blob_slots = asyncio.Semaphore(8)
        self.fence_slots = asyncio.Semaphore(
            int(settings.env.get("S2T_POSTGRES_FENCE_SESSIONS", 4))
        )
        self.mode = {
            "config": "postgres" if settings.pg else "local",
            "blob": "minio" if settings.s3 else "local",
            "vector": "milvus" if settings.milvus else "local",
        }

    async def open(self):
        self.settings.root.mkdir(parents=True, exist_ok=True)
        if self.settings.pg:
            from psycopg.conninfo import make_conninfo
            from psycopg_pool import AsyncConnectionPool
            from psycopg.types.json import set_json_dumps, set_json_loads
            from .postgres import BoundedConnection

            async def configure(connection):
                connection.wire_timeout = (
                    int(self.settings.env.get("S2T_POSTGRES_QUERY_TIMEOUT_MS", 6000)) / 1000
                )
                set_json_loads(orjson.loads, connection)
                set_json_dumps(lambda value: orjson.dumps(value).decode(), connection)

            config = self.settings.pg
            conninfo = make_conninfo(
                host=config["HOST"],
                port=config["PORT"],
                dbname=config["DB_NAME"],
                user=config["USER"],
                password=config["PASSWORD"],
                connect_timeout=max(
                    1,
                    (int(self.settings.env.get("S2T_POSTGRES_CONNECT_TIMEOUT_MS", 3000)) + 999)
                    // 1000,
                ),
                options=f"-c statement_timeout={int(self.settings.env.get('S2T_POSTGRES_STATEMENT_TIMEOUT_MS', 5000))} -c lock_timeout={int(self.settings.env.get('S2T_POSTGRES_LOCK_TIMEOUT_MS', 3000))} -c idle_in_transaction_session_timeout={int(self.settings.env.get('S2T_POSTGRES_IDLE_TRANSACTION_TIMEOUT_MS', 10000))}",
            )
            self.pool = AsyncConnectionPool(
                conninfo,
                min_size=1,
                max_size=int(
                    self.settings.env.get(
                        "S2T_POSTGRES_POOL_MAX",
                        self.settings.env.get("S2T_POSTGRES_MAX_CONNECTIONS", 16),
                    )
                ),
                timeout=5,
                open=False,
                configure=configure,
                connection_class=BoundedConnection,
                # Standalone reads need no BEGIN/COMMIT round trips. Mutations
                # that need atomicity still enter transaction() explicitly.
                kwargs={"autocommit": True},
            )
            await self.pool.open(wait=True)
            # Reserve one connection so request-pool congestion does not
            # incorrectly remove every replica from the Service.
            self.health_pool = AsyncConnectionPool(
                conninfo, min_size=1, max_size=1, timeout=2, open=False,
                configure=configure, connection_class=BoundedConnection,
                kwargs={"autocommit": True},
            )
            await self.health_pool.open(wait=True)
            self.fence_pool = AsyncConnectionPool(
                conninfo,
                min_size=0,
                max_size=int(self.settings.env.get("S2T_POSTGRES_FENCE_SESSIONS", 4)) + 1,
                timeout=10,
                kwargs={"autocommit": True},
                open=False,
                connection_class=BoundedConnection,
                configure=configure,
            )
            await self.fence_pool.open()
            async with self.pool.connection() as connection:
                async with connection.transaction():
                    await connection.execute(
                        "SELECT pg_advisory_xact_lock(hashtext('s2t_schema_migrations'))"
                    )
                    if self.settings.env.get("S2T_STORAGE_MIGRATIONS") == "verify":
                        row = await (
                            await connection.execute(
                                "SELECT version FROM s2t_schema_migrations WHERE version='004-request-expiry-index'"
                            )
                        ).fetchone()
                        if not row:
                            raise RuntimeError("Storage schema migration required")
                    else:
                        await connection.execute(
                            (Path(__file__).with_name("schema.sql")).read_text()
                        )
        if self.settings.s3:
            import aioboto3
            from botocore.config import Config

            config = self.settings.s3
            endpoint = config["ENDPOINT"]
            if "://" not in endpoint:
                endpoint = "http://" + endpoint
            self.s3_context = aioboto3.Session().client(
                "s3",
                endpoint_url=endpoint,
                aws_access_key_id=config["ACCESS_KEY"],
                aws_secret_access_key=config["SECRET_KEY"],
                region_name="us-east-1",
                config=Config(
                    max_pool_connections=32,
                    connect_timeout=5,
                    read_timeout=120,
                    retries={"max_attempts": 2},
                    s3={"addressing_style": "path"},
                ),
            )
            self.s3 = await self.s3_context.__aenter__()
            try:
                await self.s3.head_bucket(Bucket=config["BUCKET"])
            except Exception as error:
                if str(getattr(error, "response", {}).get("Error", {}).get("Code")) not in {
                    "404",
                    "NoSuchBucket",
                }:
                    raise
                await self.s3.create_bucket(Bucket=config["BUCKET"])

    async def close(self):
        if self.s3_context:
            await self.s3_context.__aexit__(None, None, None)
        if self.pool:
            await self.pool.close()
        if self.fence_pool:
            await self.fence_pool.close()
        if self.health_pool:
            await self.health_pool.close()

    @asynccontextmanager
    async def account_guard(self, user_id, exclusive=False):
        acquired = False
        if self.fence_pool and not exclusive:
            try:
                await asyncio.wait_for(self.fence_slots.acquire(), 10)
                acquired = True
            except asyncio.TimeoutError:
                fail(503, "帳號資料操作忙碌，請稍後重試")
        try:
            async with self._account_guard(user_id, exclusive):
                yield
        finally:
            if acquired:
                self.fence_slots.release()

    @asynccontextmanager
    async def _account_guard(self, user_id, exclusive=False):
        safe(user_id)
        if self.fence_pool:
            async with self.fence_pool.connection() as connection:
                name = "pg_advisory_lock" if exclusive else "pg_advisory_lock_shared"
                unlock = "pg_advisory_unlock" if exclusive else "pg_advisory_unlock_shared"
                await connection.execute(
                    f"SELECT {name}(hashtextextended(%s,0))", ("python-account:" + user_id,)
                )
                try:
                    if not exclusive:
                        row = await (
                            await connection.execute(
                                "SELECT deletion_state FROM s2t_users WHERE id=%s", (user_id,)
                            )
                        ).fetchone()
                        if not row or row[0] != "active":
                            fail(409, "帳號已不存在或正在刪除中")
                    yield
                finally:
                    with anyio.CancelScope(shield=True):
                        await connection.execute(
                            f"SELECT {unlock}(hashtextextended(%s,0))",
                            ("python-account:" + user_id,),
                        )
        else:
            directory = self.settings.root / "account-locks"
            directory.mkdir(exist_ok=True)
            handle = (directory / user_id).open("a+")
            try:
                await file_lock(handle, fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH)
                if not exclusive:
                    accounts = await self.list("auth", "account-")
                    if not any(
                        item["value"].get("id") == user_id
                        and item["value"].get("deletionState") != "deleting"
                        for item in accounts
                    ):
                        fail(409, "帳號已不存在或正在刪除中")
                yield
            finally:
                handle.close()

    async def health(self):
        if self.pool:
            async with self.health_pool.connection(timeout=2) as connection:
                await connection.execute("SELECT 1")
        else:
            async with self.transaction("health"):
                pass
        if self.s3:
            await self.s3.head_bucket(Bucket=self.settings.s3["BUCKET"])

    @asynccontextmanager
    async def local_admission(self):
        try:
            await asyncio.wait_for(self.local_lock.acquire(), 15)
        except asyncio.TimeoutError:
            fail(503, "本機 storage 忙碌，請稍後重試")
        try:
            yield
        finally:
            self.local_lock.release()

    @asynccontextmanager
    async def transaction(self, lock="global"):
        if self.pool:
            async with self.pool.connection() as connection:
                async with connection.transaction():
                    await connection.execute(
                        "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", (lock,)
                    )
                    yield PostgresTransaction(connection)
            return
        async with self.local_admission():
            handle = await anyio.to_thread.run_sync(
                lambda: (self.settings.root / "config.python.lock").open("a+")
            )
            try:
                await file_lock(handle, fcntl.LOCK_EX)

                def load():
                    if not self.file.exists():
                        return {}
                    records = json.loads(self.file.read_text())
                    if not isinstance(records, dict):
                        raise RuntimeError("設定檔格式損毀，請還原備份")
                    return records

                tx = LocalTransaction(await anyio.to_thread.run_sync(load))
                yield tx
                if tx.changed:

                    def save():
                        temporary = self.file.with_suffix(f".{secrets.token_hex(8)}.tmp")
                        try:
                            with temporary.open("x", encoding="utf-8") as output:
                                os.chmod(temporary, 0o600)
                                json.dump(tx.records, output, ensure_ascii=False, allow_nan=False)
                                output.flush()
                                os.fsync(output.fileno())
                            os.replace(temporary, self.file)
                        finally:
                            temporary.unlink(missing_ok=True)

                    await anyio.to_thread.run_sync(save)
            finally:
                handle.close()

    @measured("config.get")
    async def get(self, scope, key):
        # PostgreSQL reads do not acquire mutation locks or copy full snapshots.
        if self.pool:
            async with self.pool.connection() as connection:
                return await PostgresTransaction(connection).get(scope, key)
        async with self.transaction() as tx:
            return await tx.get(scope, key)

    async def list(self, scope, prefix=""):
        if self.pool:
            async with self.pool.connection() as connection:
                return await PostgresTransaction(connection).list(scope, prefix)
        async with self.transaction() as tx:
            return await tx.list(scope, prefix)

    @measured("config.put")
    async def put(self, scope, key, value):
        async with self.transaction(f"record:{scope}:{key}") as tx:
            await tx.put(scope, key, value)

    async def remove(self, scope, key):
        async with self.transaction(f"record:{scope}:{key}") as tx:
            await tx.remove(scope, key)

    @measured("config.update")
    async def update(self, scope, key, transform):
        async with self.transaction(f"record:{scope}:{key}") as tx:
            current = await tx.get(scope, key)
            result = transform(copy.deepcopy(current))
            if result is not UNCHANGED:
                await tx.put(scope, key, result)
            return current if result is UNCHANGED else result

    @measured("config.cas")
    async def cas(self, scope, key, version, value):
        if not integer(version):
            fail(400, "無效的版本")
        async with self.transaction(f"record:{scope}:{key}") as tx:
            current = await tx.get(scope, key)
            actual = current.get("version", 0) if isinstance(current, dict) else 0
            if actual != version:
                return False
            await tx.put(scope, key, value)
            return True

    def blob_key(self, scope, key):
        return safe(scope) + "/" + "/".join(safe(part) for part in key.split("/"))

    def blob_path(self, scope, key):
        root = (self.settings.root / "blobs").resolve()
        target = (root / self.blob_key(scope, key)).resolve()
        if root not in target.parents:
            fail(400, "無效的檔案路徑")
        return target

    async def put_blob(self, scope, key, data):
        async def stream():
            yield data

        await self.put_stream(scope, key, stream())

    @measured("blob.putStream")
    async def put_stream(self, scope, key, stream):
        async with self.blob_slots:
            return await self._put_stream(scope, key, stream)

    async def _put_stream(self, scope, key, stream):
        if not self.s3:
            target = self.blob_path(scope, key)
            await anyio.to_thread.run_sync(lambda: target.parent.mkdir(parents=True, exist_ok=True))
            temporary = target.with_name(f".{target.name}.{secrets.token_hex(8)}.tmp")
            try:
                async with await anyio.open_file(temporary, "xb") as output:
                    async for chunk in stream:
                        await output.write(chunk)
                    await output.flush()
                    await anyio.to_thread.run_sync(os.fsync, output.wrapped.fileno())
                await anyio.to_thread.run_sync(os.replace, temporary, target)
            finally:
                temporary.unlink(missing_ok=True)
            return
        bucket, object_key = self.settings.s3["BUCKET"], self.blob_key(scope, key)
        upload_id = None
        buffer = bytearray()
        parts = []
        try:
            async for chunk in stream:
                buffer.extend(chunk)
                while len(buffer) >= 8 * 1024**2:
                    if upload_id is None:
                        upload_id = (
                            await self.s3.create_multipart_upload(Bucket=bucket, Key=object_key)
                        )["UploadId"]
                    data = bytes(buffer[: 8 * 1024**2])
                    del buffer[: 8 * 1024**2]
                    number = len(parts) + 1
                    result = await self.s3.upload_part(
                        Bucket=bucket,
                        Key=object_key,
                        UploadId=upload_id,
                        PartNumber=number,
                        Body=data,
                    )
                    parts.append({"ETag": result["ETag"], "PartNumber": number})
            if upload_id is None:
                await self.s3.put_object(Bucket=bucket, Key=object_key, Body=bytes(buffer))
            else:
                if buffer:
                    number = len(parts) + 1
                    result = await self.s3.upload_part(
                        Bucket=bucket,
                        Key=object_key,
                        UploadId=upload_id,
                        PartNumber=number,
                        Body=bytes(buffer),
                    )
                    parts.append({"ETag": result["ETag"], "PartNumber": number})
                await self.s3.complete_multipart_upload(
                    Bucket=bucket,
                    Key=object_key,
                    UploadId=upload_id,
                    MultipartUpload={"Parts": parts},
                )
                upload_id = None
        finally:
            if upload_id:
                with anyio.CancelScope(shield=True):
                    await self.s3.abort_multipart_upload(
                        Bucket=bucket, Key=object_key, UploadId=upload_id
                    )

    async def blob_stream(self, scope, key):
        if self.s3:
            try:
                response = await self.s3.get_object(
                    Bucket=self.settings.s3["BUCKET"], Key=self.blob_key(scope, key)
                )
            except Exception as error:
                if str(getattr(error, "response", {}).get("Error", {}).get("Code")) in {
                    "404",
                    "NoSuchKey",
                }:
                    return None
                raise

            async def remote():
                body = response["Body"]
                # aiobotocore's context manager returns the underlying aiohttp
                # response; its StreamingBody wrapper owns iter_chunks().
                async with body:
                    async for chunk in body.iter_chunks(256 * 1024):
                        yield chunk

            return remote()
        file = self.blob_path(scope, key)
        if not file.is_file():
            return None

        async def local():
            async with await anyio.open_file(file, "rb") as source:
                while chunk := await source.read(256 * 1024):
                    yield chunk

        return local()

    async def get_blob(self, scope, key):
        stream = await self.blob_stream(scope, key)
        if stream is None:
            return None
        result = bytearray()
        async for chunk in stream:
            result.extend(chunk)
        return bytes(result)

    async def remove_blob(self, scope, key):
        if self.s3:
            await self.s3.delete_object(
                Bucket=self.settings.s3["BUCKET"], Key=self.blob_key(scope, key)
            )
        else:
            await anyio.to_thread.run_sync(
                lambda: self.blob_path(scope, key).unlink(missing_ok=True)
            )

    async def copy_blob(self, scope, source, target):
        if self.s3:
            await self.s3.copy_object(
                Bucket=self.settings.s3["BUCKET"],
                Key=self.blob_key(scope, target),
                CopySource={
                    "Bucket": self.settings.s3["BUCKET"],
                    "Key": self.blob_key(scope, source),
                },
            )
        else:
            stream = await self.blob_stream(scope, source)
            if stream is None:
                fail(404, "找不到音訊")
            await self.put_stream(scope, target, stream)

    async def list_blobs(self, scope, prefix=""):
        safe(scope)
        if self.s3:
            result = []
            paginator = self.s3.get_paginator("list_objects_v2")
            async for page in paginator.paginate(
                Bucket=self.settings.s3["BUCKET"], Prefix=scope + "/" + prefix
            ):
                result.extend(item["Key"][len(scope) + 1 :] for item in page.get("Contents", []))
            return result

        def walk():
            root = self.settings.root / "blobs" / scope
            return [
                str(file.relative_to(root))
                for file in root.rglob("*")
                if file.is_file()
                and not file.name.startswith(".")
                and str(file.relative_to(root)).startswith(prefix)
            ]

        return await anyio.to_thread.run_sync(walk)

    async def prune_requests(self):
        import time

        if self.pool:
            async with self.pool.connection() as connection:
                for _ in range(4):
                    async with connection.transaction():
                        guard = await connection.execute(
                            "SELECT pg_try_advisory_xact_lock(hashtextextended('s2t:request-expiry-maintenance',0))"
                        )
                        if not (await guard.fetchone())[0]:
                            return
                        # Row locks keep each ctid stable within this statement.
                        # Avoid a second lookup of every long composite key,
                        # and let only one worker perform each cleanup batch.
                        cursor = await connection.execute(
                            "WITH expired AS (SELECT ctid FROM s2t_config_records WHERE record_key ~ '^request-[a-f0-9]{64}$' AND (value->>'expiresAt')::numeric < %s AND coalesce((value->>'leaseUntil')::numeric,0) <= %s ORDER BY (value->>'expiresAt')::numeric LIMIT 1000 FOR UPDATE SKIP LOCKED) DELETE FROM s2t_config_records r USING expired e WHERE r.ctid=e.ctid",
                            (time.time() * 1000, time.time() * 1000),
                        )
                    if cursor.rowcount < 1000:
                        break
                    await asyncio.sleep(0)
        else:
            async with self.transaction("prune") as tx:
                for key, entry in list(tx.records.items()):
                    if (
                        re.fullmatch(r"[^:]+:request-[a-f0-9]{64}", key)
                        and entry.get("value", {}).get("expiresAt", float("inf"))
                        < time.time() * 1000
                        and entry.get("value", {}).get("leaseUntil", 0) <= time.time() * 1000
                    ):
                        del tx.records[key]
                        tx.changed = True
