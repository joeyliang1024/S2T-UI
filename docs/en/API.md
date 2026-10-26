# API and integration boundaries

[繁體中文](../reference/WEB_GATEWAY.zh-TW.md) | English

Python composes its routes in `backend/app/api.py`. Authentication, account administration, data/settings, recordings, and media routes are defined in `backend/app/routes/`. Use these definitions for exact request schemas and status codes.

## Authentication

New clients send `{"NT":"your.nt","password":"your-password"}` to `POST /api/auth/login`. Registration and administrator creation use NT, password and Department, with no separate Account input. See [NT login](NT_LOGIN.md) for case handling and existing-user compatibility.

## Model integration

Browser HTTP model requests go through authenticated Python endpoints including `/api/transcriptions`, `/api/translations`, `/api/summaries`, and `/api/diarizations`. The backend manages model credentials and upstream calls. Production Nginx preserves the frontend origin and streams responses without buffering.

ASR services use an OpenAI-compatible audio transcription interface: WAV audio, model, and language are sent using multipart form data. Chunk request/response ASR produces final caption segments; it does not imply incremental token streaming. Chunk duration depends on caption-speed settings and load, rather than a universal fixed duration.

Translation and summary services use their configured chat-completions endpoints. Streaming text support does not imply streaming audio input support. Custom WebSocket adapters require an explicitly agreed service protocol; their transport contract is separate from the default Python HTTP model flow.

The frontend adapter interface is in `frontend/src/features/models/contracts.ts`. Transcript events have stable IDs, revisions, partial/final status, relative start/end times, source text, and optional detected language/translation. Older revisions must not overwrite newer revisions. Preserve original sample offsets through resampling and segmentation.

## Diarization

Local diarization uses the prepared native models; remote diarization sends a complete PCM16 WAV using multipart form data. Remote responses may expose `exclusive_diarization`, `segments`, or `diarization`. For example:

```json
{
  "exclusive_diarization": [
    { "start": 0.24, "end": 2.91, "speaker": "SPEAKER_00" }
  ]
}
```

The application maps a subtitle to the speaker turn with the greatest time overlap and preserves the subtitle's original text/time range. This remote diarization format is not a universal OpenAI API specification.

## Accounts and voiceprint sharing

Administrative authority comes from the account role, not its name or display department. Shared voiceprints require verified authorization and explicit user consent. Public registration metadata alone cannot grant access. Private voiceprints remain private.

Administrative sharing authorization uses `GET`/`PUT /api/admin/users/:id/sharing-authorization`, with a PUT body containing `approved` and `department`. Only an administrator can change it. Organization sharing requires both parties to be approved; department sharing also requires matching trusted departments. Revocation affects subsequent matching queries.

## Health and verification

Use `/livez` for process liveness, `/readyz` for required dependencies, and `/metrics` for per-Pod monitoring. See [validation](VALIDATION.md) for account isolation, cross-Pod recording, CAS, and token-revocation checks.
