import asyncio
import hashlib
import json
import re
import time
import uuid
from pathlib import Path
from urllib.parse import urlsplit

import anyio
import httpx

from .admission import idempotent
from .core import digest, fail
from .glossary import CsvGlossary, matched_glossary


def base_url(endpoint):
    parsed = urlsplit(endpoint)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username
        or parsed.fragment
        or parsed.query
    ):
        fail(400, "模型服務網址必須是有效 HTTP(S) 網址")
    return re.sub(r"/(audio/transcriptions|chat/completions)/?$", "", endpoint).rstrip("/")


async def multipart(filename, fields, content_type="audio/wav", upload_name="audio.wav"):
    boundary = "s2t-" + uuid.uuid4().hex
    name = re.sub(r"[^A-Za-z0-9._-]", "_", upload_name)[:160] or "audio.wav"
    prefix = [f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode() for key, value in fields.items()]
    prefix.append(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{name}"\r\nContent-Type: {content_type}\r\n\r\n'.encode())
    suffix = f"\r\n--{boundary}--\r\n".encode()

    async def content():
        for part in prefix:
            yield part
        if isinstance(filename, bytes):
            yield filename
        else:
            async with await anyio.open_file(filename, "rb") as source:
                while chunk := await source.read(256 * 1024):
                    yield chunk
        yield suffix

    headers = {"content-type": "multipart/form-data; boundary=" + boundary}
    if isinstance(filename, bytes):
        headers["content-length"] = str(sum(map(len, prefix)) + len(filename) + len(suffix))
    return headers, content()


def turns_of(payload):
    values = (
        payload
        if isinstance(payload, list)
        else payload.get(
            "exclusive_diarization", payload.get("segments", payload.get("diarization", []))
        )
        if isinstance(payload, dict)
        else []
    )
    result = []
    import math

    for item in values if isinstance(values, list) else []:
        if not isinstance(item, dict) or not isinstance(item.get("speaker"), str):
            continue
        start, end = (
            item.get("start", item.get("start_ms", 0) / 1000),
            item.get("end", item.get("end_ms", 0) / 1000),
        )
        if (
            type(start) in {int, float}
            and type(end) in {int, float}
            and math.isfinite(start)
            and math.isfinite(end)
            and 0 <= start < end
        ):
            result.append({"start": start, "end": end, "speaker": item["speaker"].strip()})
    return result


class Models:
    def __init__(self, settings, storage, auth, audio, admission, clients):
        self.settings, self.storage, self.auth, self.audio, self.admission, self.clients = (
            settings,
            storage,
            auth,
            audio,
            admission,
            clients,
        )
        self.health_cache, self.health_pending = {}, {}
        self.prompt_cache = None
        self.jargon = CsvGlossary(
            settings.env.get("S2T_JARGON_FILE") or settings.root / "jargon/jargon_en.csv"
        )
        self.observe_execution = lambda *args, **kwargs: None
        initial_asr = settings.service("asr")
        if any(initial_asr.values()) and not all(initial_asr.values()):
            raise ValueError("環境 ASR endpoint、model 與 API key 必須同時設定")
        self.profiles = [
            {
                "id": "default",
                "name": settings.service("asr")["model"] or "Environment ASR",
                **settings.service("asr"),
            }
        ]
        raw = settings.env.get("S2T_ASR_MODELS_JSON", "")
        if raw:
            parsed = json.loads(raw)
            if not isinstance(parsed, list):
                raise ValueError("S2T_ASR_MODELS_JSON must be an array")
            profiles = [
                item
                for item in parsed
                if isinstance(item, dict)
                and re.fullmatch(r"[A-Za-z0-9_-]{1,80}", item.get("id", ""))
                and all(
                    isinstance(item.get(key), str) and item[key].strip()
                    for key in ("endpoint", "model", "apiKey")
                )
            ]
            if not profiles:
                raise ValueError("S2T_ASR_MODELS_JSON contains no valid model")
            self.profiles = [
                {**item, "name": item.get("name") or item["model"]} for item in profiles
            ]

    async def registry(self):
        return await self.storage.get(await self.auth.owner(), "model-registry") or {
            "models": [],
            "version": 0,
        }

    async def managed(self, model_id, purpose):
        if self.storage.pool:
            # One fresh indexed read replaces owner + registry + credential
            # round trips. Changes and key revocations take effect immediately.
            async with self.storage.pool.connection() as connection:
                row = await (
                    await connection.execute(
                        """
                    SELECT model.value, credential.value
                    FROM (SELECT id FROM s2t_users WHERE role='admin' AND deletion_state='active' ORDER BY created_at,id LIMIT 1) owner
                    JOIN s2t_config_records registry ON registry.scope=owner.id AND registry.record_key='model-registry'
                    CROSS JOIN LATERAL jsonb_array_elements(registry.value->'models') model(value)
                    LEFT JOIN s2t_config_records credential ON credential.scope=owner.id AND credential.record_key='model-credential-' || %s
                    WHERE model.value->>'id'=%s AND model.value->>'purpose'=%s LIMIT 1
                """,
                        (model_id, model_id, purpose),
                    )
                ).fetchone()
            if not row:
                return None
            model, encrypted = row
            key = self.auth.decrypt(encrypted) if model.get("requiresApiKey") is not False else ""
            if model.get("requiresApiKey") is not False and not key:
                return None
            return {"endpoint": model["endpoint"], "model": model["model"], "apiKey": key}
        owner = await self.auth.owner()
        registry = await self.storage.get(owner, "model-registry") or {}
        model = next(
            (
                item
                for item in registry.get("models", [])
                if item["id"] == model_id and item["purpose"] == purpose
            ),
            None,
        )
        if not model:
            return None
        key = ""
        if model.get("requiresApiKey") is not False:
            key = self.auth.decrypt(await self.storage.get(owner, "model-credential-" + model_id))
            if not key:
                return None
        return {"endpoint": model["endpoint"], "model": model["model"], "apiKey": key}

    async def select(self, purpose, model_id=""):
        if purpose == "asr":
            model_id = model_id or "default"
            service = next(
                (profile for profile in self.profiles if profile["id"] == model_id), None
            )
            if service is not None and not service.get("apiKey"):
                fail(503, "環境 ASR 尚未設定 API key")
            if service is None:
                service = await self.managed(model_id, purpose)
        else:
            service = (
                await self.managed(model_id, purpose)
                if model_id
                else self.settings.service(purpose)
            )
        if not service or not service.get("endpoint") or not service.get("model"):
            fail(503, "模型服務尚未完成設定")
        if not model_id and not service.get("apiKey"):
            fail(503, "模型服務尚未設定 API key")
        base_url(service["endpoint"])
        return service

    def headers(self, service):
        return {"authorization": "Bearer " + service["apiKey"]} if service.get("apiKey") else {}

    async def checked(self, role, method, url, **kwargs):
        try:
            response = await self.clients[role].request(method, url, **kwargs)
        except httpx.TimeoutException:
            fail(504, "模型服務回應逾時")
        except httpx.HTTPError as error:
            # Error type is useful for pool/protocol diagnostics; URLs, keys
            # and upstream response bodies must never enter this log.
            import logging
            logging.getLogger("s2t").warning("Model transport failed: role=%s kind=%s", role, type(error).__name__)
            fail(502, "無法連線至模型服務")
        if not response.is_success:
            from fastapi import HTTPException

            raise HTTPException(
                429 if response.status_code == 429 else 502,
                f"模型服務 HTTP {response.status_code}",
                headers={"retry-after": response.headers.get("retry-after", "30")}
                if response.status_code == 429
                else None,
            )
        try:
            return response.json()
        except ValueError:
            fail(502, "模型服務回傳格式無效")

    async def transcribe(self, user, filename, content_type, headers):
        service = await self.select("asr", headers.get("x-s2t-model-id", ""))
        language = headers.get("x-s2t-language", "")
        if language not in {"", "zh", "en", "ja", "de"}:
            fail(400, "ASR language must be zh, en, ja, de or automatic")

        def fingerprint():
            state = hashlib.sha256()
            if isinstance(filename, bytes):
                state.update(filename)
            else:
                with open(filename, "rb") as source:
                    while chunk := source.read(1024 * 1024):
                        state.update(chunk)
            state.update(
                json.dumps(
                    {
                        "headers": {
                            key: value
                            for key, value in headers.items()
                            if key.startswith("x-s2t-") and key != "x-s2t-idempotency-key"
                        },
                        "contentType": content_type,
                        "service": {**service, "apiKey": digest(service.get("apiKey", ""))},
                    },
                    sort_keys=True,
                ).encode()
            )
            return state.hexdigest()

        fingerprint_value = fingerprint() if isinstance(filename, bytes) else await anyio.to_thread.run_sync(fingerprint)
        timing = {}

        async def operation():
            started = time.monotonic()
            async with self.admission.capacity("asr"):
                timing["queue"] = (time.monotonic() - started) * 1000
                selected_file = filename
                normalized = None if isinstance(filename, bytes) else str(filename) + ".normalized"
                try:
                    if headers.get("x-s2t-dynaudnorm") == "true":
                        began = time.monotonic()
                        await self.audio.convert("normalize", filename, normalized)
                        selected_file = normalized
                        timing["pre"] = (time.monotonic() - began) * 1000
                    from urllib.parse import unquote

                    fields = {"model": service["model"]}
                    if language:
                        fields["language"] = language
                    if headers.get("x-s2t-prompt"):
                        fields["prompt"] = unquote(headers["x-s2t-prompt"])[:10000]
                    multipart_headers, body = await multipart(
                        selected_file,
                        fields,
                        content_type,
                        unquote(headers.get("x-s2t-filename", "audio.wav")),
                    )
                    began = time.monotonic()
                    result = await self.checked(
                        "asr",
                        "POST",
                        base_url(service["endpoint"]) + "/audio/transcriptions",
                        headers={**self.headers(service), **multipart_headers},
                        content=body,
                        timeout=25,
                    )
                    timing["model"] = (time.monotonic() - began) * 1000
                    self.observe_execution(
                        user, "transcriptions", output=result.get("text", ""), audio=filename
                    )
                    detected = str(result.get("language", "")).lower()
                    normalized_language = next(
                        (
                            name
                            for prefix, name in [
                                ("zh", "zh-TW"),
                                ("en", "en-US"),
                                ("ja", "ja-JP"),
                                ("de", "de-DE"),
                            ]
                            if detected.startswith(prefix)
                        ),
                        None,
                    )
                    return {
                        "text": result.get("text", ""),
                        **(
                            {"detectedLanguage": normalized_language} if normalized_language else {}
                        ),
                    }
                finally:
                    if normalized:
                        Path(normalized).unlink(missing_ok=True)

        result = await idempotent(
            self.storage,
            user["id"],
            "/api/transcriptions",
            headers.get("x-s2t-idempotency-key"),
            fingerprint_value,
            operation,
        )
        return result, timing

    def prompts(self):
        file = self.settings.root / "prompt/prompts.json"
        metadata = file.stat()
        version = (metadata.st_ino, metadata.st_mtime_ns, metadata.st_size)
        if self.prompt_cache and self.prompt_cache[0] == version:
            return dict(self.prompt_cache[1])
        value = json.loads(file.read_text())
        if not isinstance(value, dict) or any(not isinstance(item, str) for item in value.values()):
            fail(503, "Prompt 設定格式無效")
        self.prompt_cache = (version, value)
        return dict(value)

    def prompt(self, key, **variables):
        text = self.prompts()[key]
        return re.sub(
            r"\{\{(\w+)\}\}|\{(glossary)\}",
            lambda match: str(variables[match[1] or match[2]]),
            text,
        )

    async def chat(self, purpose, service, messages, temperature=0.2, user=None):
        result = await self.checked(
            purpose,
            "POST",
            base_url(service["endpoint"]) + "/chat/completions",
            headers=self.headers(service),
            json={"model": service["model"], "temperature": temperature, "messages": messages},
            timeout=90 if purpose == "summary" else 30,
        )
        try:
            text = result["choices"][0]["message"]["content"].strip()
            if user:
                self.observe_execution(
                    user,
                    "summaries" if purpose == "summary" else "translations",
                    output=text,
                    input="".join(item["content"] for item in messages),
                    usage=result.get("usage"),
                )
            return text
        except (KeyError, IndexError, TypeError, AttributeError):
            fail(502, "模型未回傳有效文字")

    async def translate(self, user, data, headers, temperature):
        service = await self.select("translation", headers.get("x-s2t-model-id", ""))
        text = data.get("text", "")
        if not isinstance(text, str) or not text.strip():
            fail(400, "Text is required")
        text = text.strip()[:20000]
        source = data.get("sourceLanguage", "zh-TW")
        target = data.get("targetLanguage", "en")
        source = source if isinstance(source, str) else "zh-TW"
        target = target if isinstance(target, str) else "en"
        if source not in {"auto", "zh-TW", "zh-CN", "en-US", "ja-JP", "de-DE"}:
            source = "zh-TW"
        if target not in {"zh-TW", "en", "ja", "de"}:
            target = "en"
        names = {
            "auto": "自动检测（中文、英语、日语或德语）",
            "zh-TW": "繁体中文",
            "zh-CN": "简体中文",
            "en": "英语",
            "en-US": "英语",
            "ja": "日语",
            "ja-JP": "日语",
            "de": "德语",
            "de-DE": "德语",
        }
        glossary = data.get("glossary", "")
        glossary = glossary.strip()[:10000] if isinstance(glossary, str) else ""
        csv_glossary = matched_glossary(text, await self.jargon.load_glossary())
        chinese = source.startswith("zh") or target.startswith("zh")
        template_key = "gatewayTranslationZh" if chinese else "gatewayTranslationEn"
        terms = self.prompt("gatewayTerms", glossary=glossary) if glossary else ""
        # Existing installations retain their customized templates. Include CSV
        # terminology even when an older template has only the {{terms}} slot.
        template = self.prompts()[template_key]
        if "{glossary}" not in template:
            terms += self.prompt("gatewayTerms", glossary=csv_glossary)
        prompt = self.prompt(
            template_key,
            target=names[target],
            source=names[source],
            text=text,
            terms=terms,
            glossary=csv_glossary,
            structure="\n" + self.prompt("gatewayMarkdownZh" if chinese else "gatewayMarkdownEn")
            if data.get("format") == "markdown"
            else "",
        )
        timing = {}

        async def operation():
            began = time.monotonic()
            async with self.admission.capacity("translation"):
                timing["queue"] = (time.monotonic() - began) * 1000
                began = time.monotonic()
                result = await self.chat(
                    "translation", service, [{"role": "user", "content": prompt}], temperature, user
                )
                timing["model"] = (time.monotonic() - began) * 1000
                return {"text": result}

        value = await idempotent(
            self.storage,
            user["id"],
            "/api/translations",
            headers.get("x-s2t-idempotency-key"),
            digest(
                json.dumps(
                    {
                        "prompt": prompt,
                        "temperature": temperature,
                        "service": {**service, "apiKey": digest(service.get("apiKey", ""))},
                    },
                    sort_keys=True,
                )
            ),
            operation,
        )
        return value, timing

    async def summary_stream(self, service, messages, user=None):
        async with self.admission.capacity("summary"):
            try:
                async with self.clients["summary"].stream(
                    "POST",
                    base_url(service["endpoint"]) + "/chat/completions",
                    headers=self.headers(service),
                    json={
                        "model": service["model"],
                        "temperature": 0.2,
                        "messages": messages,
                        "stream": True,
                        "stream_options": {"include_usage": True},
                    },
                    timeout=90,
                ) as response:
                    if not response.is_success:
                        yield (
                            json.dumps({"error": f"模型服務 HTTP {response.status_code}"}).encode()
                            + b"\n"
                        )
                        return
                    completed = False
                    output, usage = [], None
                    async for line in response.aiter_lines():
                        if not line.startswith("data:"):
                            continue
                        data = line[5:].strip()
                        if data == "[DONE]":
                            completed = True
                            break
                        chunk = json.loads(data)
                        if chunk.get("usage"):
                            usage = chunk["usage"]
                        choices = chunk.get("choices") or []
                        if choices:
                            text = choices[0].get("delta", {}).get("content")
                            if text:
                                output.append(text)
                                yield (
                                    json.dumps({"delta": text}, ensure_ascii=False).encode() + b"\n"
                                )
                    if completed and user:
                        self.observe_execution(
                            user,
                            "summaries",
                            output="".join(output),
                            input="".join(item["content"] for item in messages),
                            usage=usage,
                        )
                    yield (
                        json.dumps(
                            {"done": True} if completed else {"error": "摘要串流提前中斷"}
                        ).encode()
                        + b"\n"
                    )
            except (httpx.HTTPError, ValueError):
                yield b'{"error":"Summary stream failed"}\n'

    async def diarize(self, filename, model_id="", local_model=""):
        selected = (
            await self.managed(model_id, "diarization")
            if model_id and not local_model
            else self.settings.service("diarization")
            if not local_model
            else None
        )
        if selected and selected.get("endpoint"):
            base_url(selected["endpoint"])
            headers, body = await multipart(filename, {"model": selected["model"]})
            payload = await self.checked(
                "diarization",
                "POST",
                selected["endpoint"],
                headers={**headers, **self.headers(selected)},
                content=body,
                timeout=120,
            )
            return (
                {**payload, "exclusive_diarization": turns_of(payload)}
                if isinstance(payload, dict)
                else {"exclusive_diarization": turns_of(payload)}
            )
        if model_id and not local_model:
            fail(400, "找不到講者分離模型")
        model = (
            local_model
            or self.settings.service("diarization")["model"]
            or "sherpa-onnx-speaker-diarization"
        )
        return {
            "model": model,
            "exclusive_diarization": await self.audio.invoke("diarize", filename, {"model": model}),
        }

    async def available(self):
        checks = list((await self.registry()).get("models", []))

        def add(item):
            if (
                item.get("endpoint")
                and item.get("model")
                and not any(check["id"] == item["id"] for check in checks)
            ):
                checks.append(item)

        for profile in self.profiles:
            add(
                {
                    **profile,
                    "id": "web-environment-asr"
                    if profile["id"] == "default"
                    else "web-gateway-asr-" + profile["id"],
                    "purpose": "asr",
                    "service": profile,
                    "publicEndpoint": "/api/transcriptions",
                }
            )
        for purpose, model_id in [
            ("translation", "web-environment-translation"),
            ("summary", "managed-summary"),
            ("diarization", "managed-diarization"),
        ]:
            service = self.settings.service(purpose)
            if purpose == "diarization" and not service["endpoint"]:
                service = {
                    **service,
                    "endpoint": "/api/diarizations",
                    "model": service["model"] or "sherpa-onnx-speaker-diarization",
                }
            add(
                {
                    **service,
                    "id": model_id,
                    "purpose": purpose,
                    "service": service,
                    "publicEndpoint": {
                        "summary": "/api/summaries",
                        "translation": "/api/translations",
                        "diarization": "/api/diarizations",
                    }[purpose],
                }
            )
        for profile in self.audio.profiles():
            add({**profile, "purpose": "diarization"})
        add(
            {
                "id": "managed-silero-vad",
                "endpoint": "/api/audio-processing/silero-vad",
                "model": "silero-vad",
                "purpose": "asr",
            }
        )
        return checks

    async def health(self, model, service=None, cache=True):
        key = digest(json.dumps(model, sort_keys=True))
        timestamp = time.time() * 1000
        if (
            cache
            and key in self.health_cache
            and timestamp - self.health_cache[key]["checkedAt"] < 60000
        ):
            return self.health_cache[key]
        if cache and key in self.health_pending:
            return await asyncio.shield(self.health_pending[key])

        async def probe():
            state, reason = "unknown", "尚未設定模型憑證"
            try:
                if model["endpoint"] in {
                    "/api/diarizations",
                    "s2t-local://diarization",
                    "/api/audio-processing/silero-vad",
                }:
                    await self.audio.invoke(
                        "health", options={"model": model["model"], "purpose": model.get("purpose")}
                    )
                    state, reason = "healthy", "本機模型與 runtime 已就緒"
                else:
                    selected = (
                        service
                        or model.get("service")
                        or await self.managed(model["id"], model["purpose"])
                    )
                    if selected and (
                        selected.get("apiKey") or model.get("requiresApiKey") is False
                    ):
                        response = await self.clients["health"].get(
                            base_url(selected["endpoint"]) + "/models",
                            headers=self.headers(selected),
                            timeout=8,
                        )
                        if response.is_success:
                            payload = response.json()
                            found = any(
                                item.get("id") == selected["model"]
                                for item in payload.get("data", [])
                            )
                            state, reason = (
                                ("healthy", "模型清單確認可用，尚未執行推論")
                                if found
                                else ("degraded", "模型清單找不到指定模型")
                            )
                        else:
                            state, reason = (
                                ("degraded" if response.status_code in {404, 405} else "unhealthy"),
                                f"模型清單 HTTP {response.status_code}",
                            )
            except Exception:
                state, reason = "unhealthy", "模型檢查失敗，請檢查 runtime、模型檔案或服務連線"
            result = {
                "id": model["id"],
                "state": state,
                "reason": reason,
                "checkedAt": time.time() * 1000,
            }
            if cache:
                if len(self.health_cache) > 1000:
                    self.health_cache.clear()
                self.health_cache[key] = result
            return result

        task = asyncio.create_task(probe())
        if cache:
            self.health_pending[key] = task
        try:
            return await asyncio.shield(task)
        finally:
            self.health_pending.pop(key, None)
