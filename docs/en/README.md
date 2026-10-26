# English documentation

[繁體中文](../README.md) | English

This documentation describes the React/Nginx frontend and Python backend. All commands run from the repository root unless stated otherwise.

| Task | Document |
| --- | --- |
| Install and start both services | [Quick start](../../README.en.md) |
| Understand components and storage | [Architecture](ARCHITECTURE.md) |
| Configure ports, credentials, and tuning | [Environment](ENVIRONMENT.md) |
| Build images, run Compose, deploy Kubernetes | [Deployment](DEPLOYMENT.md) |
| Inspect timing and Grafana | [Observability](OBSERVABILITY.md) |
| Handle slow recording uploads and recovery | [Recording reliability](RECORDING_RELIABILITY.md) |
| Reproduce curated results | [Reproduction](REPRODUCE.md) |
| Run tests and browser fallback | [Validation](VALIDATION.md) |
| Review current caption merging | [Caption merging](CAPTION_MERGE_2026-10-26.md) |
| Review measured results and limitations | [2026-10-26 validation report](VALIDATION_2026-10-26.md) |
| Integrate models, diarization, and account authorization | [API boundaries](API.md) |
| Sign in and manage users with NT | [NT login](NT_LOGIN.md) |
| Match CSV terminology in translation prompts | [Translation jargon](TRANSLATION_JARGON.md) |
| Prepare native audio models and GPU deployment | [Models](MODELS.md) |
| Work on the repository | [Contributing](../../CONTRIBUTING.en.md) |

The Kubernetes application uses one frontend Pod and two complete backend Pods. The default frontend and backend ports are 5173 and 8787; each is configured through its own environment file.

Latest measurements: [2026-10-26 functional, security and capacity validation](VALIDATION_2026-10-26.md). Historical fixes: [2026-10-25 recording and cleanup validation](RECORDING_FIXES_2026-10-25.md), all five review findings resolved and deployed.

Latest: [recording pipeline fault-test report](RECORDING_VALIDATION_2026-10-24.md), frontend r8, including a 65-second upload outage and deliberately lost durable ACKs.

Dated reports and experiments are measurement evidence for their recorded versions. Use these current guides for operating the Python application. English and Traditional Chinese documentation should be updated together when commands, environment variables, deployment behavior, or verification scope changes.
