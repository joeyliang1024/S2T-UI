"""Loopback client CPU benchmark; excludes inference and production capacity."""

import argparse
import asyncio
import json
import multiprocessing
import time


def serve(queue):
    from aiohttp import web

    async def run():
        async def handle(request):
            await request.read()
            return web.json_response({'text': 'Performance caption.'})
        app = web.Application()
        app.router.add_post('/', handle)
        runner = web.AppRunner(app, access_log=None)
        await runner.setup()
        site = web.TCPSite(runner, '127.0.0.1', 0)
        await site.start()
        queue.put(site._server.sockets[0].getsockname()[1])
        await asyncio.Event().wait()
    asyncio.run(run())


async def measure(kind, url, count, concurrent):
    import httpx
    from model_http import ModelHttpClient

    client = (ModelHttpClient(concurrent) if kind == 'aiohttp' else httpx.AsyncClient(
        trust_env=False, limits=httpx.Limits(max_connections=concurrent, max_keepalive_connections=concurrent, keepalive_expiry=4)))
    payload = b'\x01\x00' * 32000
    async with client:
        for _ in range(20):
            assert (await client.request('POST', url, content=payload)).json()['text']
        next_item = 0
        async def worker():
            nonlocal next_item
            while next_item < count:
                index = next_item
                next_item += 1
                response = await client.request('POST', url, **({'content':payload} if index % 2 else {'json':{'text':'Performance caption.'}}))
                assert response.status_code == 200 and response.json()['text']
        wall, cpu = time.perf_counter(), time.process_time()
        await asyncio.gather(*(worker() for _ in range(concurrent)))
        return {'client':kind,'requests':count,'concurrency':concurrent,'wallSeconds':time.perf_counter()-wall,'clientCpuSeconds':time.process_time()-cpu}


def main():
    args = argparse.ArgumentParser()
    args.add_argument('--requests',type=int,default=2000)
    args.add_argument('--concurrency',type=int,default=32)
    parsed = args.parse_args()
    if not 1 <= parsed.concurrency <= 128 or not 100 <= parsed.requests <= 100000:
        raise ValueError('Invalid benchmark size')
    context = multiprocessing.get_context('spawn')
    queue = context.Queue()
    server = context.Process(target=serve,args=(queue,))
    server.start()
    try:
        url = f'http://127.0.0.1:{queue.get(timeout=15)}/'
        results = [asyncio.run(measure(kind,url,parsed.requests,parsed.concurrency)) for kind in ('httpx','aiohttp','aiohttp','httpx')]
        cpu = {kind:sum(row['clientCpuSeconds'] for row in results if row['client']==kind)/2 for kind in ('httpx','aiohttp')}
        print(json.dumps({'scope':'Loopback, separate upstream process, zero inference delay; alternating 64 KB audio and small JSON; client CPU only. Not a 500-user capacity test.','runs':results,'meanClientCpuSeconds':cpu,'cpuReductionFraction':1-cpu['aiohttp']/cpu['httpx']},indent=2))
    finally:
        server.terminate()
        server.join(timeout=5)
        if server.is_alive():
            server.kill()
            server.join()
        queue.close()


if __name__ == '__main__':
    main()
