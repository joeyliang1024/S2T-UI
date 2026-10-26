"""Web contracts implemented by Python; no legacy forwarding or Node runtime."""

import re
import json
import struct
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path

import anyio
from starlette.responses import FileResponse

from .core import fail, read_body


def runtime(request):
    return request.app.state.runtime


async def user_of(request, roles=None):
    if not hasattr(request.state, "user"):
        token = request.headers.get("authorization", "")
        token = (
            re.sub(r"^Bearer\s+", "", token, flags=re.I)
            if token
            else request.cookies.get("s2t_auth", "")
        )
        request.state.user = await runtime(request).auth.session(token)
        request.state.token = token
    user = request.state.user
    if not user:
        fail(401, "需要登入")
    if roles and user["role"] not in roles:
        fail(403, "沒有操作此功能的權限")
    return user


async def rate(request, user, bucket, maximum):
    rt = runtime(request)
    variable = {
        "asr": "S2T_ASR_REQUESTS_PER_MINUTE",
        "translation": "S2T_TRANSLATION_REQUESTS_PER_MINUTE",
        "vad": "S2T_VAD_REQUESTS_PER_MINUTE",
    }.get(bucket)
    maximum = int(rt.settings.env.get(variable, maximum)) if variable else maximum
    await rt.admission.window(user["id"], bucket, maximum)


@asynccontextmanager
async def staged(request, maximum):
    with tempfile.TemporaryDirectory(prefix="s2t-upload-") as directory:
        path = Path(directory) / "input.audio"
        await write_upload(request, path, maximum)
        yield path


@asynccontextmanager
async def transcription_source(request, maximum=100 * 1024**2):
    # Normal live chunks are small. Bound memory by both Content-Length and
    # the actual body; large/chunked uploads and normalization retain files.
    declared = request.headers.get("content-length", "")
    memory_limit = 256 * 1024
    if declared.isdigit() and 0 < int(declared) <= memory_limit and request.headers.get("x-s2t-dynaudnorm") != "true":
        body = await read_body(request, memory_limit)
        if not body:
            fail(400, "音訊不可為空")
        yield body
    else:
        async with staged(request, maximum) as filename:
            yield filename


async def write_upload(request, path, maximum):
    async with runtime(request).upload_gate.enter():
        return await _write_upload(request, path, maximum)


async def _write_upload(request, path, maximum):
    declared = request.headers.get("content-length")
    if declared and (not declared.isdigit() or int(declared) > maximum):
        fail(413, "音訊超過大小上限")
    await write_stream(request.stream(), path, maximum)


async def write_stream(stream, path, maximum):
    count = 0
    async with await anyio.open_file(path, "wb") as output:
        async for chunk in stream:
            count += len(chunk)
            if count > maximum:
                fail(413, "音訊超過大小上限")
            await output.write(chunk)
    if not count:
        fail(400, "音訊不可為空")


async def audio_payload(request):
    if request.headers.get("x-s2t-audio-protocol") != "1":
        return {}, request.stream()
    iterator = request.stream().__aiter__()
    pending = bytearray()

    async def fill(size):
        while len(pending) < size:
            try:
                chunk = await anext(iterator)
            except StopAsyncIteration:
                fail(400, "Truncated audio metadata")
            pending.extend(chunk)

    await fill(8)
    if pending[:4] != b"S2TA":
        fail(400, "Invalid audio protocol")
    size = struct.unpack_from(">I", pending, 4)[0]
    if size > 2 * 1024**2:
        fail(413, "Audio metadata too large")
    await fill(8 + size)
    try:
        options = json.loads(pending[8 : 8 + size])
    except ValueError:
        fail(400, "Invalid audio metadata")
    if not isinstance(options, dict):
        fail(400, "Invalid audio metadata")

    async def stream():
        if len(pending) > 8 + size:
            yield bytes(pending[8 + size :])
        async for chunk in iterator:
            yield chunk

    return options, stream()


class TemporaryFileResponse(FileResponse):
    def __init__(self, path, directory, media_type):
        self.directory = directory
        super().__init__(path, media_type=media_type, headers={"cache-control": "no-store"})

    async def __call__(self, scope, receive, send):
        try:
            await super().__call__(scope, receive, send)
        finally:
            self.directory.cleanup()
