import gzip
import json
import struct

import httpx
from fastapi.testclient import TestClient

from app.main import create_app
from conftest import register, session_value


def test_auth_role_revocation_and_isolation(client, admin):
    alice = register(client)
    assert alice["user"]["role"] == "user"
    assert client.get("/api/admin/users").status_code == 403
    assert client.get("/api/auth/session").json()["user"]["id"] == alice["user"]["id"]
    assert (
        client.post(
            "/api/data/settings", json={"settings": {"adminParameters": {}}, "version": 0}
        ).status_code
        == 403
    )
    assert (
        client.post(
            "/api/data/settings", json={"settings": {"theme": "dark"}, "version": 0}
        ).status_code
        == 200
    )
    assert client.post("/api/auth/logout").status_code == 204
    assert (
        client.get(
            "/api/auth/session", headers={"authorization": "Bearer " + alice["token"]}
        ).status_code
        == 401
    )
    client.headers["authorization"] = "Bearer " + admin["token"]
    assert client.get("/api/data/settings").json()["settings"].get("theme") is None
    assert (
        client.put(
            f"/api/admin/users/{alice['user']['id']}/role", json={"role": "developer"}
        ).status_code
        == 200
    )
    client.headers.clear()
    assert (
        client.post(
            "/api/auth/login", json={"username": "alice", "password": "password-123"}
        ).json()["user"]["role"]
        == "developer"
    )


def test_session_cas_gzip_and_audio(client, admin):
    original = session_value()
    assert client.get("/api/data/sessions").json() == {"sessions": [], "version": 0}
    assert client.post("/api/data/audio/audio-one", content=b"RIFFtest").status_code == 201
    assert client.get("/api/data/audio/audio-one").content == b"RIFFtest"
    response = client.post(
        "/api/data/sessions",
        content=gzip.compress(json.dumps({"sessions": [original], "version": 0}).encode()),
        headers={"content-encoding": "gzip"},
    )
    assert response.status_code == 200, response.text
    assert client.get("/api/data/sessions").json()["sessions"] == [original]
    assert client.post("/api/data/sessions", json={"sessions": [], "version": 0}).status_code == 409
    assert (
        client.post(
            "/api/data/sessions", json={"sessions": [{"id": "broken"}], "version": 1}
        ).status_code
        == 400
    )
    assert (
        client.post(
            "/api/data/sessions", content=b"bad", headers={"content-encoding": "gzip"}
        ).status_code
        == 400
    )
    assert (
        client.post(
            "/api/data/sessions", content=b"x", headers={"content-encoding": "br"}
        ).status_code
        == 415
    )
    assert client.get("/api/data/sessions").json()["version"] == 1
    register(client, "bob")
    assert client.get("/api/data/audio/audio-one").status_code == 404


def test_recording_order_retry_finish_promote(client, admin):
    def append(index, start, content):
        return client.put(
            f"/api/data/recordings/recording-one/chunks/{index}",
            headers={"x-s2t-start-sample": str(start), "x-s2t-sample-rate": "16000"},
            content=content,
        )

    assert append(1, 2, b"\x03\x00\x04\x00").json()["contiguousChunks"] == 0
    assert append(0, 0, b"\x01\x00\x02\x00").json()["persistedSamples"] == 4
    assert append(0, 0, b"\x01\x00\x02\x00").status_code == 200
    assert append(0, 0, b"\x09\x00").status_code == 409
    assert append(2, 3, b"\x01\x00").status_code == 409
    assert client.delete("/api/data/recordings/recording-one").status_code == 409
    assert (
        client.post(
            "/api/data/recordings/recording-one/finish", json={"totalChunks": 2, "totalSamples": 5}
        ).status_code
        == 409
    )
    response = client.post(
        "/api/data/recordings/recording-one/finish", json={"totalChunks": 2, "totalSamples": 4}
    )
    assert response.status_code == 200, response.text
    audio = client.get("/api/data/audio/recording-one").content
    assert len(audio) == 52 and struct.unpack_from("<I", audio, 40)[0] == 8
    assert audio[44:] == b"\x01\x00\x02\x00\x03\x00\x04\x00"
    assert (
        client.post(
            "/api/data/recordings/recording-one/promote", json={"audioKey": "permanent-one"}
        ).status_code
        == 201
    )
    assert client.get("/api/data/audio/permanent-one").content == audio
    assert client.delete("/api/data/recordings/recording-one").status_code == 204
    assert client.get("/api/data/audio/permanent-one").status_code == 200


def test_model_credentials_registry_templates_and_glossary(client, admin):
    model = {
        "id": "asr-one",
        "name": "ASR",
        "endpoint": "http://model/v1",
        "model": "mock-model",
        "purpose": "asr",
    }
    assert (
        client.post("/api/data/model-registry", json={"models": [model], "version": 0}).status_code
        == 200
    )
    assert (
        client.post(
            "/api/data/model-registry", json={"models": [model, model], "version": 1}
        ).status_code
        == 400
    )
    assert (
        client.post(
            "/api/data/model-credentials/asr-one", json={"apiKey": "secret-api-key"}
        ).status_code
        == 204
    )
    assert "secret-api-key" not in client.get("/api/data/model-registry").text
    assert client.get("/api/data/model-credentials/asr-one").status_code == 405
    assert (
        client.post("/api/data/glossary", json={"glossary": "hello", "version": 0}).status_code
        == 200
    )
    assert (
        client.post("/api/data/glossary", json={"glossary": "stale", "version": 0}).status_code
        == 409
    )
    assert client.get("/api/data/glossary").json()["glossary"] == "hello"
    assert client.get("/api/data/summary-templates").json()["templates"]
    assert (
        client.post(
            "/api/data/summary-templates",
            json={
                "templates": [{"id": "personal", "name": "custom", "content": "# Notes"}],
                "version": 0,
            },
        ).status_code
        == 200
    )
    assert any(
        item["id"] == "personal"
        for item in client.get("/api/data/summary-templates").json()["templates"]
    )


def test_account_delete_purges_and_revokes(client, admin):
    alice = register(client)
    assert client.post("/api/data/audio/audio-one", content=b"recording").status_code == 201
    assert client.post("/api/data/live-draft", json={"value": {"id": "draft"}}).status_code == 204
    client.headers["authorization"] = "Bearer " + admin["token"]
    assert client.delete(f"/api/admin/users/{admin['user']['id']}").status_code == 409
    response = client.delete(f"/api/admin/users/{alice['user']['id']}")
    assert response.status_code == 200, response.text
    client.headers["authorization"] = "Bearer " + alice["token"]
    assert client.get("/api/auth/session").status_code == 401
    client.headers.clear()
    assert (
        client.post(
            "/api/auth/login", json={"username": "alice", "password": "password-123"}
        ).status_code
        == 401
    )


def test_origin_health_metrics_and_private_records(client, admin):
    assert client.get("/livez").status_code == 200
    assert client.get("/readyz").status_code == 200
    assert client.get("/").status_code == 404
    assert client.get("/api/data/revoked-auth-tokens").status_code == 404
    assert (
        client.get("/api/auth/session", headers={"origin": "https://attacker.example"}).status_code
        == 403
    )
    assert (
        client.get("/api/auth/session", headers={"origin": "http://testserver"}).status_code == 200
    )
    assert client.post("/api/telemetry/journey", json={"stage": "L2"}).status_code == 200
    assert (
        client.post(
            "/api/telemetry/captions",
            json={
                "samples": [{"stage": "t3_model", "seconds": 0.2}],
                "events": {"speech_detected": 1},
            },
        ).status_code
        == 200
    )
    assert (
        client.post(
            "/api/telemetry/captions", json={"samples": [{"stage": "arbitrary", "seconds": 0.2}]}
        ).status_code
        == 400
    )
    assert "s2t_user_journey_events_total" in client.get("/metrics").text
    assert client.get("/api/config").json()["prompts"]


def test_native_models_and_idempotency(environment):
    calls = []

    async def handler(request):
        body = await request.aread()
        calls.append((request, body))
        if request.url.path.endswith("/audio/transcriptions"):
            return httpx.Response(200, json={"text": "hello", "language": "zh"})
        if request.url.path.endswith("/models"):
            return httpx.Response(200, json={"data": [{"id": "mock"}]})
        if json.loads(body).get("stream"):
            return httpx.Response(
                200,
                text='data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n',
                headers={"content-type": "text/event-stream"},
            )
        return httpx.Response(200, json={"choices": [{"message": {"content": "translated"}}]})

    for purpose in ("ASR", "TRANSLATION", "SUMMARY"):
        environment.update(
            {
                f"S2T_{purpose}_ENDPOINT": "http://model/v1",
                f"S2T_{purpose}_MODEL": "mock",
                f"S2T_{purpose}_API_KEY": "secret",
            }
        )
    with TestClient(create_app(environment, httpx.MockTransport(handler))) as client:
        client.post("/api/auth/login", json={"username": "admin", "password": "admin"})
        headers = {
            "content-type": "audio/wav",
            "x-s2t-idempotency-key": "one",
            "x-s2t-language": "zh",
        }
        first = client.post("/api/transcriptions", content=b"audio", headers=headers)
        assert first.status_code == 200, first.text
        assert first.json() == {"text": "hello", "detectedLanguage": "zh-TW"}
        assert "model;dur=" in first.headers["server-timing"]
        assert (
            client.post("/api/transcriptions", content=b"audio", headers=headers).json()
            == first.json()
        )
        assert len(calls) == 1
        assert (
            client.post("/api/transcriptions", content=b"different", headers=headers).status_code
            == 409
        )
        assert client.post(
            "/api/translations", json={"text": "hello", "targetLanguage": "en"}
        ).json() == {"text": "translated"}
        response = client.post(
            "/api/summaries",
            json={"messages": [{"role": "user", "content": "hello"}], "stream": True},
        )
        assert [json.loads(line) for line in response.text.splitlines()] == [
            {"delta": "hello"},
            {"done": True},
        ]
        assert all("cookie" not in request.headers for request, body in calls)


def test_python_restart_reads_existing_local_data(client, admin, environment):
    client.post("/api/data/settings", json={"settings": {"theme": "dark"}, "version": 0})
    with TestClient(create_app(environment)) as second:
        second.headers["authorization"] = "Bearer " + admin["token"]
        assert second.get("/api/auth/session").status_code == 200
        assert second.get("/api/data/settings").json()["settings"]["theme"] == "dark"


def test_legacy_session_versions_are_fenced(client, admin):
    rt = client.app.state.runtime
    client.portal.call(rt.storage.put, admin["user"]["id"], "sessions", [session_value()])
    value = client.get("/api/data/sessions").json()
    assert value["version"] >= 2**48
    assert value["sessions"] == [session_value()]
    assert client.post("/api/data/sessions", json={"sessions": [], "version": 0}).status_code == 409


def test_model_probe_never_forwards_stored_key_to_changed_destination(environment):
    calls = []

    async def upstream(request):
        calls.append(request)
        return httpx.Response(200, json={"data": [{"id": "mock"}]})

    with TestClient(create_app(environment, httpx.MockTransport(upstream))) as client:
        client.post("/api/auth/login", json={"username": "admin", "password": "admin"})
        model = {
            "id": "probe",
            "name": "probe",
            "purpose": "summary",
            "endpoint": "http://original/v1",
            "model": "mock",
        }
        client.post("/api/data/model-registry", json={"models": [model], "version": 0})
        client.post("/api/data/model-credentials/probe", json={"apiKey": "saved-key"})
        changed = client.post("/api/data/model-test", json={**model, "endpoint": "http://other/v1"})
        assert changed.status_code == 200 and changed.json()["result"]["state"] == "unknown"
        assert calls == []
        same = client.post("/api/data/model-test", json=model)
        assert same.json()["result"]["state"] == "healthy"
        assert calls[0].headers["authorization"] == "Bearer saved-key"


def test_gzip_expansion_limit_cannot_overwrite_sessions(client, admin):
    response = client.post(
        "/api/data/sessions",
        content=gzip.compress(b"x" * (32 * 1024**2 + 1)),
        headers={"content-encoding": "gzip"},
    )
    assert response.status_code == 413
    assert client.get("/api/data/sessions").json() == {"sessions": [], "version": 0}
