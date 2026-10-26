"""Web contracts implemented by Python; no legacy forwarding or Node runtime."""

import asyncio
import re
import tempfile
import time
from contextlib import asynccontextmanager
from pathlib import Path

import anyio
from fastapi import APIRouter, Request
from starlette.responses import JSONResponse, Response, StreamingResponse

from ..core import admin_parameters, fail, read_body, read_json, safe

router = APIRouter()

from ..http_common import runtime, user_of, rate, staged, transcription_source, write_upload, TemporaryFileResponse
from ..recordings import audio_blob_key


@router.api_route("/api/data/recordings/{recording_id}", methods=["GET", "DELETE"])
@router.api_route("/api/data/recordings/{recording_id}/{action}", methods=["POST"])
@router.put("/api/data/recordings/{recording_id}/chunks/{index}")
async def recordings(recording_id: str, request: Request, action: str = "", index: int = -1):
    rt, user = runtime(request), await user_of(request)
    safe(recording_id, 120)
    if request.method == "PUT":
        try:
            start, rate_value = (
                int(request.headers.get("x-s2t-start-sample", "")),
                int(request.headers.get("x-s2t-sample-rate", "")),
            )
        except ValueError:
            fail(400, "無效的 PCM chunk 標頭")
        return await rt.recordings.append(
            user["id"], recording_id, index, start, rate_value, await read_body(request, 1024**2)
        )
    if request.method == "DELETE":
        await rt.recordings.remove(user["id"], recording_id)
        return Response(status_code=204)
    if action == "cleanup":
        await rt.recordings.remove(user["id"], recording_id, await read_json(request, 4096))
        return Response(status_code=204)
    value = await rt.recordings.status(user["id"], recording_id)
    if not value:
        fail(404, "找不到錄音")
    if request.method == "GET":
        return {
            key: value.get(key)
            for key in ("sampleRate", "state", "contiguousChunks", "persistedSamples", "audioKey")
        }
    data = await read_json(request, 4096)
    if action == "finish":
        return await rt.recordings.finish(
            user["id"], recording_id, data.get("totalChunks"), data.get("totalSamples")
        )
    if action == "promote":
        audio_id = safe(data.get("audioKey"))
        if audio_id == recording_id or value["state"] != "completed":
            fail(409, "錄音尚未完成或音訊 ID 無效")
        async with protected_upload(rt, user["id"], audio_id):
            await rt.storage.copy_blob(user["id"], value.get("assemblyKey") or "audio/" + recording_id, "audio/" + audio_id)
        return JSONResponse({"saved": True, "pendingSessionCommit": True}, status_code=201)
    fail(404, "API route not found")


@asynccontextmanager
async def protected_upload(rt, user_id, audio_id):
    token, refresh = await rt.compensation.protect(user_id, audio_id)
    lost = False

    async def renew():
        nonlocal lost
        try:
            while True:
                await asyncio.sleep(20)
                await rt.storage.update(user_id, "audio-compensations", refresh)
        except asyncio.CancelledError:
            raise
        except Exception:
            lost = True

    task = asyncio.create_task(renew())
    try:
        yield
        if lost:
            fail(503, "音訊保存協調失敗，請重試")
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        with anyio.CancelScope(shield=True):
            await rt.compensation.release(user_id, audio_id, token)


@router.api_route("/api/data/audio/{audio_id}", methods=["GET", "POST", "DELETE"])
async def audio_blob(audio_id: str, request: Request):
    rt, user = runtime(request), await user_of(request)
    key = "audio/" + safe(audio_id)
    if request.method == "DELETE":
        capture = await rt.storage.get(user["id"], "recording-" + audio_id) if len(audio_id) <= 120 else None
        if capture:
            await rt.recordings.remove(user["id"], audio_id)
            return Response(status_code=204)
        await rt.storage.remove_blob(user["id"], key)
        await rt.storage.update(
            user["id"],
            "audio-compensations",
            lambda entries: [entry for entry in (entries or []) if entry["id"] != audio_id],
        )
        return Response(status_code=204)
    if request.method == "GET":
        stream = await rt.storage.blob_stream(user["id"], await audio_blob_key(rt.storage, user["id"], audio_id))
        if stream is None:
            fail(404, "找不到音檔")
        return StreamingResponse(
            stream, media_type="audio/wav", headers={"cache-control": "no-store"}
        )
    await rate(request, user, "audio-upload", 30)

    async def stream():
        size = 0
        async for chunk in request.stream():
            size += len(chunk)
            if size > 2 * 1024**3:
                fail(413, "音檔超過大小上限")
            yield chunk
        if not size:
            fail(400, "音檔不可為空")

    async with protected_upload(rt, user["id"], audio_id):
        await rt.storage.put_stream(user["id"], key, stream())
    return JSONResponse({"saved": True, "pendingSessionCommit": True}, status_code=201)


def audio_content_type(request):
    content_type = request.headers.get("content-type", "").split(";")[0].lower()
    if not re.fullmatch(
        r"audio/(wav|x-wav|mpeg|mp4|aac|ogg|webm|flac)|video/(mp4|quicktime|webm)", content_type
    ):
        fail(415, "不支援此音訊格式")
    return content_type


@router.post("/api/transcriptions")
async def transcription(request: Request):
    began = getattr(request.state, "request_started_at", time.monotonic())
    auth_began = time.monotonic()
    rt, user = runtime(request), await user_of(request)
    authenticated = time.monotonic()
    await rate(request, user, "asr", 180)
    limited = time.monotonic()
    content_type = audio_content_type(request)
    upload_began = time.monotonic()
    async with transcription_source(request) as filename:
        uploaded = (time.monotonic() - upload_began) * 1000
        result, timing = await rt.models.transcribe(user, filename, content_type, request.headers)
    timing.update(http_queue=getattr(request.state,"http_queue_ms",0), auth=(authenticated-auth_began)*1000, rate=(limited-authenticated)*1000,
                  upload=uploaded, total=(time.monotonic() - began) * 1000)
    rt.observe_model(user, "transcriptions", result, timing)
    return JSONResponse(
        result,
        headers={
            "server-timing": ", ".join(f"{key};dur={value:.2f}" for key, value in timing.items())
        },
    )


@router.post("/api/translations")
async def translation(request: Request):
    began = getattr(request.state, "request_started_at", time.monotonic())
    auth_began = time.monotonic()
    rt, user = runtime(request), await user_of(request)
    authenticated = time.monotonic()
    await rate(request, user, "translation", 180)
    limited = time.monotonic()
    body = await read_json(request)
    if "temperature" in body and user["role"] not in {"admin", "developer"}:
        fail(403, "只有 admin 或 developer 可調整翻譯參數")
    settings = (await rt.storage.get(user["id"], "app-settings") or {}) if user["role"] in {"admin", "developer"} else {}
    temperature = body.get(
        "temperature",
        settings.get("settings", {}).get("adminParameters", {}).get("translationTemperature", 0.2)
        if user["role"] in {"admin", "developer"}
        else 0.2,
    )
    admin_parameters({"translationTemperature": temperature})
    result, timing = await rt.models.translate(user, body, request.headers, temperature)
    timing.update(http_queue=getattr(request.state,"http_queue_ms",0), auth=(authenticated-auth_began)*1000, rate=(limited-authenticated)*1000,
                  total=(time.monotonic() - began) * 1000)
    rt.observe_model(user, "translations", result, timing)
    return JSONResponse(
        result,
        headers={
            "server-timing": ", ".join(f"{key};dur={value:.2f}" for key, value in timing.items())
        },
    )


@router.post("/api/summaries")
async def summary(request: Request):
    rt, user = runtime(request), await user_of(request)
    await rate(request, user, "summary", 12)
    body = await read_json(request)
    raw_messages = body.get("messages")
    if not isinstance(raw_messages, list):
        fail(400, "Messages are required")
    messages = [
        {"role": item["role"], "content": item["content"]}
        for item in raw_messages
        if isinstance(item, dict)
        and item.get("role") in {"user", "system"}
        and isinstance(item.get("content"), str)
    ][:8]
    if not messages:
        fail(400, "Messages are required")
    service = await rt.models.select("summary", request.headers.get("x-s2t-model-id", ""))
    if body.get("stream") is True:
        return StreamingResponse(
            rt.models.summary_stream(service, messages, user),
            media_type="application/x-ndjson",
            headers={"cache-control": "no-cache, no-transform", "x-accel-buffering": "no"},
        )
    async with rt.admission.capacity("summary"):
        return {"text": await rt.models.chat("summary", service, messages, user=user)}


@router.post("/api/diarizations")
async def diarization(request: Request):
    rt, user = runtime(request), await user_of(request)
    await rate(request, user, "diarization", 8)
    async with rt.admission.capacity("diarization"):
        async with staged(request, 500 * 1024**2) as filename:
            result = await rt.models.diarize(
                filename,
                request.headers.get("x-s2t-model-id", ""),
                request.headers.get("x-s2t-diarization-model", ""),
            )
            turns = result.get("exclusive_diarization", [])
            result["exclusive_diarization"] = await rt.voiceprints.label(
                user["id"], filename, turns
            )
            result["threshold"] = rt.voiceprints.threshold
            if request.headers.get("x-s2t-speaker-embeddings") == "1":
                vectors = await rt.audio.invoke("speaker-embeddings", filename, {"turns": turns})
                result["speaker_embeddings"] = {
                    speaker: values[0] for speaker, values in vectors.items() if values
                }
            return result


@router.get("/api/audio-processing/status")
async def audio_status(request: Request):
    rt = runtime(request)
    await user_of(request)
    try:
        await rt.audio.invoke("health", options={"model": "silero-vad"})
        silero = {"available": True}
    except Exception:
        silero = {"available": False, "reason": "Silero 模型或 runtime 尚未就緒"}
    from ..audio_engine import ffmpeg

    try:
        ffmpeg()
        normalization = {"available": True}
    except RuntimeError:
        normalization = {"available": bool(rt.audio.remote), "reason": "FFmpeg 尚未就緒"}
    return {"sileroVad": silero, "dynaudnorm": normalization}


@router.post("/api/audio-processing/silero-vad")
async def vad(request: Request):
    rt, user = runtime(request), await user_of(request)
    await rate(request, user, "vad", 180)
    audio_content_type(request)
    async with staged(request, 100 * 1024**2) as filename:
        return await rt.audio.invoke(
            "vad", filename, {"frames": request.query_params.get("frames") == "1"}
        )


@router.post("/api/audio-processing/import-wav")
@router.post("/api/audio-processing/transcode")
async def conversion(request: Request):
    rt, user = runtime(request), await user_of(request)
    await rate(request, user, "transcode", 12)
    operation = "import" if request.url.path.endswith("import-wav") else "transcode"
    if operation == "transcode" and request.query_params.get("format") != "m4a":
        fail(400, "目前只支援 M4A")
    async with rt.admission.capacity("transcode"):
        directory = tempfile.TemporaryDirectory(prefix="s2t-convert-")
        source, target = Path(directory.name) / "input", Path(directory.name) / "output"
        try:
            await write_upload(request, source, 2 * 1024**3)
            await rt.audio.convert(operation, source, target)
            return TemporaryFileResponse(
                target, directory, "audio/mp4" if operation == "transcode" else "audio/wav"
            )
        except BaseException:
            directory.cleanup()
            raise


@router.api_route("/api/voiceprints", methods=["GET", "POST"])
async def voiceprints(request: Request):
    rt, user = runtime(request), await user_of(request, {"admin", "developer"})
    await rt.voiceprints.reconcile(user["id"])
    if request.method == "GET":
        return {"voiceprints": await rt.voiceprints.own(user["id"])}
    await rate(request, user, "voiceprint", 12)
    async with staged(request, 500 * 1024**2) as filename:
        entry = await rt.voiceprints.enroll(
            user,
            filename,
            request.headers.get("x-s2t-voiceprint-sharing", "private"),
            request.headers.get("x-s2t-voiceprint-consent", ""),
        )
        return JSONResponse({"voiceprint": entry}, status_code=201)


@router.post("/api/voiceprints/identify")
async def identify(request: Request):
    rt, user = runtime(request), await user_of(request)
    await rate(request, user, "voiceprint", 12)
    async with staged(request, 500 * 1024**2) as filename:
        return await rt.voiceprints.identify(user["id"], filename)


@router.delete("/api/voiceprints/{vector_id}")
async def delete_voiceprint(vector_id: str, request: Request):
    rt, user = runtime(request), await user_of(request, {"admin", "developer"})
    if not any(item["id"] == vector_id for item in await rt.voiceprints.own(user["id"])):
        fail(404, "找不到此聲紋")
    await rt.voiceprints.delete(user["id"], safe(vector_id))
    return Response(status_code=204)


@router.post("/api/telemetry/journey")
@router.post("/api/telemetry/captions")
async def telemetry(request: Request):
    rt, user = runtime(request), await user_of(request)
    await rate(request, user, "telemetry", 240)
    data = await read_json(request, 16384)
    rt.observe_telemetry(user, request.url.path.rsplit("/", 1)[-1], data)
    return {"accepted": True}
