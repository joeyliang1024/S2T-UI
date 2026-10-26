import pytest
from fastapi.testclient import TestClient

from app.main import create_app


@pytest.fixture
def environment(tmp_path):
    return {
        "S2T_DATA_DIR": str(tmp_path),
        "S2T_MODEL_DIR": str(__import__("pathlib").Path(__file__).resolve().parents[2] / "models"),
        "S2T_AUTH_SECRET": "isolated-python-test-secret-123456",
        "S2T_ALLOW_DEFAULT_ADMIN": "true",
        "S2T_PROCESS_ROLE": "api",
    }


@pytest.fixture
def client(environment):
    app = create_app(environment)
    with TestClient(app) as client:
        yield client


@pytest.fixture
def admin(client):
    response = client.post("/api/auth/login", json={"username": "admin", "password": "admin"})
    assert response.status_code == 200, response.text
    return response.json()


def register(client, name="alice"):
    response = client.post(
        "/api/auth/register",
        json={
            "username": name,
            "password": "password-123",
            "NT": name,
            "Department": "engineering",
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def session_value(key="audio-one"):
    return {
        "id": "session-one",
        "title": "meeting",
        "createdAt": "2026-10-23T00:00:00Z",
        "source": "microphone",
        "transcript": "Hello",
        "audioKey": key,
        "durationMs": 1000,
        "segments": [
            {
                "id": "segment-one",
                "revision": 0,
                "status": "final",
                "startMs": 0,
                "endMs": 1000,
                "sourceText": "Hello",
            }
        ],
    }
