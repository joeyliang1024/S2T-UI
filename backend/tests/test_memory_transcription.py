import io
import wave
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient
from starlette.requests import ClientDisconnect

from app.main import create_app


@pytest.mark.parametrize('mode', ['small', 'large', 'normalized', 'chunked'])
def test_memory_source_is_bounded_and_retains_file_fallback(client, admin, monkeypatch, mode):
    payload = b'RIFF' + b'\0' * (300000 if mode == 'large' else 100)
    paths = []

    async def model(user, source, content_type, headers):
        if mode == 'small':
            assert isinstance(source, bytes)
            assert source == payload
        else:
            assert isinstance(source, Path)
            assert source.read_bytes() == payload
            paths.append(source)
        return {'text': 'test'}, {}

    monkeypatch.setattr(client.app.state.runtime.models, 'transcribe', model)
    headers = {'content-type': 'audio/wav'}
    if mode == 'normalized':
        headers['x-s2t-dynaudnorm'] = 'true'
    content = iter([payload]) if mode == 'chunked' else payload
    assert client.post('/api/transcriptions', content=content, headers=headers).status_code == 200
    assert all(not path.exists() for path in paths)


def test_false_small_length_cannot_exceed_memory_limit(client, admin):
    response = client.post('/api/transcriptions', content=b'a' * 300000,
                           headers={'content-type': 'audio/wav', 'content-length': '8'})
    assert response.status_code == 413


def test_memory_multipart_metrics_and_file_replay_are_identical(environment):
    output = io.BytesIO()
    with wave.open(output, 'wb') as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(16000)
        writer.writeframes(b'\0\0' * 16000)
    payload, calls = output.getvalue(), []

    async def upstream(request):
        body = await request.aread()
        assert payload in body
        assert int(request.headers['content-length']) == len(body)
        calls.append(1)
        return httpx.Response(200, json={'text': 'memory caption', 'language': 'en'})

    environment.update({'S2T_ASR_ENDPOINT': 'http://model/v1', 'S2T_ASR_MODEL': 'test', 'S2T_ASR_API_KEY': 'isolated-test-only'})
    with TestClient(create_app(environment, httpx.MockTransport(upstream))) as client:
        user = client.post('/api/auth/login', json={'NT': 'admin', 'password': 'admin'}).json()['user']
        headers = {'content-type': 'audio/wav', 'x-s2t-idempotency-key': 'memory-file-replay'}
        first = client.post('/api/transcriptions', content=payload, headers=headers)
        second = client.post('/api/transcriptions', content=iter([payload]), headers=headers)
        assert first.status_code == second.status_code == 200
        assert first.json() == second.json()
        assert len(calls) == 1
        rt = client.app.state.runtime
        labels = [*rt.user_labels(user), 'transcriptions']
        assert rt.usage['audio_bytes'].labels(*labels)._value.get() == len(payload)
        assert rt.usage['audio_seconds'].labels(*labels)._value.get() == 1
        assert rt.usage['model_executions'].labels(*labels)._value.get() == 1


@pytest.mark.parametrize('small_length', [False, True])
def test_client_disconnect_is_contained_and_budgets_are_released(client, admin, caplog, small_length):
    rt = client.app.state.runtime

    async def body():
        yield b'RIFF'
        raise ClientDisconnect()

    async def exercise():
        headers = {'authorization': 'Bearer ' + admin['token'], 'content-type': 'audio/wav'}
        if small_length:
            headers['content-length'] = '100'
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=client.app), base_url='http://testserver') as request:
            return await request.post('/api/transcriptions', headers=headers, content=body())
    assert client.portal.call(exercise).status_code == 499
    assert rt.http_gate.semaphore._value == 64
    assert rt.upload_gate.semaphore._value == 16
    assert not any(record.message == 'request failed' for record in caplog.records)
