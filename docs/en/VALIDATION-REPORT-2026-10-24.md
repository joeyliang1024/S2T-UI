# Web/Python/Kubernetes validation — 2026-10-24

[繁體中文及原始證據](../reports/WEB_PYTHON_K8S_2026-10-24.zh-TW.md) | English

This report summarizes the recorded local validation, not a promise about other environments. The detailed report and machine-readable evidence remain the source for measured values.

## Environment

The isolated deployment used a single-node ARM64 Colima/K3s cluster, one Nginx frontend Pod, and two complete Python backend Pods. PostgreSQL, MinIO, Redis/Sentinel, Prometheus, and Grafana were real services. Application images were `s2t-frontend:web-20261024-r5` and `s2t-backend:web-20261024-r5`.

## Results

- Frontend checks: type checking, architecture rules, 48 unit tests, and web build passed.
- Python tests: 32 passed and 1 skipped using the repository Python environment. The host FFmpeg-dependent case was skipped; container FFmpeg was verified separately.
- Browser end-to-end testing passed using automatic local Chrome fallback.
- Development launcher testing verified simultaneous frontend/backend startup, environment-selected ports, proxying, and shutdown.
- Deployed browser testing covered login, account administration, settings, recording chunks and finalization, captions, translation, summary streaming, voiceprints, persistence, playback-related storage access, and logout.
- Direct tests against two different backend Pods verified shared authentication, settings CAS, chunk handoff, recording reads, and logout revocation.
- Native FFmpeg, Silero, Sherpa, and Linux ARM64 Nemotron CPU paths were verified.
- Grafana dashboard queries and two backend scrape targets were checked. Browser ASR/translation observations matched Prometheus histogram count/sum within the recorded numerical tolerance.

Evidence: deployment (local historical data), functions (local historical data), monitoring (local historical data), and native Nemotron (local historical data).

## Limits

External ASR, translation, and summary integrations used mock services. Existing real model endpoints were unreachable in unauthenticated checks, so real recognition accuracy, upstream latency, and production capacity remain unverified. No credentials were sent to an unverified replacement endpoint.

GPU hardware was not tested. The recorded Kubernetes rollout does not mean a public production deployment was completed. Compose configuration and image builds were checked; the simultaneous Compose application was not started on ports already occupied by the Kubernetes test deployment.

Percentiles shown in Grafana are histogram estimates. Browser/Prometheus agreement verifies measurement handling, not external model speed or hardware microphone/display latency. See [observability](OBSERVABILITY.md) and [validation](VALIDATION.md) for reproduction guidance.
