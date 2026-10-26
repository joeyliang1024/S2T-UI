"""Independent Python Web backend. No Node/legacy process is started or called."""

import asyncio
import io
import hmac
import logging
import math
import os
import re
import tempfile
import time
import uuid
import wave
from contextlib import AsyncExitStack, asynccontextmanager
from pathlib import Path

import httpx
import anyio
from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import ORJSONResponse
from prometheus_client import CollectorRegistry, Counter, Gauge, Histogram
from starlette.requests import ClientDisconnect
from starlette.responses import JSONResponse, Response
from starlette.exceptions import HTTPException as StarletteHTTPException

from .admission import Admission, Gate
from .api import TemporaryFileResponse, router, user_of
from .audio import Audio
from .auth import Auth
from .core import Settings, fail, integer
from .jobs import Jobs
from .models import Models
from .recordings import Compensation, Recordings
from .storage import Storage
from .voiceprints import Voiceprints
from .http_common import audio_payload, write_stream

CAPTION_STAGES = set(
    "phase_t1 phase_t2 phase_t3 phase_t4 phase_t5 phase_t6 phase_t7 e2e_asr e2e_translation e2e_translation_tail t1_queue t1_encode t1_upload t2_vad t2_segment t2_gate t3_queue t3_preprocess t3_model t3_gateway t4_postprocess t5_network t5_paint t6_wait t6_queue t6_model t6_gateway t7_network t7_paint".split()
)


class StatelessClient(httpx.AsyncClient):
    def build_request(self, *args, **kwargs):
        request = super().build_request(*args, **kwargs)
        request.headers.pop("cookie", None)
        return request


class Runtime:
    def __init__(self, settings):
        self.settings, self.logger = settings, logging.getLogger("s2t")
        self.storage, self.admission = Storage(settings), Admission(settings)
        self.auth = Auth(self.storage, settings)
        self.health_gate = Gate(8)
        active_requests = int(settings.env.get("S2T_HTTP_ACTIVE_PER_WORKER", 64))
        if not 1 <= active_requests <= 512:
            raise ValueError("S2T_HTTP_ACTIVE_PER_WORKER must be in 1..512")
        self.http_gate = Gate(active_requests, waiting=int(settings.env.get("S2T_HTTP_MAX_WAITING", 512)), timeout=10)
        self.background_http_gate = Gate(4, waiting=128, timeout=10)
        self.metric_limiter = anyio.CapacityLimiter(1)
        self.upload_gate = Gate(
            16, waiting=int(settings.env.get("S2T_HTTP_MAX_WAITING", 512)), timeout=15
        )
        self.registry = CollectorRegistry()
        self.requests = Counter(
            "s2t_http_requests_total",
            "HTTP requests",
            ["method", "path", "status"],
            registry=self.registry,
        )
        self.responses = Counter(
            "s2t_http_responses_total",
            "Compatible HTTP responses",
            ["route", "method", "status"],
            registry=self.registry,
        )
        from .metrics import configure_metrics

        self.sample_runtime = configure_metrics(self.registry)
        self.gateway_latency = Histogram(
            "s2t_gateway_request_duration_seconds",
            "HTTP duration including response streaming",
            ["route"],
            registry=self.registry,
            buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 600),
        )
        self.gateway_errors = Counter(
            "s2t_gateway_request_errors_total",
            "HTTP responses with status >= 400",
            ["route"],
            registry=self.registry,
        )
        self.latency = Histogram(
            "s2t_http_request_duration_seconds",
            "HTTP duration",
            ["method", "path"],
            buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 600),
            registry=self.registry,
        )
        self.inflight = Gauge(
            "s2t_gateway_inflight_requests", "Active HTTP requests", registry=self.registry, multiprocess_mode="livesum"
        )
        self.stages = Histogram(
            "s2t_server_stage_duration_seconds", "Backend stages", ["stage"], registry=self.registry
        )
        self.caption = Histogram(
            "s2t_caption_stage_duration_seconds",
            "Browser caption latency",
            ["stage", "phase"],
            buckets=(
                0.025,
                0.05,
                0.1,
                0.15,
                0.25,
                0.4,
                0.6,
                0.8,
                1,
                1.2,
                1.5,
                2,
                2.5,
                3,
                4,
                5,
                8,
                12,
                20,
                30,
                60,
                120,
                300,
            ),
            registry=self.registry,
        )
        self.caption_phase = Histogram(
            "s2t_caption_phase_duration_seconds",
            "Browser phase duration",
            ["stage", "phase"],
            registry=self.registry,
        )
        self.events = Counter(
            "s2t_caption_events_total", "Caption events", ["event"], registry=self.registry
        )
        self.user_requests = Counter(
            "s2t_user_requests_total",
            "Requests by account",
            ["user_id", "nt", "department", "operation", "outcome"],
            registry=self.registry,
        )
        self.journey = Counter(
            "s2t_user_journey_events_total",
            "Usage journey",
            ["user_id", "nt", "department", "stage"],
            registry=self.registry,
        )
        fields = "request_seconds model_executions audio_bytes audio_seconds audio_duration_unknown input_characters output_characters input_tokens output_tokens token_usage_missing".split()
        self.usage = {
            field: Counter(
                "s2t_user_" + field + "_total",
                field,
                ["user_id", "nt", "department", "operation"],
                registry=self.registry,
            )
            for field in fields
        }
        self.backlog = Gauge(
            "s2t_diarization_pending_jobs", "Durable job backlog", registry=self.registry, multiprocess_mode="livemostrecent"
        )
        self.backlog_seconds = Gauge(
            "s2t_diarization_pending_audio_seconds",
            "Durable queued audio seconds",
            registry=self.registry,
            multiprocess_mode="livemostrecent",
        )
        self.storage_latency = Histogram(
            "s2t_storage_operation_duration_seconds",
            "Storage latency",
            ["service", "operation", "outcome"],
            registry=self.registry,
        )
        self.storage.observe = lambda operation, outcome, duration: self.storage_latency.labels(
            self.storage.mode[operation.split(".")[0]], operation.split(".")[1], outcome
        ).observe(duration)
        self.users, self.ready = set(), False

    def user_labels(self, user):
        if user["id"] not in self.users and len(self.users) >= 10000:
            return ["__overflow__", "overflow", "overflow"]
        first = user["id"] not in self.users
        self.users.add(user["id"])
        labels = [user["id"], user.get("NT", ""), user.get("Department", "")]
        if first:
            # Publish zero before the user's first recording. Otherwise a new
            # counter first scraped at 1 has no baseline for increase().
            for stage in ("L1", "L2", "L3"):
                self.journey.labels(*labels, stage).inc(0)
        return labels

    def observe_model(self, user, operation, result, timing):
        for stage, milliseconds in timing.items():
            self.stages.labels(operation + "_" + stage).observe(milliseconds / 1000)

    def observe_execution(self, user, operation, output="", input="", usage=None, audio=None):
        labels = [*self.user_labels(user), operation]
        self.usage["model_executions"].labels(*labels).inc()
        self.usage["input_characters"].labels(*labels).inc(len(input))
        self.usage["output_characters"].labels(*labels).inc(len(output))
        if audio:
            self.usage["audio_bytes"].labels(*labels).inc(len(audio) if isinstance(audio, bytes) else Path(audio).stat().st_size)
            try:
                with wave.open(io.BytesIO(audio) if isinstance(audio, bytes) else str(audio), "rb") as source:
                    self.usage["audio_seconds"].labels(*labels).inc(
                        source.getnframes() / source.getframerate()
                    )
            except (wave.Error, EOFError):
                self.usage["audio_duration_unknown"].labels(*labels).inc()
        if operation in {"translations", "summaries"}:
            if (
                usage
                and integer(usage.get("prompt_tokens"))
                and integer(usage.get("completion_tokens"))
            ):
                self.usage["input_tokens"].labels(*labels).inc(usage["prompt_tokens"])
                self.usage["output_tokens"].labels(*labels).inc(usage["completion_tokens"])
            else:
                self.usage["token_usage_missing"].labels(*labels).inc()

    def observe_telemetry(self, user, kind, data):
        if kind == "journey":
            if data.get("stage") not in {"L1", "L2", "L3"}:
                fail(400, "Invalid journey stage")
            self.journey.labels(*self.user_labels(user), data["stage"]).inc()
            return
        samples, events = data.get("samples"), data.get("events", {})
        if (
            not isinstance(samples, list)
            or len(samples) > 128
            or not isinstance(events, dict)
            or not samples
            and not events
        ):
            fail(400, "Invalid caption measurements")
        for sample in samples:
            seconds = sample.get("seconds") if isinstance(sample, dict) else None
            if (
                not isinstance(sample, dict)
                or sample.get("stage") not in CAPTION_STAGES
                or type(seconds) not in {int, float}
                or not math.isfinite(seconds)
                or not 0 <= seconds <= 300
            ):
                fail(400, "Invalid caption measurements")
        allowed = set(
            "speech_detected asr_empty asr_failed audio_gap silero_veto silero_failed telemetry_dropped".split()
        )
        if any(key not in allowed or not integer(value, 0, 1000) for key, value in events.items()):
            fail(400, "Invalid caption events")
        for sample in samples:
            stage = sample["stage"]
            phase = (
                stage[6:]
                if stage.startswith("phase_")
                else stage[:2]
                if stage.startswith("t")
                else "e2e"
            )
            (self.caption_phase if stage.startswith("phase_") else self.caption).labels(
                stage, phase
            ).observe(sample["seconds"])
        for event, count in events.items():
            self.events.labels(event).inc(count)


class RequestMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        rt = scope["app"].state.runtime
        started, status = time.monotonic(), 500
        origin_allowed = False
        headers, path = dict(scope.get("headers", [])), scope["path"]
        request_id = headers.get(b"x-request-id", b"").decode(errors="ignore")
        if not re.fullmatch(r"[A-Za-z0-9._:-]{8,64}", request_id):
            request_id = str(uuid.uuid4())
        rt.inflight.inc()
        gate_context = None
        scope.setdefault("state", {})["request_started_at"] = started

        async def outgoing(message):
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
                message["headers"] = list(message.get("headers", [])) + [
                    (b"x-request-id", request_id.encode())
                ]
                if not any(key.lower() == b"cache-control" for key, value in message["headers"]):
                    message["headers"].append((b"cache-control", b"no-store"))
                origin = headers.get(b"origin")
                if origin and origin_allowed:
                    message["headers"] += [
                        (b"access-control-allow-origin", origin),
                        (b"access-control-allow-credentials", b"true"),
                        (
                            b"access-control-expose-headers",
                            b"x-request-id,retry-after,server-timing",
                        ),
                        (b"vary", b"Origin"),
                    ]
            await send(message)

        try:
            if path.startswith("/api/"):
                origin, host = (
                    headers.get(b"origin", b"").decode(),
                    headers.get(b"host", b"").decode(),
                )
                allowed = {
                    value.strip()
                    for value in rt.settings.env.get(
                        "S2T_WEB_ORIGINS", rt.settings.env.get("S2T_ALLOWED_ORIGINS", "")
                    ).split(",")
                    if value.strip()
                }
                if origin and origin not in {"http://" + host, "https://" + host} | allowed:
                    return await JSONResponse({"error": "Origin is not allowed"}, status_code=403)(
                        scope, receive, outgoing
                    )
                if scope["method"] == "OPTIONS":
                    allowed_headers = "authorization,content-type,content-encoding,x-request-id,x-s2t-workload,x-s2t-language,x-s2t-model-id,x-s2t-diarization-model,x-s2t-prompt,x-s2t-filename,x-s2t-dynaudnorm,x-s2t-voiceprint-sharing,x-s2t-voiceprint-consent,x-s2t-idempotency-key,x-s2t-start-sample,x-s2t-sample-rate,x-s2t-speaker-embeddings"
                    return await Response(
                        status_code=204,
                        headers={
                            "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
                            "access-control-allow-headers": allowed_headers,
                        },
                    )(scope, receive, outgoing)
                origin_allowed = True
                # Bound active work before JWT/database access. Waiting is cheap
                # and background jobs cannot fill the realtime request budget.
                gate = rt.background_http_gate if headers.get(b"x-s2t-workload") == b"background" else rt.http_gate
                manager = gate.enter()
                queued = time.monotonic()
                await manager.__aenter__()
                gate_context = manager
                scope["state"]["http_queue_ms"] = (time.monotonic()-queued)*1000
                fenced = (
                    path.startswith(("/api/data/", "/api/voiceprints"))
                    and (
                        scope["method"] not in {"GET", "HEAD"}
                        or path.startswith("/api/data/audio/")
                    )
                    and path not in {"/api/data/model-health", "/api/data/model-test"}
                )
                if fenced:
                    try:
                        user = await user_of(Request(scope, receive=receive))
                        async with rt.storage.account_guard(user["id"]):
                            return await self.app(scope, receive, outgoing)
                    except HTTPException as error:
                        return await JSONResponse(
                            {"error": error.detail},
                            status_code=error.status_code,
                            headers=error.headers,
                        )(scope, receive, outgoing)
                if (
                    path
                    in {
                        "/api/transcriptions",
                        "/api/translations",
                        "/api/summaries",
                        "/api/diarizations",
                    }
                    and headers.get(b"x-s2t-workload") == b"background"
                ):
                    async with rt.admission.capacity("background"):
                        return await self.app(scope, receive, outgoing)
            await self.app(scope, receive, outgoing)
        except HTTPException as error:
            await JSONResponse(
                {"error": error.detail}, status_code=error.status_code, headers=error.headers
            )(scope, receive, outgoing)
        finally:
            if gate_context is not None:
                with anyio.CancelScope(shield=True):
                    await gate_context.__aexit__(None, None, None)
            label = getattr(scope.get("route"), "path", "/other")
            rt.requests.labels(scope["method"], label, str(status)).inc()
            response_route = (
                path[5:]
                if path
                in {
                    "/api/transcriptions",
                    "/api/translations",
                    "/api/summaries",
                    "/api/diarizations",
                }
                else "recording_chunk"
                if re.fullmatch(r"/api/data/recordings/[^/]+/chunks/[^/]+", path)
                else "live_draft"
                if path == "/api/data/live-draft"
                else "other"
            )
            rt.responses.labels(response_route, scope["method"], str(status)).inc()
            if not path.startswith(("/metrics", "/readyz", "/livez")):
                rt.gateway_latency.labels(response_route).observe(time.monotonic() - started)
                # Initialize zero-error series too: healthy services must not render No data.
                rt.gateway_errors.labels(response_route).inc(int(status >= 400))
            rt.latency.labels(scope["method"], label).observe(time.monotonic() - started)
            rt.inflight.dec()
            user = scope.get("state", {}).get("user")
            if user:
                operation = label.removeprefix("/api/")
                if operation == "data/{kind}":
                    kind = scope.get("path_params", {}).get("kind")
                    operation = (
                        "data/" + kind
                        if kind
                        in {
                            "settings",
                            "glossary",
                            "sessions",
                            "live-draft",
                            "import-checkpoint",
                            "model-registry",
                            "model-health",
                            "model-test",
                            "summary-templates",
                            "diarization-jobs",
                            "storage-status",
                            "storage-retry",
                            "storage-audit",
                        }
                        else "other"
                    )
                rt.user_requests.labels(
                    *rt.user_labels(user),
                    operation,
                    "success"
                    if status < 400
                    else "client_error"
                    if status < 500
                    else "server_error",
                ).inc()
                rt.usage["request_seconds"].labels(*rt.user_labels(user), operation).inc(
                    time.monotonic() - started
                )


def create_app(environment=None, transport=None):
    settings = Settings(environment)
    rt = Runtime(settings)

    @asynccontextmanager
    async def lifespan(app):
        settings.initialize_files()
        async with AsyncExitStack() as stack:
            clients = {}
            for role, maximum in [
                ("asr", 128),
                ("translation", 64),
                ("summary", 16),
                ("diarization", 8),
                ("health", 8),
                ("audio", 16),
                ("storage", 16),
            ]:
                if transport is None and role in {"asr", "translation"}:
                    from .model_http import ModelHttpClient
                    clients[role] = await stack.enter_async_context(ModelHttpClient(maximum))
                    continue
                clients[role] = await stack.enter_async_context(
                    StatelessClient(
                        transport=transport,
                        trust_env=False,
                        follow_redirects=False,
                        timeout=httpx.Timeout(30, connect=5, pool=5),
                        limits=httpx.Limits(
                            max_connections=maximum,
                            max_keepalive_connections=maximum,
                            keepalive_expiry=4,
                        ),
                    )
                )
            rt.audio = Audio(settings, clients["audio"])
            stack.push_async_callback(rt.audio.close)
            rt.models = Models(settings, rt.storage, rt.auth, rt.audio, rt.admission, clients)
            rt.models.observe_execution = rt.observe_execution
            rt.voiceprints = Voiceprints(rt.storage, settings, rt.audio, clients["storage"])
            rt.recordings, rt.compensation = (
                Recordings(rt.storage),
                Compensation(rt.storage, settings),
            )
            rt.jobs = Jobs(rt.storage, rt.auth, rt.models, rt.voiceprints, rt.admission)
            if settings.role != "audio-service":
                stack.push_async_callback(rt.storage.close)
                await rt.storage.open()
                stack.push_async_callback(rt.admission.close)
                await rt.admission.open()
                await rt.auth.open()
            if (
                settings.distributed
                and settings.role in {"api", "audio-service"}
                and not settings.env.get("S2T_AUDIO_SERVICE_TOKEN")
            ):
                raise ValueError("分散式音訊服務必須設定內部 token")
            if settings.distributed and settings.role == "api" and not rt.audio.remote:
                raise ValueError("API Pod 必須設定 S2T_AUDIO_SERVICE_URL")
            worker = (
                asyncio.create_task(rt.jobs.loop())
                if settings.role in {"all", "audio-worker"}
                else None
            )

            async def maintenance():
                while True:
                    # Spread maintenance across workers/Pods instead of making
                    # every worker compete for the same expiry batch at once.
                    import random
                    await asyncio.sleep(random.uniform(5, 10))
                    try:
                        await rt.storage.prune_requests()
                    except Exception:
                        rt.logger.warning("request lease cleanup deferred")

            cleaner = (
                asyncio.create_task(maintenance()) if settings.role != "audio-service" else None
            )
            sampler = asyncio.create_task(rt.sample_runtime())
            rt.ready = True
            try:
                yield
            finally:
                rt.ready = False
                sampler.cancel()
                await asyncio.gather(sampler, return_exceptions=True)
                if cleaner:
                    cleaner.cancel()
                    await asyncio.gather(cleaner, return_exceptions=True)
                if worker:
                    rt.jobs.stopping.set()
                    try:
                        await asyncio.wait_for(asyncio.shield(worker), 45)
                    except asyncio.TimeoutError:
                        worker.cancel()
                    await asyncio.gather(worker, return_exceptions=True)

    app = FastAPI(
        title="S2T Web API",
        lifespan=lifespan,
        default_response_class=ORJSONResponse,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.state.runtime = rt
    app.add_middleware(RequestMiddleware)

    @app.exception_handler(StarletteHTTPException)
    async def http_error(request, error):
        return JSONResponse(
            {"error": error.detail}, status_code=error.status_code, headers=error.headers
        )

    @app.exception_handler(RequestValidationError)
    async def validation_error(request, error):
        return JSONResponse({"error": "請求參數格式無效"}, status_code=400)

    @app.exception_handler(ClientDisconnect)
    async def disconnected(request, error):
        # Client cancellation during upload is expected; avoid traceback storms.
        return Response(status_code=499)

    @app.exception_handler(Exception)
    async def unavailable(request, error):
        rt.logger.exception("request failed", extra={"path": request.url.path})
        return JSONResponse({"error": "服務暫時不可用，請稍後重試"}, status_code=503)

    @app.get("/livez")
    async def live():
        return {"live": True, "alive": True, "role": settings.role}

    @app.get("/readyz")
    async def ready():
        if not rt.ready:
            fail(503, "服務尚未就緒")
        try:
            if settings.role != "audio-service":
                probes = [rt.storage.health()]
                if rt.admission.redis:
                    probes.append(rt.admission.redis.ping())
                await asyncio.wait_for(asyncio.gather(*probes), 3)
            return {"ready": True, "role": settings.role, "storage": rt.storage.mode}
        except Exception:
            fail(503, "共享儲存或 Redis 尚未就緒")

    @app.get("/metrics")
    @app.get("/metrics/runtime")
    @app.get("/metrics/users")
    @app.get("/metrics/performance")
    async def metrics():
        if settings.role != "audio-service":
            try:
                if rt.storage.pool:
                    async with rt.storage.pool.connection(timeout=1) as connection:
                        row = await (
                            await connection.execute(
                                "SELECT count(*),coalesce(sum(coalesce((payload->>'audioSeconds')::float,60)),0) FROM s2t_diarization_jobs WHERE state IN ('queued','running')"
                            )
                        ).fetchone()
                        rt.backlog.set(row[0])
                        rt.backlog_seconds.set(row[1])
                else:
                    jobs = (await rt.storage.get("diarization-system", "jobs") or {}).get(
                        "jobs", []
                    )
                    pending = [job for job in jobs if job["state"] in {"queued", "running"}]
                    rt.backlog.set(len(pending))
                    rt.backlog_seconds.set(
                        sum(job.get("payload", {}).get("audioSeconds", 60) for job in pending)
                    )
            except Exception:
                rt.logger.warning("backlog metrics temporarily stale")
        snapshot = os.environ.get("S2T_METRICS_SNAPSHOT")
        if snapshot:
            from .metrics_exporter import read_snapshot
            try:
                payload = await anyio.to_thread.run_sync(read_snapshot, snapshot, limiter=rt.metric_limiter)
            except (OSError, TimeoutError):
                fail(503, "監控指標尚未就緒，請稍後重試")
        else:
            from .metrics import export_metrics
            payload = await anyio.to_thread.run_sync(export_metrics, rt.registry, limiter=rt.metric_limiter)
        return Response(payload, media_type="text/plain; version=0.0.4")

    if settings.role in {"all", "api"}:
        app.include_router(router)

    if settings.role == "audio-service":

        @app.post("/internal/audio/{operation}")
        async def internal_audio(operation: str, request: Request):
            expected = settings.env.get("S2T_AUDIO_SERVICE_TOKEN", "")
            actual = request.headers.get("authorization", "").removeprefix("Bearer ")
            if not expected or not hmac.compare_digest(actual.encode(), expected.encode()):
                fail(401, "Internal authentication required")
            if operation not in {
                "vad",
                "health",
                "embedding",
                "speaker-embeddings",
                "diarize",
                "import",
                "transcode",
                "normalize",
            }:
                fail(404, "Unknown audio operation")
            options, stream = await audio_payload(request)
            if operation == "health":
                return await rt.audio.invoke(operation, options=options)
            directory = tempfile.TemporaryDirectory(prefix="s2t-internal-")
            source, target = Path(directory.name) / "input", Path(directory.name) / "output"
            try:
                async with rt.upload_gate.enter():
                    await write_stream(
                        stream, source, 2 * 1024**3 if operation == "import" else 500 * 1024**2
                    )
                if operation in {"import", "transcode", "normalize"}:
                    await rt.audio.convert(operation, source, target)
                    return TemporaryFileResponse(
                        target, directory, "audio/mp4" if operation == "transcode" else "audio/wav"
                    )
                value = await rt.audio.invoke(operation, source, options)
                directory.cleanup()
                return value
            except BaseException:
                directory.cleanup()
                raise

    return app


def app_factory():
    from dotenv import load_dotenv

    load_dotenv(Path(__file__).resolve().parents[1] / ".env", override=False)
    return create_app()
