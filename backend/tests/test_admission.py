import asyncio

import pytest
from fastapi import HTTPException

from app.admission import Admission
from app.core import Settings


@pytest.mark.asyncio
async def test_shared_redis_lua_capacity_and_rate(environment):
    fakeredis = pytest.importorskip("fakeredis.aioredis")
    import fakeredis as fake_root

    server = fake_root.FakeServer()
    settings = Settings({**environment, "S2T_ASR_MAX_INFLIGHT": "1"})
    left, right = Admission(settings), Admission(settings)
    left.redis = fakeredis.FakeRedis(server=server)
    right.redis = fakeredis.FakeRedis(server=server)
    try:
        await left.window("alice", "asr", 1)
        with pytest.raises(HTTPException) as error:
            await right.window("alice", "asr", 1)
        assert error.value.status_code == 429
        entered = asyncio.Event()

        async def enter():
            async with right.capacity("asr"):
                entered.set()

        async with left.capacity("asr"):
            task = asyncio.create_task(enter())
            await asyncio.sleep(0.1)
            assert not entered.is_set()
        await asyncio.wait_for(task, 1)
        assert entered.is_set()
    finally:
        await left.close()
        await right.close()
