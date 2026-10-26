import asyncio
import json
import multiprocessing
import os
import struct
import signal
from concurrent.futures import ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool

import anyio

from .admission import Gate
from .audio_engine import paths, run
from .core import fail


def initialize_worker(environment):
    if hasattr(os, "setsid"):
        os.setsid()
    os.environ.update(environment)
    os.environ["OMP_NUM_THREADS"] = environment.get("S2T_SHERPA_INFER_THREADS", "2")


class Audio:
    def __init__(self, settings, client):
        self.settings, self.client = settings, client
        self.remote = (
            settings.env.get("S2T_AUDIO_SERVICE_URL", "").rstrip("/")
            if settings.role == "api"
            else ""
        )
        self.pools, self.gates = {}, {}

    def profiles(self):
        result = []
        files = paths(self.settings.models)
        for model, available in [
            (
                "sherpa-onnx-speaker-diarization",
                files["segmentation"].is_file() and files["embedding"].is_file(),
            ),
            ("nemotron-3-diarization", files["nemo"].is_file() and files["runtime"].is_file()),
        ]:
            if available:
                result.append(
                    {
                        "id": "local-" + model,
                        "name": model,
                        "model": model,
                        "endpoint": "/api/diarizations",
                        "configured": True,
                    }
                )
        return result

    async def invoke(self, operation, filename=None, options=None):
        if self.remote:

            async def body():
                metadata = json.dumps(options or {}, ensure_ascii=True).encode()
                if len(metadata) > 2 * 1024**2:
                    fail(413, "Audio metadata too large")
                yield b"S2TA" + struct.pack(">I", len(metadata)) + metadata
                if filename:
                    async with await anyio.open_file(filename, "rb") as source:
                        while chunk := await source.read(256 * 1024):
                            yield chunk

            response = await self.client.post(
                self.remote + "/internal/audio/" + operation,
                headers={
                    "authorization": "Bearer "
                    + self.settings.env.get("S2T_AUDIO_SERVICE_TOKEN", ""),
                    "x-s2t-audio-protocol": "1",
                },
                content=body(),
                timeout=1900,
            )
            if not response.is_success:
                fail(503, "音訊服務暫時不可用")
            if operation in {"import", "transcode", "normalize"}:
                raise RuntimeError("Use convert_remote for binary operations")
            return response.json()
        role = (
            "light"
            if operation in {"vad", "health"}
            and (options or {}).get("model", "silero-vad") == "silero-vad"
            else "heavy"
        )
        if role not in self.gates:
            count = int(
                self.settings.env.get(
                    "S2T_AUDIO_LIGHT_WORKERS" if role == "light" else "S2T_AUDIO_HEAVY_WORKERS", 1
                )
            )
            if not 1 <= count <= 8:
                fail(503, "音訊 worker 數量必須為 1 至 8")
            self.gates[role] = Gate(count, waiting=32, timeout=15)
        # Gate ownership follows the native future, including browser cancellation.
        # No second task enters a busy worker or deletes its input prematurely.
        gate = self.gates[role]
        async with gate.enter():
            if role not in self.pools:
                count = int(
                    self.settings.env.get(
                        "S2T_AUDIO_LIGHT_WORKERS" if role == "light" else "S2T_AUDIO_HEAVY_WORKERS",
                        1,
                    )
                )
                self.pools[role] = ProcessPoolExecutor(
                    max_workers=count,
                    mp_context=multiprocessing.get_context("spawn"),
                    initializer=initialize_worker,
                    initargs=(self.settings.env,),
                )
            pool = self.pools[role]
            future = asyncio.get_running_loop().run_in_executor(
                pool,
                run,
                operation,
                str(filename) if filename else None,
                str(self.settings.models),
                options,
            )
            timeout = (
                float(
                    self.settings.env.get(
                        "S2T_AUDIO_LIGHT_JOB_TIMEOUT_MS"
                        if role == "light"
                        else "S2T_AUDIO_HEAVY_JOB_TIMEOUT_MS",
                        120000 if role == "light" else 1800000,
                    )
                )
                / 1000
            )
            try:
                return await asyncio.wait_for(asyncio.shield(future), timeout)
            except (asyncio.TimeoutError, BrokenProcessPool):
                self.retire(role, pool)
                await asyncio.gather(future, return_exceptions=True)
                fail(503, "音訊運算逾時或 worker 中斷，已重建程序池")
            except asyncio.CancelledError:
                with anyio.CancelScope(shield=True):
                    try:
                        await asyncio.wait_for(asyncio.shield(future), timeout)
                    except asyncio.TimeoutError:
                        self.retire(role, pool)
                        await asyncio.gather(future, return_exceptions=True)
                    except Exception:
                        pass
                raise

    def retire(self, role, pool):
        if self.pools.get(role) is pool:
            self.pools.pop(role)
        # CPython 3.12 has no public terminate_workers API. Snapshot only this
        # executor's children before shutdown; each worker owns its own process
        # group so a timed-out FFmpeg/Nemotron child is stopped as well.
        processes = list((pool._processes or {}).values())
        for process in processes:
            if process.is_alive():
                try:
                    if hasattr(os, "killpg") and os.getpgid(process.pid) == process.pid:
                        os.killpg(process.pid, signal.SIGKILL)
                    else:
                        process.kill()
                except ProcessLookupError:
                    pass
        pool.shutdown(wait=False, cancel_futures=True)

    async def convert(self, operation, filename, output):
        if not self.remote:
            result = await self.invoke(operation, filename)
            os.replace(result["path"], output)
            return

        async def body():
            async with await anyio.open_file(filename, "rb") as source:
                while chunk := await source.read(256 * 1024):
                    yield chunk

        async with self.client.stream(
            "POST",
            self.remote + "/internal/audio/" + operation,
            headers={
                "authorization": "Bearer " + self.settings.env.get("S2T_AUDIO_SERVICE_TOKEN", "")
            },
            content=body(),
            timeout=660,
        ) as response:
            if not response.is_success:
                fail(503, "音訊轉換服務暫時不可用")
            count = 0
            async with await anyio.open_file(output, "wb") as target:
                async for chunk in response.aiter_bytes(256 * 1024):
                    count += len(chunk)
                    if count > 2 * 1024**3:
                        fail(413, "轉換後音訊超過上限")
                    await target.write(chunk)

    async def close(self):
        for pool in self.pools.values():
            await anyio.to_thread.run_sync(lambda: pool.shutdown(wait=True, cancel_futures=True))
