# Model adapter contracts

[繁體中文](../reference/MODEL_ADAPTER.md) | English

The default live ASR path is authenticated Python HTTP chunk transcription. The browser adapter emits final events per response; HTTP chat streaming does not imply streaming audio or interim ASR tokens. Capture cadence follows [caption speed](CAPTION_SPEED.md); display-row merging does not change inference scheduling.

`frontend/src/features/models/contracts.ts` defines start, ordered Float32 PCM pushes, transcript/error subscriptions and stop. Preserve supplied sample offsets through resampling/encoding. Stable event IDs and increasing revisions prevent stale replacement; optional language/translation fields belong to that content revision. Stop drains accepted tail audio and reports failures without discarding committed recordings.

Custom WebSocket adapters require an explicitly agreed protocol and authentication arrangement; they do not automatically implement the default backend HTTP path. The Chinese reference documents the optional JSON-header/binary-frame format. Do not infer support from an unrelated provider's chat-completion endpoint. Keys for default model calls remain in Python. See [API](API.md) and [audio quality](AUDIO_QUALITY.md).
