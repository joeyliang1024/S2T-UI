"""Repeatable ASGI load probe with mock models; no external paid inference.

Use --postgres for a disposable real PostgreSQL. Results are backend-only,
not browser E2E or a Kubernetes capacity guarantee.
"""

import argparse
import asyncio
import json
import platform
import resource
import tempfile
import time
from pathlib import Path

import httpx

from app.main import create_app
from app.recordings import wav_header


async def measure(environment, requests, concurrency, model_delay):
    async def upstream(request):
        await request.aread()
        await asyncio.sleep(model_delay / 1000)
        return httpx.Response(200, json={"text": "benchmark", "language": "en"})

    app = create_app(environment, httpx.MockTransport(upstream))
    async with app.router.lifespan_context(app):
        rt = app.state.runtime
        user = await rt.auth.login({"username": "admin", "password": "admin"})
        token = rt.auth.issue(user)
        gate, samples, statuses, lags = asyncio.Semaphore(concurrency), [], {}, []
        stopping = asyncio.Event()

        async def heartbeat():
            while not stopping.is_set():
                start = time.perf_counter()
                await asyncio.sleep(0.01)
                lags.append(max(0, time.perf_counter() - start - 0.01) * 1000)

        clock = asyncio.create_task(heartbeat())
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app),
            base_url="http://benchmark",
            headers={"authorization": "Bearer " + token},
        ) as client:

            async def one(index):
                async with gate:
                    start = time.perf_counter()
                    response = await client.post(
                        "/api/transcriptions",
                        content=wav_header(32000, 16000) + b"\0\0" * 16000,
                        headers={
                            "content-type": "audio/wav",
                            "x-s2t-idempotency-key": f"benchmark-{index}",
                        },
                    )
                    samples.append((time.perf_counter() - start) * 1000)
                    statuses[str(response.status_code)] = (
                        statuses.get(str(response.status_code), 0) + 1
                    )

            began = time.perf_counter()
            await asyncio.gather(*(one(index) for index in range(requests)))
            elapsed = time.perf_counter() - began
        stopping.set()
        await clock

    def percentile(values, quantile):
        return sorted(values)[min(len(values) - 1, int(len(values) * quantile))] if values else 0

    rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return {
        "requests": requests,
        "concurrency": concurrency,
        "mock_model_ms": model_delay,
        "statuses": statuses,
        "seconds": round(elapsed, 3),
        "requests_per_second": round(requests / elapsed, 2),
        "successful_requests_per_second": round(statuses.get("200", 0) / elapsed, 2),
        "latency_ms": {
            "p50": round(percentile(samples, 0.5), 2),
            "p95": round(percentile(samples, 0.95), 2),
            "p99": round(percentile(samples, 0.99), 2),
        },
        "event_loop_lag_ms_p95": round(percentile(lags, 0.95), 2),
        "peak_rss_mib": round(rss / (1024**2 if platform.system() == "Darwin" else 1024), 2),
        "storage": "postgres" if environment.get("S2T_POSTGRES_HOST") else "local",
        "scope": "ASGI backend + real JWT/auth/upload/admission/idempotency; model mocked; excludes browser/network/Ingress/MinIO",
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--requests", type=int, default=500)
    parser.add_argument("--concurrency", type=int, default=100)
    parser.add_argument("--model-delay-ms", type=int, default=500)
    parser.add_argument("--postgres", action="store_true")
    parser.add_argument("--output")
    args = parser.parse_args()
    server = None
    with tempfile.TemporaryDirectory(
        prefix="s2t-bench-", dir="/private/tmp" if Path("/private/tmp").exists() else None
    ) as directory:
        environment = {
            "S2T_DATA_DIR": directory + "/data",
            "S2T_PROCESS_ROLE": "api",
            "S2T_ALLOW_DEFAULT_ADMIN": "true",
            "S2T_AUTH_SECRET": "isolated-performance-test-secret-123456",
            "S2T_ASR_ENDPOINT": "http://mock/v1",
            "S2T_ASR_MODEL": "benchmark",
            "S2T_ASR_API_KEY": "test-only",
            "S2T_ASR_REQUESTS_PER_MINUTE": "100000",
            "S2T_ASR_MAX_INFLIGHT": "128",
        }
        if args.postgres:
            import pgserver
            import fasteners
            from psycopg.conninfo import conninfo_to_dict

            pgserver.PostgresServer.runtime_path = Path(directory)
            pgserver.PostgresServer._lock = fasteners.InterProcessLock(Path(directory) / "pg.lock")
            server = pgserver.get_server(Path(directory) / "pgdata", cleanup_mode="delete")
            connection = conninfo_to_dict(server.get_uri())
            environment.update(
                S2T_POSTGRES_HOST=connection["host"],
                S2T_POSTGRES_PORT=connection.get("port", "5432"),
                S2T_POSTGRES_DB_NAME="postgres",
                S2T_POSTGRES_USER="postgres",
                S2T_POSTGRES_PASSWORD="test-only",
            )
        try:
            import uvloop

            result = uvloop.run(
                measure(environment, args.requests, args.concurrency, args.model_delay_ms)
            )
            print(json.dumps(result, ensure_ascii=False, indent=2))
            if args.output:
                Path(args.output).write_text(
                    json.dumps(result, ensure_ascii=False, indent=2) + "\n"
                )
        finally:
            if server:
                server.cleanup()


if __name__ == "__main__":
    main()
