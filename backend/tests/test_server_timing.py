import asyncio

import pytest


@pytest.mark.parametrize('route', ['/api/transcriptions', '/api/translations'])
def test_total_timing_includes_authentication_and_rate_checks(client, admin, monkeypatch, route):
    runtime = client.app.state.runtime
    original = runtime.auth.session

    async def authenticate(token):
        await asyncio.sleep(.04)
        return await original(token)

    async def rate(*args, **kwargs):
        await asyncio.sleep(.04)

    async def model(*args, **kwargs):
        await asyncio.sleep(.01)
        return {'text': 'test'}, {'model': 10}

    monkeypatch.setattr(runtime.auth, 'session', authenticate)
    monkeypatch.setattr(runtime.admission, 'window', rate)
    monkeypatch.setattr(runtime.models, 'transcribe' if route.endswith('transcriptions') else 'translate', model)
    response = (client.post(route, content=b'RIFF', headers={'content-type': 'audio/wav'})
                if route.endswith('transcriptions') else client.post(route, json={'text': 'test'}))
    assert response.status_code == 200
    timing = dict((part.split(';dur=')[0].strip(), float(part.split(';dur=')[1]))
                  for part in response.headers['server-timing'].split(','))
    assert timing['auth'] >= 35
    assert timing['rate'] >= 35
    assert timing['total'] >= timing['auth'] + timing['rate'] + timing['model'] - 1
