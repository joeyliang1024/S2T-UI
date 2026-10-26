"""Opt-in tests against an isolated, real PostgreSQL executable, never .env."""

import os
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from conftest import session_value

pytestmark = pytest.mark.external


@pytest.fixture(scope="module")
def postgres(tmp_path_factory):
    if os.environ.get("S2T_TEST_EMBEDDED_PG") != "1":
        pytest.skip("Set S2T_TEST_EMBEDDED_PG=1 and install requirements-integration.txt")
    pgserver = pytest.importorskip("pgserver")
    import fasteners

    directory = tempfile.TemporaryDirectory(
        prefix="s2t-pg-", dir="/private/tmp" if Path("/private/tmp").exists() else None
    )
    root = Path(directory.name)
    pgserver.PostgresServer.runtime_path = root
    pgserver.PostgresServer._lock = fasteners.InterProcessLock(root / "server.lock")
    server = pgserver.get_server(root / "pgdata", cleanup_mode="delete")
    try:
        yield server
    finally:
        server.cleanup()
        directory.cleanup()


@pytest.fixture
def replicas(postgres, environment):
    from psycopg.conninfo import conninfo_to_dict

    connection = conninfo_to_dict(postgres.get_uri())
    environment.update(
        {
            "S2T_POSTGRES_HOST": connection["host"],
            "S2T_POSTGRES_PORT": connection.get("port", "5432"),
            "S2T_POSTGRES_DB_NAME": connection.get("dbname", "postgres"),
            "S2T_POSTGRES_USER": connection.get("user", "postgres"),
            "S2T_POSTGRES_PASSWORD": "isolated-test-only",
        }
    )
    # Unique bootstrap identity is shared; data lives only in this fixture DB.
    with (
        TestClient(create_app(environment)) as first,
        TestClient(create_app(environment)) as second,
    ):
        first.post("/api/auth/login", json={"username": "admin", "password": "admin"})
        token = first.get("/api/auth/session").json()["user"]
        second.post("/api/auth/login", json={"username": "admin", "password": "admin"})
        yield first, second, token


def test_real_pg_cas_recording_handoff_and_revocation(replicas):
    first, second, user = replicas
    snapshot = first.get("/api/data/sessions").json()
    version = snapshot["version"]
    value = {"sessions": [session_value()], "version": version}
    with ThreadPoolExecutor(2) as executor:
        responses = list(
            executor.map(
                lambda client: client.post("/api/data/sessions", json=value), [first, second]
            )
        )
    assert sorted(response.status_code for response in responses) == [200, 409]
    headers = {"x-s2t-start-sample": "0", "x-s2t-sample-rate": "16000"}
    assert (
        first.put(
            "/api/data/recordings/pg-recording/chunks/0", content=b"\x01\x00", headers=headers
        ).status_code
        == 200
    )
    headers["x-s2t-start-sample"] = "1"
    assert (
        second.put(
            "/api/data/recordings/pg-recording/chunks/1", content=b"\x02\x00", headers=headers
        ).json()["persistedSamples"]
        == 2
    )
    assert (
        second.post(
            "/api/data/recordings/pg-recording/finish", json={"totalChunks": 2, "totalSamples": 2}
        ).status_code
        == 200
    )
    assert first.get("/api/data/audio/pg-recording").content[44:] == b"\x01\x00\x02\x00"
    result = first.post("/api/auth/login", json={"username": "admin", "password": "admin"}).json()
    first.post("/api/auth/logout")
    assert (
        second.get(
            "/api/auth/session", headers={"authorization": "Bearer " + result["token"]}
        ).status_code
        == 401
    )


def test_real_pg_lease_fences_stale_workers(replicas, postgres):
    import psycopg

    first, second, user = replicas
    result = first.post(
        "/api/data/diarization-jobs", json={"sessionId": "lease-session", "audioKey": "lease-audio"}
    )
    assert result.status_code == 202, result.text
    job_id = result.json()["job"]["id"]
    left, right = first.app.state.runtime.jobs, second.app.state.runtime.jobs
    claimed = first.portal.call(left.claim)
    assert claimed["id"] == job_id
    assert second.portal.call(right.claim) is None
    with psycopg.connect(postgres.get_uri()) as connection:
        connection.execute(
            "UPDATE s2t_diarization_jobs SET lease_until=now()-interval '1 second' WHERE id=%s",
            (job_id,),
        )
    takeover = second.portal.call(right.claim)
    assert takeover["leaseGeneration"] == claimed["leaseGeneration"] + 1
    stale = first.portal.call(left.commit, claimed, 0, {"sessions": [], "version": 1})
    assert stale == "lost"
    assert first.portal.call(left.transition, claimed, None, True) is False
    assert second.portal.call(right.transition, takeover, None, True) is True


def test_real_pg_unique_admin_and_settings(replicas):
    first, second, user = replicas
    current = first.get("/api/data/settings").json()
    body = {"settings": {"theme": "dark"}, "version": current["version"]}
    assert first.post("/api/data/settings", json=body).status_code == 200
    assert second.post("/api/data/settings", json=body).status_code == 409
    assert second.get("/api/data/settings").json()["settings"]["theme"] == "dark"
    assert (
        len(
            [
                item
                for item in first.get("/api/admin/users").json()["users"]
                if item["role"] == "admin"
            ]
        )
        == 1
    )


def test_real_pg_managed_model_join_and_key_rotation(replicas):
    first, second, user = replicas
    current = first.get("/api/data/model-registry").json()
    model = {
        "id": "pg-model",
        "name": "model",
        "purpose": "asr",
        "endpoint": "http://model/v1",
        "model": "mock",
        "requiresApiKey": True,
    }
    assert (
        first.post(
            "/api/data/model-registry", json={"models": [model], "version": current["version"]}
        ).status_code
        == 200
    )
    assert (
        first.post("/api/data/model-credentials/pg-model", json={"apiKey": "first-key"}).status_code
        == 204
    )
    rt = second.app.state.runtime
    assert second.portal.call(rt.models.managed, "pg-model", "asr")["apiKey"] == "first-key"
    assert (
        first.post(
            "/api/data/model-credentials/pg-model", json={"apiKey": "rotated-key"}
        ).status_code
        == 204
    )
    assert second.portal.call(rt.models.managed, "pg-model", "asr")["apiKey"] == "rotated-key"
    assert "rotated-key" not in second.get("/api/data/model-registry").text


def test_real_pg_query_deadline_discards_socket_and_recovers(replicas):
    import time
    import psycopg

    first, second, user = replicas
    rt = first.app.state.runtime

    async def slow():
        async with rt.storage.pool.connection() as connection:
            connection.wire_timeout = 0.05
            await connection.execute("SELECT pg_sleep(2)")

    start = time.monotonic()
    with pytest.raises(psycopg.OperationalError):
        first.portal.call(slow)
    assert time.monotonic() - start < 1
    assert first.get("/readyz").status_code == 200


def test_real_pg_conflicting_chunks_and_verified_cleanup(replicas):
    first, second, user = replicas
    capture = "pg-cleanup-fence"
    def send(client, body):
        return client.put(f"/api/data/recordings/{capture}/chunks/0", headers={"x-s2t-start-sample": "0", "x-s2t-sample-rate": "16000"}, content=body)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda pair: send(*pair), [(first, b"\x01\x00"), (second, b"\x02\x00")]))
    assert sorted(result.status_code for result in results) == [200, 409]
    rt = first.app.state.runtime
    assert len(first.portal.call(rt.storage.list_blobs, user["id"], f"chunks/{capture}/")) == 1
    assert first.post("/api/data/audio/pg-cleanup-saved", content=b"RIFFdurable").status_code == 201
    snapshot = first.get("/api/data/sessions").json()
    row = {**session_value("pg-cleanup-saved"), "id": "pg-cleanup-session", "audioUnavailable": False, "processingState": "completed", "processingToken": "pg-cleanup-token"}
    snapshot["sessions"].append(row)
    assert first.post("/api/data/sessions", json=snapshot).status_code == 200
    target = {"sessionId": row["id"], "audioKey": row["audioKey"], "processingToken": row["processingToken"]}
    assert second.post(f"/api/data/recordings/{capture}/cleanup", json=target).status_code == 204
    assert first.get(f"/api/data/recordings/{capture}").status_code == 404
    assert send(first, b"\x01\x00").status_code == 409
    assert second.post(f"/api/data/recordings/{capture}/cleanup", json=target).status_code == 204
    assert first.portal.call(rt.storage.list_blobs, user["id"], f"chunks/{capture}/") == []
