"""Regression coverage for cross-Pod references and storage outside SQL transactions."""
from concurrent.futures import ThreadPoolExecutor
from threading import Event

import anyio
from conftest import session_value
from test_postgres import postgres as postgres, replicas as replicas


def chunk(client, capture):
    response = client.put(f"/api/data/recordings/{capture}/chunks/0", content=b"\x01\x00", headers={"x-s2t-start-sample": "0", "x-s2t-sample-rate": "16000"})
    assert response.status_code == 200


def finish(client, capture):
    return client.post(f"/api/data/recordings/{capture}/finish", json={"totalChunks": 1, "totalSamples": 1})


def test_new_reference_rejected_during_cleanup(replicas, monkeypatch):
    first, second, _user = replicas
    capture = "fenced-reference"
    chunk(first, capture)
    assert finish(first, capture).status_code == 200
    entered, release = Event(), Event()
    original = first.app.state.runtime.storage.remove_blob
    async def held(*args):
        entered.set()
        await anyio.to_thread.run_sync(lambda: release.wait(5))
        return await original(*args)
    monkeypatch.setattr(first.app.state.runtime.storage, "remove_blob", held)
    with ThreadPoolExecutor(1) as pool:
        deleting = pool.submit(first.delete, f"/api/data/recordings/{capture}")
        try:
            assert entered.wait(5)
            snapshot = second.get("/api/data/sessions").json()
            snapshot["sessions"].append({**session_value(capture), "id": "fenced-reference-session"})
            assert second.post("/api/data/sessions", json=snapshot).status_code == 409
        finally:
            release.set()
        assert deleting.result(timeout=5).status_code == 204
    assert second.post("/api/data/sessions", json=snapshot).status_code == 409
    assert second.get(f"/api/data/audio/{capture}").status_code == 404


def test_slow_finish_does_not_hold_sql_transaction(replicas, monkeypatch):
    first, second, _user = replicas
    capture = "slow-finish-fenced"
    chunk(first, capture)
    original = first.app.state.runtime.storage.put_stream
    async def delayed(*args, **kwargs):
        await anyio.sleep(10.5)  # Exceeds default idle-in-transaction timeout.
        return await original(*args, **kwargs)
    monkeypatch.setattr(first.app.state.runtime.storage, "put_stream", delayed)
    response = finish(first, capture)
    assert response.status_code == 200, response.text
    assert second.get(f"/api/data/audio/{capture}").content[44:] == b"\x01\x00"


def test_stale_finish_cannot_publish_or_remove_new_attempt(replicas, monkeypatch):
    first, second, user = replicas
    capture = "late-finish-fenced"
    chunk(first, capture)
    entered, release = Event(), Event()
    storage = first.app.state.runtime.storage
    original = storage.put_stream
    attempts = []
    async def held(scope, key, stream):
        attempts.append(key)
        entered.set()
        await anyio.to_thread.run_sync(lambda: release.wait(5))
        return await original(scope, key, stream)
    monkeypatch.setattr(storage, "put_stream", held)
    with ThreadPoolExecutor(1) as pool:
        old = pool.submit(finish, first, capture)
        try:
            assert entered.wait(5)
            assert second.delete(f"/api/data/recordings/{capture}").status_code == 409
            second.portal.call(second.app.state.runtime.storage.update, user["id"], "recording-" + capture, lambda value: {**value, "finishUntil": 0})
            assert finish(second, capture).status_code == 200
            manifest = second.portal.call(second.app.state.runtime.storage.get, user["id"], "recording-" + capture)
            assert manifest["assemblyKey"] != attempts[0]
        finally:
            release.set()
        assert old.result(timeout=5).status_code == 409
    assert second.get(f"/api/data/audio/{capture}").content[44:] == b"\x01\x00"
    assert second.portal.call(second.app.state.runtime.storage.get_blob, user["id"], attempts[0]) is None


def test_slow_chunk_write_does_not_hold_sql_transaction(replicas, monkeypatch):
    first, second, _user = replicas
    storage = first.app.state.runtime.storage
    original = storage.put_blob
    async def delayed(*args, **kwargs):
        await anyio.sleep(10.5)
        return await original(*args, **kwargs)
    monkeypatch.setattr(storage, "put_blob", delayed)
    chunk(first, "slow-chunk-write")
    assert finish(second, "slow-chunk-write").status_code == 200
    assert second.get("/api/data/audio/slow-chunk-write").content[44:] == b"\x01\x00"


def test_read_pool_does_not_open_idle_transactions(replicas):
    first, _second, _user = replicas
    storage = first.app.state.runtime.storage
    async def inspect():
        from psycopg.pq import TransactionStatus
        async with storage.pool.connection() as connection:
            assert connection.autocommit
            await connection.execute("SELECT 1")
            assert connection.info.transaction_status == TransactionStatus.IDLE
    first.portal.call(inspect)
