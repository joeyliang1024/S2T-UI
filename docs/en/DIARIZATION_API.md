# Diarization integration

[繁體中文](../reference/DIARIZATION_API.zh-TW.md) | English

VAD and volume are not speaker identity. Browser requests use authenticated Python `/api/diarizations`; backend remote-mode inference sends model and complete PCM16 WAV in multipart form data with its configured bearer key. Local mode uses prepared Sherpa/Nemotron weights.

Remote responses accept `exclusive_diarization`, `segments` or `diarization`. Turns may expose seconds as `start`/`end` or milliseconds as `start_ms`/`end_ms`, plus `speaker`. Exclusive turns take priority. Each subtitle receives the greatest-overlap speaker while retaining original timing/text. This is an application integration format, not a universal OpenAI contract.

Live preview and post-recording speaker identification are distinct entry points. Frozen display groups retain membership when late speaker results arrive. Keys stay backend-only. See [API](API.md), [models](MODELS.md) and [caption speed](CAPTION_SPEED.md).
