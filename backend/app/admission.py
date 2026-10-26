"""Bounded local queues and shared Redis admission; fail closed on outages."""

import asyncio
import re
import time
import uuid
from contextlib import asynccontextmanager
from urllib.parse import urlsplit

from .core import digest, fail
from .storage import UNCHANGED


WINDOW = """
local t=redis.call('TIME'); local now=t[1]*1000+math.floor(t[2]/1000)
redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',now-tonumber(ARGV[1]))
if redis.call('ZSCORE',KEYS[1],ARGV[3]) then return 1 end
if redis.call('ZCARD',KEYS[1])>=tonumber(ARGV[2]) then return 0 end
redis.call('ZADD',KEYS[1],now,ARGV[3]); redis.call('PEXPIRE',KEYS[1],ARGV[1]); return 1
"""
CAPACITY = """
local t=redis.call('TIME'); local now=t[1]*1000+math.floor(t[2]/1000)
redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',now)
if redis.call('ZSCORE',KEYS[1],ARGV[2]) then return 1 end
if redis.call('ZCARD',KEYS[1])>=tonumber(ARGV[1]) then return 0 end
redis.call('ZADD',KEYS[1],now+120000,ARGV[2]); redis.call('PEXPIRE',KEYS[1],120000); return 1
"""
RENEW = """
local t=redis.call('TIME'); local now=t[1]*1000+math.floor(t[2]/1000)
local score=redis.call('ZSCORE',KEYS[1],ARGV[1]); if not score or tonumber(score)<=now then return 0 end
redis.call('ZADD',KEYS[1],now+120000,ARGV[1]); redis.call('PEXPIRE',KEYS[1],120000); return 1
"""


class Gate:
    def __init__(self, capacity, waiting=128, timeout=10):
        self.semaphore = asyncio.Semaphore(capacity)
        self.maximum_waiting, self.timeout, self.waiting = waiting, timeout, 0

    @asynccontextmanager
    async def enter(self):
        if self.waiting >= self.maximum_waiting:
            fail(503, "服務忙碌，請稍後重試")
        self.waiting += 1
        try:
            try:
                await asyncio.wait_for(self.semaphore.acquire(), self.timeout)
            except asyncio.TimeoutError:
                fail(503, "等待處理容量逾時")
        finally:
            self.waiting -= 1
        try:
            yield
        finally:
            self.semaphore.release()


class Admission:
    def __init__(self, settings):
        self.settings, self.redis, self.sentinel = settings, None, None
        self.windows = {}
        self.gates = {}
        self.shared_maximum = {}
        for role, default in [
            ("asr", 64),
            ("translation", 32),
            ("summary", 4),
            ("diarization", 2),
            ("background", 4),
            ("transcode", 1),
            ("sessions", 2),
        ]:
            variable = (
                "S2T_TRANSLATION_MAX_INFLIGHT"
                if role == "translation"
                else f"S2T_{role.upper()}_MAX_INFLIGHT"
            )
            maximum = int(settings.env.get(variable, default))
            if not 1 <= maximum <= 512:
                raise ValueError(f"Invalid {role} concurrency")
            waiting = (
                int(settings.env.get("S2T_HTTP_MAX_WAITING", 512))
                if role in {"asr", "translation"}
                else 128
            )
            if not 1 <= waiting <= 4096:
                raise ValueError("S2T_HTTP_MAX_WAITING must be in 1..4096")
            self.gates[role] = Gate(maximum, waiting=waiting)
            self.shared_maximum[role] = maximum

    async def open(self):
        from redis.asyncio import Redis, Sentinel, BlockingConnectionPool
        from .redis_pool import BlockingSentinelConnectionPool

        env = self.settings.env
        sentinel_nodes = env.get("REDIS_SENTINEL_NODES", "").strip()
        sentinel_configured = bool(env.get("REDIS_SERVICE_NAME")) or any(
            key.startswith("REDIS_SENTINEL_") and value.strip() for key, value in env.items()
        )
        if sentinel_configured:
            if not sentinel_nodes:
                raise ValueError("Sentinel 設定不完整")
            if env.get("REDIS_URL") or not env.get("REDIS_SERVICE_NAME"):
                raise ValueError("Sentinel 與 REDIS_URL 不可同時設定；必須提供 master name")
            nodes = []
            for node in sentinel_nodes.split(","):
                url = urlsplit("redis://" + node.strip())
                nodes.append((url.hostname, url.port or 26379))
            sentinel_options = {"socket_timeout": 3}
            for field, suffix in [("username", "USERNAME"), ("password", "PASSWARD")]:
                if env.get("REDIS_SENTINEL_" + suffix):
                    sentinel_options[field] = env["REDIS_SENTINEL_" + suffix]
            if env.get("REDIS_SENTINEL_TLS") == "true":
                sentinel_options["ssl"] = True
            self.sentinel = Sentinel(nodes, sentinel_kwargs=sentinel_options, socket_timeout=3)
            options = dict(
                socket_timeout=3,
                socket_connect_timeout=3,
                db=int(env.get("REDIS_DATABASE", 0)),
                max_connections=64,
            )
            for field, suffix in [("username", "USERNAME"), ("password", "PASSWARD")]:
                if env.get("REDIS_" + suffix):
                    options[field] = env["REDIS_" + suffix]
            if env.get("REDIS_TLS") == "true":
                options["ssl"] = True
            self.redis = self.sentinel.master_for(env["REDIS_SERVICE_NAME"], connection_pool_class=BlockingSentinelConnectionPool, timeout=3, **options)
        elif env.get("REDIS_URL"):
            self.redis = Redis.from_pool(BlockingConnectionPool.from_url(
                env["REDIS_URL"], socket_timeout=3, socket_connect_timeout=3, max_connections=64, timeout=3
            ))
        elif self.settings.distributed:
            raise ValueError("多 Pod 必須設定 Redis 或 Sentinel")
        if self.redis:
            await self.redis.ping()

    async def close(self):
        if self.redis:
            await self.redis.aclose()
        if self.sentinel:
            for client in self.sentinel.sentinels:
                await client.aclose()

    async def window(self, identity, bucket, maximum, duration=60000):
        key = "s2t:python:limits:" + digest(f"{identity}:{bucket}")
        if self.redis:
            try:
                accepted = await self.redis.eval(
                    WINDOW, 1, key, duration, maximum, str(uuid.uuid4())
                )
            except Exception:
                fail(503, "共享限流服務暫時不可用")
        else:
            timestamp = time.monotonic() * 1000
            self.windows = {
                key: stamps
                for key, stamps in self.windows.items()
                if stamps and stamps[-1] > timestamp - 900000
            }
            stamps = [value for value in self.windows.get(key, []) if value > timestamp - duration]
            accepted = len(stamps) < maximum
            if accepted:
                stamps.append(timestamp)
            self.windows[key] = stamps
        if not accepted:
            from fastapi import HTTPException

            raise HTTPException(
                429,
                "請求過於頻繁，請稍後重試",
                headers={"retry-after": str(max(1, duration // 1000))},
            )

    @asynccontextmanager
    async def capacity(self, role):
        async with self.gates[role].enter():
            if not self.redis:
                yield
                return
            key = "s2t:python:capacity:" + role
            owner = str(uuid.uuid4())
            acquired = False
            try:
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline:
                    if await self.redis.eval(CAPACITY, 1, key, self.shared_maximum[role], owner):
                        acquired = True
                        break
                    await asyncio.sleep(0.05)
            except Exception:
                fail(503, "共享容量服務暫時不可用")
            if not acquired:
                fail(503, "模型容量忙碌")
            task = asyncio.current_task()

            async def renew():
                try:
                    while True:
                        await asyncio.sleep(20)
                        if not await self.redis.eval(RENEW, 1, key, owner):
                            task.cancel()
                            return
                except asyncio.CancelledError:
                    raise
                except Exception:
                    task.cancel()

            heartbeat = asyncio.create_task(renew())
            try:
                yield
            finally:
                heartbeat.cancel()
                await asyncio.gather(heartbeat, return_exceptions=True)
                import anyio

                with anyio.CancelScope(shield=True):
                    await self.redis.zrem(key, owner)


async def _claim_new_request(storage, user_id, record, value):
    """One atomic statement for the common new-key path; existing keys use the checked replay path."""
    from psycopg.types.json import Jsonb
    async with storage.pool.connection() as connection:
        cursor = await connection.execute(
            "WITH guard AS MATERIALIZED (SELECT pg_advisory_xact_lock(hashtextextended(%s,0))), "
            "owner AS MATERIALIZED (SELECT id FROM s2t_users WHERE id=%s AND deletion_state='active' FOR SHARE) "
            "INSERT INTO s2t_config_records(scope,record_key,value) SELECT owner.id,%s,%s FROM owner CROSS JOIN guard "
            "ON CONFLICT(scope,record_key) DO NOTHING RETURNING record_key",
            (f"record:{user_id}:{record}", user_id, record, Jsonb(value)),
        )
        return bool(await cursor.fetchone())


async def _complete_request(storage, user_id, record, owner, value):
    from psycopg.types.json import Jsonb
    async with storage.pool.connection() as connection:
        cursor = await connection.execute(
            "WITH guard AS MATERIALIZED (SELECT pg_advisory_xact_lock(hashtextextended(%s,0))), "
            "account AS MATERIALIZED (SELECT id FROM s2t_users WHERE id=%s AND deletion_state='active' FOR SHARE) "
            "UPDATE s2t_config_records r SET value=%s,updated_at=now() FROM guard,account "
            "WHERE r.scope=account.id AND r.record_key=%s AND r.value->>'owner'=%s "
            "AND (r.value->>'leaseUntil')::double precision > extract(epoch FROM clock_timestamp())*1000 "
            "RETURNING r.record_key",
            (f"record:{user_id}:{record}", user_id, Jsonb(value), record, owner),
        )
        return bool(await cursor.fetchone())


async def idempotent(storage, user_id, route, key, fingerprint, operation):
    if not key:
        return await operation()
    if not re.fullmatch(r"[A-Za-z0-9._:-]{1,160}", key):
        fail(400, "無效的冪等識別")
    record = "request-" + digest(route + ":" + key)
    owner = str(uuid.uuid4())
    timestamp = time.time() * 1000
    initial = {"fingerprint": fingerprint, "owner": owner, "state": "running", "leaseUntil": timestamp + 120000, "expiresAt": timestamp + 600000}
    claimed = bool(storage.pool) and await _claim_new_request(storage, user_id, record, initial)
    if not claimed:
        async with storage.transaction(f"record:{user_id}:{record}") as tx:
            current = await tx.get(user_id, record)
            timestamp = time.time() * 1000
            if current and current.get("expiresAt", 0) > timestamp:
                if current.get("fingerprint") != fingerprint:
                    fail(409, "同一冪等識別的請求內容不同")
                if current.get("state") == "completed":
                    return current["result"]
                if current.get("leaseUntil", 0) > timestamp:
                    fail(409, "相同請求正在處理，請稍後重試")
            await tx.put(
                user_id,
                record,
                {
                    "fingerprint": fingerprint,
                    "owner": owner,
                    "state": "running",
                    "leaseUntil": timestamp + 120000,
                    "expiresAt": timestamp + 600000,
                },
            )
    lost = False

    async def renew():
        nonlocal lost
        try:
            while True:
                await asyncio.sleep(20)

                def refresh(value):
                    nonlocal lost
                    if (
                        not value
                        or value.get("owner") != owner
                        or value.get("leaseUntil", 0) <= time.time() * 1000
                    ):
                        lost = True
                        return UNCHANGED
                    return {**value, "leaseUntil": time.time() * 1000 + 120000}

                await storage.update(user_id, record, refresh)
                if lost:
                    return
        except asyncio.CancelledError:
            raise
        except Exception:
            lost = True

    heartbeat = asyncio.create_task(renew())
    try:
        result = await operation()
        completed = {"fingerprint": fingerprint, "state": "completed", "result": result, "expiresAt": time.time() * 1000 + 600000}
        if storage.pool:
            if lost or not await _complete_request(storage, user_id, record, owner, completed):
                fail(503, "處理租約失效，請重試")
        else:
            async with storage.transaction(f"record:{user_id}:{record}") as tx:
                current = await tx.get(user_id, record)
                if (
                    lost
                    or not current
                    or current.get("owner") != owner
                    or current.get("leaseUntil", 0) <= time.time() * 1000
                ):
                    fail(503, "處理租約失效，請重試")
                await tx.put(
                    user_id,
                    record,
                    {
                        "fingerprint": fingerprint,
                        "state": "completed",
                        "result": result,
                        "expiresAt": time.time() * 1000 + 600000,
                    },
                )
        return result
    except BaseException:
        import anyio

        with anyio.CancelScope(shield=True):
            await storage.update(
                user_id,
                record,
                lambda value: (
                    {**value, "leaseUntil": 0, "expiresAt": 0}
                    if value and value.get("owner") == owner
                    else UNCHANGED
                ),
            )
        raise
    finally:
        heartbeat.cancel()
        await asyncio.gather(heartbeat, return_exceptions=True)
