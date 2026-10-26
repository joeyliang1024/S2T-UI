"""Pooled native-parser HTTP transport for non-streaming model requests."""

import asyncio
import json

import aiohttp
import httpx


class ModelHttpClient:
    def __init__(self, maximum):
        self.maximum = maximum
        self.session = None

    async def __aenter__(self):
        self.session = aiohttp.ClientSession(
            connector=aiohttp.TCPConnector(limit=self.maximum, limit_per_host=self.maximum, keepalive_timeout=4),
            cookie_jar=aiohttp.DummyCookieJar(),
            trust_env=False,
            auto_decompress=False,
            json_serialize=lambda value: json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")),
        )
        return self

    async def __aexit__(self, *args):
        await self.session.close()

    async def request(self, method, url, *, headers=None, content=None, json=None, timeout=30):
        request = httpx.Request(method, url)
        options = {"data": content} if content is not None else {"json": json}
        try:
            async with self.session.request(
                method, url,
                headers={key: value for key, value in (headers or {}).items() if key.lower() != "cookie"},
                timeout=aiohttp.ClientTimeout(total=timeout, connect=min(timeout, 5), sock_connect=min(timeout, 5)),
                allow_redirects=False,
                **options,
            ) as response:
                # Preserve raw compressed bytes; httpx.Response handles the same
                # decompression and response contract used by the model layer.
                body = await response.read()
                return httpx.Response(response.status, headers=response.raw_headers, content=body, request=request)
        except asyncio.TimeoutError as error:
            raise httpx.TimeoutException("Model request deadline exceeded", request=request) from error
        except aiohttp.ClientConnectionError as error:
            raise httpx.ConnectError(type(error).__name__, request=request) from error
        except aiohttp.ClientError as error:
            raise httpx.ReadError(type(error).__name__, request=request) from error
