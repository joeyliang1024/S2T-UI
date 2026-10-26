"""Web contracts implemented by Python; no legacy forwarding or Node runtime."""

import asyncio
import base64
import re
import time
from pathlib import Path

import anyio
from fastapi import APIRouter, Request
from pydantic import ValidationError
from starlette.responses import JSONResponse, Response

from ..core import MANAGED_KEYS, MODEL_KEYS, admin_parameters, digest, fail, integer, now, read_json
from ..recordings import audio_keys, session_snapshot
from ..schemas import RegistryWrite, SessionWrite
from ..storage import UNCHANGED

router = APIRouter()

from ..http_common import runtime, user_of, rate


@router.get("/api/config")
async def config(request: Request):
    rt = runtime(request)

    def public(service, endpoint):
        return {
            "endpoint": endpoint,
            "sourceEndpoint": service["endpoint"] or endpoint,
            "model": service["model"],
            "configured": all(service.values()),
        }

    image = rt.settings.env.get("S2T_PRODUCT_TITLE_IMAGE", "")
    title = ""
    if re.fullmatch(r"icon/[A-Za-z0-9_./-]+\.png", image) and ".." not in image.split("/"):
        path = Path(image)
        if path.is_file() and path.stat().st_size <= 2 * 1024**2:
            title = (
                "data:image/png;base64,"
                + base64.b64encode(await anyio.Path(path).read_bytes()).decode()
            )
    diarization = rt.settings.service("diarization")
    return {
        "prompts": rt.models.prompts(),
        "capabilities": {"durableRecordingChunks": True, "distributed": rt.settings.distributed},
        "branding": {"titleImage": title},
        "asr": public(rt.settings.service("asr"), "/api/transcriptions"),
        "asrProfiles": [
            {**public(profile, "/api/transcriptions"), "id": profile["id"], "name": profile["name"]}
            for profile in rt.models.profiles
        ],
        "translation": public(rt.settings.service("translation"), "/api/translations"),
        "summary": public(rt.settings.service("summary"), "/api/summaries"),
        "diarizationProfiles": rt.audio.profiles(),
        "diarization": public(diarization, "/api/diarizations")
        if diarization["endpoint"]
        else {
            "endpoint": "/api/diarizations",
            "model": diarization["model"] or "sherpa-onnx-speaker-diarization",
            "configured": True,
        },
    }


@router.get("/api/storage")
async def storage_status(request: Request):
    rt = runtime(request)
    await rt.storage.health()
    return {
        "mode": rt.storage.mode,
        "schemaVersion": "003-python-runtime" if rt.storage.pool else "local-v1",
        "ready": True,
        "compensationGraceMs": rt.compensation.grace,
    }


@router.api_route("/api/data/sessions", methods=["GET", "POST"])
async def sessions(request: Request):
    rt, user = runtime(request), await user_of(request)
    if request.method == "GET":
        return await session_snapshot(rt.storage, user["id"])
    async with rt.admission.capacity("sessions"):
        data = await read_json(request, 32 * 1024**2, compressed=True)
        try:
            body = SessionWrite.model_validate(data)
        except ValidationError:
            fail(400, "sessions 與 version 格式無效")
        values, ids, keys = [], set(), set()
        for item in body.sessions:
            value = item.model_dump(exclude_unset=True)
            value.setdefault("audioKey", "")
            session_id = re.sub(r"(?:-remote-[a-f0-9]+)+$", "", value["id"], flags=re.I)
            active = next(
                (
                    version
                    for version in value.get("audioVersions") or []
                    if version.get("id") == value.get("activeAudioVersionId")
                ),
                {},
            )
            key = active.get("audioKey", value["audioKey"])
            if session_id in ids or key and key in keys:
                continue
            ids.add(session_id)
            if key:
                keys.add(key)
            value.update(id=session_id, title=re.sub(r"（遠端衝突版本）+$", "", value["title"]))
            values.append(value)
        await session_snapshot(rt.storage, user["id"])
        async with rt.storage.transaction(f"record:{user['id']}:sessions") as tx:
            current = await tx.get(user["id"], "sessions") or {"sessions": [], "version": 0}
            if current.get("version", 0) != body.version:
                fail(409, "遠端記錄已有更新；請重新載入後再同步")
            previous_keys = audio_keys(current.get("sessions", []))
            for audio_id in audio_keys(values) - previous_keys:
                capture = await tx.get(user["id"], "recording-" + audio_id) if len(audio_id) <= 120 else None
                if capture and capture.get("state") in {"deleting", "deleted"}:
                    fail(409, "音訊已在清理中，不能新增引用")
            removed = previous_keys - audio_keys(values)
            if removed:
                entries = await tx.get(user["id"], "audio-compensations") or []
                entries.extend({"id": key, "createdAt": now()} for key in removed if not any(entry["id"] == key for entry in entries))
                await tx.put(user["id"], "audio-compensations", entries)
            await tx.put(user["id"], "sessions", {"sessions": values, "version": body.version + 1})
        # Cleanup remains durable and retryable if an object store is down.
        try:
            await rt.compensation.reconcile(user["id"], values)
        except Exception:
            rt.logger.warning("session audio cleanup deferred")
        return {"saved": True, "version": body.version + 1}


@router.api_route("/api/data/settings", methods=["GET", "POST"])
async def settings_route(request: Request):
    rt, user = runtime(request), await user_of(request)
    shared = (await rt.storage.get(await rt.auth.owner(), "app-settings") or {}).get("settings", {})
    stored = await rt.storage.get(user["id"], "app-settings") or {"settings": {}, "version": 0}
    if request.method == "GET":
        settings = {
            key: value for key, value in stored["settings"].items() if key not in MANAGED_KEYS
        }
        settings.update({key: value for key, value in shared.items() if key in MANAGED_KEYS})
        if user["role"] == "developer":
            settings.update(
                {
                    key: value
                    for key, value in stored["settings"].items()
                    if key in MANAGED_KEYS and key not in MODEL_KEYS
                }
            )
        if user["role"] == "user":
            settings.pop("adminParameters", None)
        return {"settings": settings, "version": stored["version"]}
    data = await read_json(request, 512 * 1024)
    settings, version = data.get("settings"), data.get("version")
    if not isinstance(settings, dict) or not integer(version):
        fail(400, "settings 與 version 必須有效")
    if user["role"] == "user" and "adminParameters" in settings:
        fail(403, "只有 admin 或 developer 可客製化進階參數")
    preserved = (
        MANAGED_KEYS
        if user["role"] == "user"
        else MODEL_KEYS
        if user["role"] == "developer"
        else []
    )
    for key in preserved:
        settings.pop(key, None)
        if key in shared:
            settings[key] = shared[key]
    if "adminParameters" in settings:
        settings["adminParameters"] = admin_parameters(settings["adminParameters"])
    if not await rt.storage.cas(
        user["id"], "app-settings", version, {"settings": settings, "version": version + 1}
    ):
        fail(409, "設定已被其他視窗更新")
    return {"saved": True, "version": version + 1}


@router.api_route("/api/data/{kind}", methods=["GET", "POST", "DELETE"])
async def data_route(kind: str, request: Request):
    rt, user = runtime(request), await user_of(request)
    # Each kind is explicitly allowlisted; arbitrary config records are private.
    if kind in {"live-draft", "import-checkpoint"}:
        if request.method == "GET":
            return {"value": await rt.storage.get(user["id"], kind)}
        if request.method == "DELETE":
            expected = request.query_params.get("expectedId")
            if kind == "live-draft" and expected:
                await rt.storage.update(
                    user["id"],
                    kind,
                    lambda value: None if value and value.get("id") == expected else UNCHANGED,
                )
            else:
                await rt.storage.remove(user["id"], kind)
            return Response(status_code=204)
        body = await read_json(request, 2 * 1024**2)
        if not isinstance(body.get("value"), dict):
            fail(400, "暫存資料無效")
        await rt.storage.put(user["id"], kind, body["value"])
        return Response(status_code=204)
    if kind == "model-registry":
        if request.method == "GET":
            return await rt.models.registry()
        if request.method != "POST":
            fail(405, "Method not allowed")
        await user_of(request, {"admin"})
        try:
            body = RegistryWrite.model_validate(await read_json(request))
        except ValidationError:
            fail(400, "模型資料無效或 ID 重複")
        value = {
            "models": [model.model_dump() for model in body.models],
            "version": body.version + 1,
        }
        if not await rt.storage.cas(await rt.auth.owner(), kind, body.version, value):
            fail(409, "模型清單已被其他視窗更新")
        rt.models.health_cache.clear()
        return {"saved": True, "version": value["version"]}
    if kind == "model-health" and request.method == "POST":
        models = await rt.models.available()

        async def check(model):
            async with rt.health_gate.enter():
                return await rt.models.health(model)

        return {"health": await asyncio.gather(*(check(model) for model in models))}
    if kind == "model-test" and request.method == "POST":
        await user_of(request, {"admin", "developer"})
        await rate(request, user, "model-tests", 60)
        body = await read_json(request, 16384)
        available = await rt.models.available()
        saved = next((item for item in available if item["id"] == body.get("id")), None)
        model = saved
        service = None
        if "endpoint" in body:
            if "apiKey" in body and (
                not isinstance(body["apiKey"], str) or len(body["apiKey"]) > 8192
            ):
                fail(400, "API key 格式無效")
            try:
                from ..schemas import RegistryModel

                model = RegistryModel.model_validate(
                    {**body, "id": body.get("id", "draft"), "name": body.get("name", "draft")}
                ).model_dump()
            except ValidationError:
                fail(400, "模型測試資料無效")
            same = (
                saved
                and saved["purpose"] == model["purpose"]
                and model["endpoint"] in {saved["endpoint"], saved.get("publicEndpoint")}
            )
            stored_service = (
                (saved.get("service") or await rt.models.managed(saved["id"], saved["purpose"]))
                if same
                else None
            )
            service = {
                "endpoint": (stored_service or model)["endpoint"],
                "model": model["model"],
                "apiKey": body.get("apiKey", "").strip() or (stored_service or {}).get("apiKey", "")
                if model.get("requiresApiKey")
                else "",
            }
        if not model:
            fail(404, "找不到此模型")
        began = time.monotonic()
        result = await rt.models.health(model, service, cache=False)
        return {
            "result": {
                **result,
                "elapsedMs": round((time.monotonic() - began) * 1000),
                "testKind": "local-runtime"
                if model["endpoint"].startswith(("/", "s2t-local:"))
                else "model-list",
            }
        }
    if kind == "glossary":
        return await glossary(request, user)
    if kind == "summary-templates":
        return await templates(request, user)
    if kind == "diarization-jobs":
        if request.method == "POST":
            return JSONResponse(
                {"job": await rt.jobs.enqueue(user, await read_json(request, 32768))},
                status_code=202,
            )
        job_id = request.query_params.get("id", "")
        if request.method == "DELETE":
            await rt.jobs.remove(user["id"], job_id)
            return Response(status_code=204)
        job = await rt.jobs.get(user["id"], job_id)
        if not job:
            fail(404, "找不到講者分離工作")
        return {
            "job": {
                key: job.get(key)
                for key in ("id", "state", "attempts", "error", "createdAt", "updatedAt")
            }
        }
    if kind in {"storage-status", "storage-retry", "storage-audit"}:
        return await compensation(request, user, kind)
    fail(404, "API route not found")


async def glossary(request, user):
    rt = runtime(request)
    async with rt.storage.transaction(f"glossary:{user['id']}") as tx:
        if hasattr(tx, "connection"):
            row = await (
                await tx.connection.execute(
                    "SELECT content,version,updated_at FROM s2t_glossaries WHERE user_id=%s FOR UPDATE",
                    (user["id"],),
                )
            ).fetchone()
            stored = (
                {"content": row[0], "version": row[1], "updatedAt": row[2].isoformat()}
                if row
                else {"content": "", "version": 0, "updatedAt": None}
            )
        else:
            stored = await tx.get(user["id"], "glossary")
            metadata = await tx.get(user["id"], "glossary-version") or {}
            stored = (
                stored
                if isinstance(stored, dict)
                else {
                    "content": stored or "",
                    "version": metadata.get("version", 0),
                    "updatedAt": metadata.get("updatedAt"),
                }
            )
        if request.method == "GET":
            return {
                "glossary": stored["content"],
                "version": stored["version"],
                "updatedAt": stored["updatedAt"],
            }
        if request.method != "POST":
            fail(405, "Method not allowed")
        await user_of(request, {"admin", "developer"})
        body = await read_json(request)
        if not isinstance(body.get("glossary"), str) or not integer(body.get("version")):
            fail(400, "glossary 與 version 必須有效")
        if stored["version"] != body["version"]:
            fail(409, "術語已被其他視窗更新")
        value = {
            "content": body["glossary"].strip()[:20000],
            "version": body["version"] + 1,
            "updatedAt": now(),
        }
        if hasattr(tx, "connection"):
            await tx.connection.execute(
                "INSERT INTO s2t_glossaries(user_id,content,version) VALUES(%s,%s,%s) ON CONFLICT(user_id) DO UPDATE SET content=excluded.content,version=excluded.version,updated_at=now()",
                (user["id"], value["content"], value["version"]),
            )
        else:
            await tx.put(user["id"], "glossary", value["content"])
            await tx.put(
                user["id"],
                "glossary-version",
                {"version": value["version"], "updatedAt": value["updatedAt"]},
            )
        return {"saved": True, "version": value["version"], "updatedAt": value["updatedAt"]}


async def templates(request, user):
    rt = runtime(request)

    def load():
        result = []
        directory = (rt.settings.root / "template").resolve()
        for path in sorted(directory.iterdir()):
            if path.suffix.lower() not in {".md", ".markdown"} or not path.is_file():
                continue
            if path.is_symlink() and (
                directory not in path.resolve().parents
                or not str(path.readlink()).startswith("..data/")
            ):
                continue
            if path.stat().st_size > 80000:
                fail(400, "摘要模板過大")
            content = path.read_text()
            if len(content) > 20000 or len(result) >= 100:
                fail(400, "摘要模板超過上限")
            if content.strip():
                result.append(
                    {
                        "id": "file-summary-" + digest(path.name)[:24],
                        "name": path.stem.strip()[:100],
                        "content": content,
                        "sourceFile": path.name,
                    }
                )
        return result

    files = await anyio.to_thread.run_sync(load)
    stored = await rt.storage.get(user["id"], "summary-templates") or {
        "templates": [],
        "version": 0,
    }
    if request.method == "GET":
        values = files + [
            item
            for item in stored["templates"]
            if not item["id"].startswith("file-summary-")
            and not (
                files
                and item["id"] == "default-summary"
                and item["content"].strip() == "# 會議摘要\n\n## 重點\n\n## 決策\n\n## 待辦事項"
            )
        ]
        selected = stored.get("selectedTemplateId")
        return {
            "templates": values,
            "selectedTemplateId": selected
            if any(item["id"] == selected for item in values)
            else values[0]["id"]
            if values
            else None,
            "version": stored["version"],
        }
    if request.method != "POST":
        fail(405, "Method not allowed")
    data = await read_json(request)
    if not isinstance(data.get("templates"), list) or not integer(data.get("version")):
        fail(400, "templates 與 version 必須有效")
    personal = [
        {
            "id": item["id"].strip()[:100],
            "name": item["name"].strip()[:100],
            "content": item["content"][:20000],
        }
        for item in data["templates"]
        if isinstance(item, dict)
        and all(
            isinstance(item.get(key), str) and item[key].strip()
            for key in ("id", "name", "content")
        )
        and not item["id"].startswith("file-summary-")
    ]
    values = files + personal
    if not values or len(personal) > 100:
        fail(400, "至少需保留一個有效模板，且最多 100 個")
    selected = data.get("selectedTemplateId")
    value = {
        "templates": personal,
        "selectedTemplateId": selected
        if any(item["id"] == selected for item in values)
        else values[0]["id"],
        "version": data["version"] + 1,
    }
    if not await rt.storage.cas(user["id"], "summary-templates", data["version"], value):
        fail(409, "摘要模板已被其他視窗更新")
    return {"saved": True, "version": value["version"]}


async def compensation(request, user, kind):
    rt = runtime(request)
    if request.method != "GET":
        await user_of(request, {"admin", "developer"})
    snapshot = await session_snapshot(rt.storage, user["id"])
    if kind == "storage-audit":
        referenced = audio_keys(snapshot["sessions"])
        referenced.update(
            entry["key"][len("recording-") :]
            for entry in await rt.storage.list(user["id"], "recording-")
        )
        referenced.update(
            item["id"] for item in await rt.storage.get(user["id"], "audio-compensations") or []
        )
        orphans = [
            key
            for key in await rt.storage.list_blobs(user["id"], "audio/")
            if key[len("audio/") :] not in referenced
        ]
        if request.method == "POST":
            for key in orphans:
                await rt.storage.remove_blob(user["id"], key)
        return {
            "orphanAudio": 0 if request.method == "POST" else len(orphans),
            "deletedAudio": len(orphans) if request.method == "POST" else 0,
        }
    await rt.voiceprints.reconcile(user["id"])
    if kind == "storage-retry":
        await rt.compensation.reconcile(user["id"], snapshot["sessions"])
    return {
        "audioPending": len(await rt.storage.get(user["id"], "audio-compensations") or []),
        "voiceprintPending": len(
            await rt.storage.get(user["id"], "voiceprint-compensations") or []
        ),
        **({"retried": True} if kind == "storage-retry" else {}),
    }


@router.api_route("/api/data/model-credentials/{model_id}", methods=["POST", "DELETE"])
async def credentials(model_id: str, request: Request):
    rt = runtime(request)
    await user_of(request, {"admin"})
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", model_id):
        fail(400, "模型 ID 無效")
    owner = await rt.auth.owner()
    if request.method == "DELETE":
        await rt.storage.remove(owner, "model-credential-" + model_id)
    else:
        data = await read_json(request, 16384)
        key = data.get("apiKey")
        if not isinstance(key, str) or not key.strip() or len(key) > 8000:
            fail(400, "API key 無效")
        await rt.storage.put(owner, "model-credential-" + model_id, rt.auth.encrypt(key.strip()))
    rt.models.health_cache.clear()
    return Response(status_code=204)
