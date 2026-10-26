import asyncio
import gzip
from contextlib import asynccontextmanager

from aiohttp import web
import httpx
import pytest

from app.model_http import ModelHttpClient
from app.models import multipart

pytestmark = pytest.mark.asyncio


@asynccontextmanager
async def upstream(handler):
    app = web.Application()
    app.router.add_route('*', '/{tail:.*}', handler)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, '127.0.0.1', 0)
    await site.start()
    try:
        yield f'http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}'
    finally:
        await runner.cleanup()


async def test_multipart_bytes_and_file_have_exact_length_and_gzip_response(tmp_path):
    seen = []
    async def handle(request):
        body = await request.read()
        seen.append((body, request.content_length))
        return web.Response(body=gzip.compress(b'{"text":"ok"}'), headers={'Content-Encoding':'gzip','Content-Type':'application/json'})

    data = b'\x01\x00' * 32000
    file = tmp_path / 'audio.wav'
    file.write_bytes(data)
    async with upstream(handle) as url, ModelHttpClient(2) as client:
        for source in (data, file):
            headers, body = await multipart(source, {'model':'sample'})
            response = await client.request('POST', url, headers=headers, content=body)
            assert response.json() == {'text':'ok'}
            received, length = seen[-1]
            if isinstance(source, bytes):
                assert len(received) == length == int(httpx.Headers(headers)['content-length'])
            else:
                assert length is None  # Large files retain chunked streaming.
            assert data in received
            assert b'name="model"\r\n\r\nsample' in received


async def test_cookies_are_never_replayed_and_redirects_are_not_followed():
    cookies, visits = [], []
    async def handle(request):
        visits.append(request.path)
        cookies.append(request.headers.get('Cookie'))
        if request.path == '/redirect':
            return web.Response(status=302, headers={'Location':'/unexpected'})
        return web.json_response({'ok':True}, headers={'Set-Cookie':'private=value; Path=/'})

    async with upstream(handle) as url, ModelHttpClient(2) as client:
        for _ in range(2):
            assert (await client.request('POST',url,headers={'Cookie':'explicit=secret'},json={'text':'測試'})).status_code == 200
        assert (await client.request('POST',url+'/redirect')).status_code == 302
    assert cookies == [None,None,None]
    assert visits == ['/','/','/redirect']


async def test_pool_is_bounded_and_recovers_after_timeout_and_cancellation():
    active, peak = 0, 0
    async def handle(request):
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        try:
            await asyncio.sleep(.06)
            return web.json_response({'ok':True})
        finally:
            active -= 1

    async with upstream(handle) as url, ModelHttpClient(2) as client:
        await asyncio.gather(*(client.request('POST',url) for _ in range(6)))
        assert peak == 2
        with pytest.raises(httpx.TimeoutException):
            await client.request('POST',url,timeout=.01)
        task = asyncio.create_task(client.request('POST',url))
        await asyncio.sleep(.01)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        await asyncio.sleep(.08)
        assert (await client.request('POST',url)).status_code == 200
        assert not client.session.connector._acquired


async def test_disconnected_post_is_not_automatically_retried():
    visits = 0
    async def handle(request):
        nonlocal visits
        visits += 1
        await request.read()
        request.transport.close()
        return web.Response()
    async with upstream(handle) as url, ModelHttpClient(2) as client:
        with pytest.raises(httpx.HTTPError):
            await client.request('POST',url,json={'text':'once'})
    assert visits == 1
