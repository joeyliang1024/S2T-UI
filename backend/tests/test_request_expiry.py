import time

import pytest

from app.core import digest
from test_postgres import postgres as postgres, replicas as replicas

pytestmark = pytest.mark.external


def test_expiry_cleanup_uses_index_and_preserves_live_lease(replicas):
    first, _, user = replicas
    storage = first.app.state.runtime.storage
    timestamp = time.time() * 1000
    expired, live, future = ('request-' + digest('expiry-' + key) for key in ('old', 'live', 'future'))
    for key, value in [
        (expired, {'state': 'completed', 'expiresAt': timestamp - 1000}),
        (live, {'state': 'running', 'expiresAt': timestamp - 1000, 'leaseUntil': timestamp + 60000}),
        (future, {'state': 'completed', 'expiresAt': timestamp + 60000}),
    ]:
        first.portal.call(storage.put, user['id'], key, value)
    first.portal.call(storage.prune_requests)
    assert first.portal.call(storage.get, user['id'], expired) is None
    assert first.portal.call(storage.get, user['id'], live)['leaseUntil'] > timestamp
    assert first.portal.call(storage.get, user['id'], future) is not None

    async def check_index():
        async with storage.pool.connection() as connection:
            return await (await connection.execute("SELECT to_regclass('s2t_request_expiry_index')")).fetchone()
    assert first.portal.call(check_index)[0] == 's2t_request_expiry_index'


def test_dependency_health_does_not_wait_for_saturated_request_pool(replicas):
    first, _, _ = replicas
    storage = first.app.state.runtime.storage

    async def saturate_and_probe():
        import asyncio
        from contextlib import AsyncExitStack
        async with AsyncExitStack() as stack:
            maximum = storage.pool.get_stats()['pool_max']
            for _ in range(maximum):
                await stack.enter_async_context(storage.pool.connection())
            assert storage.pool.get_stats()['pool_available'] == 0
            await asyncio.wait_for(storage.health(), 1)
        assert storage.health_pool.get_stats()['pool_max'] == 1
    first.portal.call(saturate_and_probe)


def test_expiry_cleanup_drains_more_than_one_bounded_batch(replicas):
    first, _, user = replicas
    storage = first.app.state.runtime.storage

    async def seed_and_clean():
        async with storage.pool.connection() as connection:
            await connection.execute(
                "INSERT INTO s2t_config_records(scope,record_key,value) SELECT %s,'request-' || repeat(md5('cleanup-batch-' || i::text),2),jsonb_build_object('expiresAt',0,'cleanupTest','batch') FROM generate_series(1,1001) i ON CONFLICT DO NOTHING",
                (user['id'],),
            )
        await storage.prune_requests()
        async with storage.pool.connection() as connection:
            return await (await connection.execute(
                "SELECT count(*) FROM s2t_config_records WHERE scope=%s AND value->>'cleanupTest'='batch'", (user['id'],)
            )).fetchone()
    assert first.portal.call(seed_and_clean)[0] == 0


def test_expiry_cleanup_skips_other_worker_without_waiting(replicas):
    first, _, user = replicas
    storage = first.app.state.runtime.storage
    key = 'request-' + digest('maintenance-owner')
    first.portal.call(storage.put, user['id'], key, {'expiresAt':0})

    async def compete():
        import asyncio
        async with storage.pool.connection() as connection:
            async with connection.transaction():
                await connection.execute("SELECT pg_advisory_xact_lock(hashtextextended('s2t:request-expiry-maintenance',0))")
                await asyncio.wait_for(storage.prune_requests(), .5)
                assert await storage.get(user['id'], key) is not None
        await storage.prune_requests()
        assert await storage.get(user['id'], key) is None
    first.portal.call(compete)
