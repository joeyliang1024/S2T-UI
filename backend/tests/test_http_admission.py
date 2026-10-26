import asyncio
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest

from app.admission import Gate
from app.main import RequestMiddleware


def test_overload_queues_before_auth_and_does_not_block_liveness(client, admin, monkeypatch):
    rt = client.app.state.runtime
    rt.http_gate = Gate(1, waiting=1, timeout=2)
    entered, release = threading.Event(), threading.Event()
    auth_calls = []
    original = rt.auth.session

    async def authenticate(token):
        auth_calls.append(1)
        return await original(token)

    async def model(*args):
        entered.set()
        while not release.is_set():
            await asyncio.sleep(.005)
        return {'text': 'test'}, {'model': 1}

    monkeypatch.setattr(rt.auth, 'session', authenticate)
    monkeypatch.setattr(rt.models, 'translate', model)
    with ThreadPoolExecutor(3) as executor:
        first = executor.submit(client.post, '/api/translations', json={'text': 'first'})
        assert entered.wait(2)
        second = executor.submit(client.post, '/api/translations', json={'text': 'second'})
        try:
            async def waiting():
                for _ in range(100):
                    if rt.http_gate.waiting == 1:
                        return
                    await asyncio.sleep(.005)
                raise AssertionError('Second request did not queue')
            client.portal.call(waiting)
            rejected = client.post('/api/translations', json={'text': 'third'})
            assert rejected.status_code == 503
            assert len(auth_calls) == 1
            assert executor.submit(client.get, '/livez').result(timeout=1).status_code == 200
        finally:
            release.set()
        assert first.result(timeout=3).status_code == 200
        assert second.result(timeout=3).status_code == 200
    assert rt.http_gate.semaphore._value == 1
    assert rt.http_gate.waiting == 0


def test_cancelled_http_task_releases_active_budget(client):
    rt = client.app.state.runtime
    rt.http_gate = Gate(1)

    async def exercise():
        entered = asyncio.Event()

        async def held(scope, receive, send):
            entered.set()
            await asyncio.Event().wait()

        async def receive():
            return {'type': 'http.request', 'body': b''}

        async def send(message):
            pass

        scope = {'type': 'http', 'path': '/api/test', 'method': 'GET', 'app': client.app,
                 'headers': [(b'host', b'testserver')], 'state': {}}
        task = asyncio.create_task(RequestMiddleware(held)(scope, receive, send))
        await entered.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert rt.http_gate.semaphore._value == 1
        assert rt.http_gate.waiting == 0
    client.portal.call(exercise)


def test_background_http_wait_does_not_consume_realtime_budget(client, admin, monkeypatch):
    rt = client.app.state.runtime
    rt.http_gate, rt.background_http_gate = Gate(1), Gate(1)
    entered, release = threading.Event(), threading.Event()

    async def model(user, data, headers, temperature):
        if headers.get('x-s2t-workload') == 'background':
            entered.set()
            while not release.is_set():
                await asyncio.sleep(.005)
        return {'text': 'test'}, {'model': 1}

    monkeypatch.setattr(rt.models, 'translate', model)
    with ThreadPoolExecutor(2) as executor:
        background = executor.submit(client.post, '/api/translations', json={'text': 'background'}, headers={'x-s2t-workload': 'background'})
        try:
            assert entered.wait(2)
            realtime = executor.submit(client.post, '/api/translations', json={'text': 'live'})
            assert realtime.result(timeout=1).status_code == 200
        finally:
            release.set()
        assert background.result(timeout=2).status_code == 200
