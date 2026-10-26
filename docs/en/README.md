# English documentation

[繁體中文](../README.md) | English

This documentation describes the React/Nginx frontend and Python backend. All commands run from the repository root unless stated otherwise.

| Task | Document |
| --- | --- |
| Install and start both services | [Quick start](../../README.en.md) |
| Understand components and storage | [Architecture](ARCHITECTURE.md) |
| Capture speed and caption merging | [Caption speed](CAPTION_SPEED.md) |
| Configure ports, credentials, and tuning | [Environment](ENVIRONMENT.md) |
| Build images, run Compose, deploy Kubernetes | [Deployment](DEPLOYMENT.md) |
| Inspect timing and Grafana | [Observability](OBSERVABILITY.md), [metric definitions](GRAFANA.md) |
| Handle slow recording uploads and recovery | [Recording reliability](RECORDING_RELIABILITY.md) |
| Reproduce curated results | [Reproduction](REPRODUCE.md) |
| Run tests and browser fallback | [Validation](VALIDATION.md) |
| Review current caption merging | [Caption merging](CAPTION_MERGE_2026-10-26.md) |
| Review measured results and limitations | [2026-10-26 validation report](VALIDATION_2026-10-26.md) |
| Integrate models, diarization, and account authorization | [API boundaries](API.md) |
| Sign in and manage users with NT | [NT login](NT_LOGIN.md) |
| Match CSV terminology in translation prompts | [Translation jargon](TRANSLATION_JARGON.md) |
| Prepare native audio models and GPU deployment | [Models](MODELS.md), [Silero](SILERO_VAD.md), [Sherpa](SHERPA_ONNX.md), [Nemotron](NEMOTRON.md), [GPU](GPU.md) |
| Recover administrators and data | [Recovery](ADMIN_RECOVERY.md) |
| Voiceprint access approval | [Sharing authorization](SHARING_AUTHORIZATION.md) |
| Audio, media import and model interfaces | [Audio quality](AUDIO_QUALITY.md), [Interface](INTERFACE.md), [Adapters](MODEL_ADAPTER.md), [Diarization](DIARIZATION_API.md) |
| Plan backend load acceptance | [Capacity testing](CAPACITY_TEST.md) |
| Work on the repository | [Contributing](../../CONTRIBUTING.en.md) |

The Kubernetes application uses one frontend Pod and two complete backend Pods. The default frontend and backend ports are 5173 and 8787; each is configured through its own environment file.

Current capture remains 3000ms/250ms; the display punctuation threshold is 40 characters. The latest deployed functional baseline is frontend r16/backend r24. Capacity numbers describe their original r23/r24 test profile, not a new load run after UI changes.

Dated reports and experiments are measurement evidence for their recorded versions. Use these current guides for operating the Python application. English and Traditional Chinese documentation should be updated together when commands, environment variables, deployment behavior, or verification scope changes.

Current prerelease: [0.2.0-rc.1 release notes](../releases/0.2.0-rc.1.md).
