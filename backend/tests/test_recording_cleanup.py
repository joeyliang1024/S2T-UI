import pytest
from conftest import session_value, register


def append(client, capture="capture-cleanup", data=b"\x01\x00", index=0, start=0):
    return client.put(f"/api/data/recordings/{capture}/chunks/{index}", headers={"x-s2t-start-sample": str(start), "x-s2t-sample-rate": "16000"}, content=data)


def commit(client, token="capture-token"):
    assert client.post("/api/data/audio/saved-audio", content=b"RIFFsaved-audio").status_code == 201
    row = {**session_value("saved-audio"), "audioUnavailable": False, "processingState": "completed", "processingToken": token}
    version = client.get("/api/data/sessions").json()["version"]
    response = client.post("/api/data/sessions", json={"sessions": [row], "version": version})
    assert response.status_code == 200, response.text
    return {"sessionId": row["id"], "audioKey": "saved-audio", "processingToken": token}


def test_fallback_cleanup_requires_durable_matching_commit(client, admin):
    assert append(client).status_code == 200
    target = {"sessionId": "session-one", "audioKey": "saved-audio", "processingToken": "capture-token"}
    url = "/api/data/recordings/capture-cleanup/cleanup"
    assert client.delete("/api/data/recordings/capture-cleanup").status_code == 409
    assert client.post(url, json=target).status_code == 409
    commit(client)
    assert client.post(url, json={**target, "processingToken": "stale"}).status_code == 409
    assert client.post(url, json=target).status_code == 204
    assert client.post(url, json=target).status_code == 204
    assert client.get("/api/data/recordings/capture-cleanup").status_code == 404
    assert client.get("/api/data/audio/saved-audio").status_code == 200
    assert append(client).status_code == 409, "late requests cannot resurrect a cleaned capture"
    rt = client.app.state.runtime
    assert client.portal.call(rt.storage.list_blobs, admin["user"]["id"], "chunks/capture-cleanup/") == []


def test_cleanup_keeps_backup_when_replacement_missing_or_running(client, admin):
    assert append(client).status_code == 200
    target = commit(client)
    assert client.delete("/api/data/audio/saved-audio").status_code == 204
    assert client.post("/api/data/recordings/capture-cleanup/cleanup", json=target).status_code == 409
    assert client.get("/api/data/recordings/capture-cleanup").status_code == 200
    commit(client)
    snapshot = client.get("/api/data/sessions").json()
    snapshot["sessions"][0]["processingState"] = "running"
    assert client.post("/api/data/sessions", json=snapshot).status_code == 200
    assert client.post("/api/data/recordings/capture-cleanup/cleanup", json=target).status_code == 409


def test_conflicts_do_not_create_orphan_blobs_and_legacy_orphans_are_swept(client, admin):
    assert append(client).status_code == 200
    assert append(client, data=b"\x02\x00").status_code == 409
    rt, user = client.app.state.runtime, admin["user"]["id"]
    assert len(client.portal.call(rt.storage.list_blobs, user, "chunks/capture-cleanup/")) == 1
    client.portal.call(rt.storage.put_blob, user, "chunks/capture-cleanup/legacy-orphan", b"old")
    client.portal.call(rt.storage.put_blob, user, "chunks/capture-cleanup-other/retained", b"other capture")
    assert client.post("/api/data/recordings/capture-cleanup/cleanup", json=commit(client)).status_code == 204
    assert client.portal.call(rt.storage.list_blobs, user, "chunks/capture-cleanup/") == []
    assert len(client.portal.call(rt.storage.list_blobs, user, "chunks/capture-cleanup-other/")) == 1


def test_failed_write_intent_survives_and_cleanup_retry_finishes(client, admin, monkeypatch):
    rt, user = client.app.state.runtime, admin["user"]["id"]
    original = rt.storage.put_blob
    async def fail_after_write(*args):
        await original(*args)
        raise RuntimeError("injected post-write failure")
    monkeypatch.setattr(rt.storage, "put_blob", fail_after_write)
    with pytest.raises(Exception):
        append(client)
    manifest = client.portal.call(rt.storage.get, user, "recording-capture-cleanup")
    assert manifest["pendingChunks"] and not manifest["chunks"]
    monkeypatch.setattr(rt.storage, "put_blob", original)
    target = commit(client)
    remove = rt.storage.remove_blob
    calls = 0
    async def interrupted(*args):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise RuntimeError("injected delete failure after first object removal")
        await remove(*args)
    monkeypatch.setattr(rt.storage, "remove_blob", interrupted)
    with pytest.raises(Exception):
        client.post("/api/data/recordings/capture-cleanup/cleanup", json=target)
    assert client.portal.call(rt.storage.get, user, "recording-capture-cleanup")["state"] == "deleting"
    assert client.portal.call(rt.storage.list_blobs, user, "chunks/capture-cleanup/") == [], "first object was deleted before interruption"
    assert client.post("/api/data/recordings/capture-cleanup/cleanup", json=target).status_code == 204
    assert client.portal.call(rt.storage.list_blobs, user, "chunks/capture-cleanup/") == []


def test_cleanup_is_account_scoped_and_protects_original_audio(client, admin):
    assert append(client).status_code == 200
    target = commit(client)
    register(client, "cleanup-other")
    assert client.post("/api/data/recordings/capture-cleanup/cleanup", json=target).status_code == 409
    client.headers["authorization"] = "Bearer " + admin["token"]
    assert client.get("/api/data/recordings/capture-cleanup").status_code == 200
    snapshot = client.get("/api/data/sessions").json()
    snapshot["sessions"][0]["audioVersions"] = [{"id": "original", "audioKey": "capture-cleanup", "createdAt": "2026-10-25T00:00:00Z", "label": "original", "segments": [], "transcript": ""}]
    assert client.post("/api/data/sessions", json=snapshot).status_code == 200
    assert client.post("/api/data/recordings/capture-cleanup/cleanup", json=target).status_code == 409
