"""Cross replica ownership and replay checks for the PostgreSQL fast path."""
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor

import anyio
import pytest
from fastapi import HTTPException

from app.admission import idempotent
from app.core import digest
from test_postgres import postgres as postgres, replicas as replicas

pytestmark = pytest.mark.external


def invoke(client, user, key, operation, fingerprint='same'):
    return client.portal.call(idempotent, client.app.state.runtime.storage,
                              user['id'], 'test', key, fingerprint, operation)


def test_replay_conflict_and_failure_retry(replicas):
    first, second, user = replicas
    key = str(uuid.uuid4())
    calls = []

    async def operation():
        calls.append(1)
        return {'answer': 42}

    assert invoke(first, user, key, operation) == {'answer': 42}
    assert invoke(second, user, key, operation) == {'answer': 42}
    assert len(calls) == 1
    with pytest.raises(HTTPException) as conflict:
        invoke(second, user, key, operation, 'different')
    assert conflict.value.status_code == 409

    async def broken():
        raise ValueError('expected failure')

    retry_key = str(uuid.uuid4())
    with pytest.raises(ValueError):
        invoke(first, user, retry_key, broken)
    assert invoke(second, user, retry_key, operation) == {'answer': 42}


def test_inflight_conflict_and_expired_owner_cannot_publish(replicas):
    first, second, user = replicas
    key = str(uuid.uuid4())
    entered, release = threading.Event(), threading.Event()

    async def held():
        entered.set()
        await anyio.to_thread.run_sync(lambda: release.wait(10))
        return {'winner': 'stale'}

    async def replacement():
        return {'winner': 'new'}

    with ThreadPoolExecutor(1) as executor:
        future = executor.submit(invoke, first, user, key, held)
        try:
            assert entered.wait(5)
            with pytest.raises(HTTPException) as conflict:
                invoke(second, user, key, replacement)
            assert conflict.value.status_code == 409
            record = 'request-' + digest('test:' + key)
            second.portal.call(second.app.state.runtime.storage.update, user['id'], record,
                               lambda value: {**value, 'leaseUntil': 0})
            assert invoke(second, user, key, replacement) == {'winner': 'new'}
        finally:
            release.set()
        with pytest.raises(HTTPException) as stale:
            future.result(timeout=10)
        assert stale.value.status_code == 503
    assert invoke(first, user, key, replacement) == {'winner': 'new'}
