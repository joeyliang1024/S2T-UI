import asyncio
import threading

import pytest

from app.glossary import CsvGlossary
from app.redis_pool import BlockingSentinelConnectionPool


@pytest.mark.asyncio
async def test_sentinel_checkout_checks_run_in_parallel_and_remain_bounded():
    pool = BlockingSentinelConnectionPool('test', object(), max_connections=2, timeout=.03)
    entered, release = asyncio.Event(), asyncio.Event()
    checking = []

    async def check(connection):
        checking.append(connection)
        if len(checking) == 2:
            entered.set()
        await release.wait()

    pool.ensure_connection = check
    first, second = asyncio.create_task(pool.get_connection()), asyncio.create_task(pool.get_connection())
    try:
        await asyncio.wait_for(entered.wait(), 1)
        from redis.exceptions import ConnectionError
        with pytest.raises(ConnectionError):
            await pool.get_connection()
        release.set()
        connections = await asyncio.gather(first, second)
        assert connections[0] is not connections[1]
        for connection in connections:
            await pool.release(connection)
        connection = await pool.get_connection()
        await pool.release(connection)
        assert len(pool._in_use_connections) == 0
    finally:
        release.set()
        await asyncio.gather(first, second, return_exceptions=True)
        await pool.aclose()


@pytest.mark.asyncio
async def test_glossary_coalesces_concurrent_reads_and_isolates_cancellation(tmp_path):
    path = tmp_path / 'jargon.csv'
    path.write_text('jargon,az_jargon_listen\nASR,speech\n')
    glossary = CsvGlossary(path)
    entered, release = threading.Event(), threading.Event()
    calls = []
    original = glossary._load

    def held():
        calls.append(1)
        entered.set()
        assert release.wait(3)
        return original()

    glossary._load = held
    first = asyncio.create_task(glossary.load_glossary())
    assert await asyncio.to_thread(entered.wait, 2)
    followers = [asyncio.create_task(glossary.load_glossary()) for _ in range(100)]
    await asyncio.sleep(0)
    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first
    release.set()
    assert all(value == (('ASR', 'speech'),) for value in await asyncio.gather(*followers))
    assert len(calls) == 1
    path.write_text('jargon,az_jargon_listen\nASR,new translation\n')
    assert await glossary.load_glossary() == (('ASR', 'new translation'),)
    assert len(calls) == 2
