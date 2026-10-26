# Recording pipeline validation — 2026-10-24

> Historical report: measurements and commands describe the recorded version. Use [current results](VALIDATION_2026-10-26.md) and [reproduction](REPRODUCE.md) for current scope and operations.


[繁體中文](../reports/RECORDING_PIPELINE_2026-10-24.zh-TW.md) | English

The existing local Colima/K3s environment now runs frontend `s2t-frontend:web-20261024-r8` with one ready Pod and Python backend `s2t-backend:web-20261024-r5` with two ready Pods. Backend APIs and shared storage were unchanged.

## Results

- Type checking, architecture rules, 50 unit tests, and the web build passed.
- Both browser end-to-end tests passed using local Chrome fallback and automatic repository `.venv` selection.
- Two minutes of simulated blocked upload caused no capture backpressure. Catch-up preserved bytes exactly and read bounded ranges.
- Lost ACK tests kept the same retry payload while additional audio continued to commit. Account changes, permanent client errors, and bounded network finalization were checked.
- Real Chrome exercised AudioWorklet capture, the OPFS sync Worker, background upload, and sample-count-to-WAV consistency. Offline finalization, reload recovery, uncommitted tail exclusion, and isolated cleanup passed.

## Deployed fault injection

Recording upload was blocked for 65 seconds. The first three upload attempts were committed by the real Python/MinIO backend, but their ACKs were deliberately discarded. In total, 24 upload requests were interrupted.

The browser had committed 64 seconds of local audio at the checkpoint and remained in `recording` state. Captions and translations continued with the isolated mock model service. After recovery and draining, it saved a 7,988,268-byte WAV and 26 subtitle segments; background processing reached `completed`.

Account/configuration CAS, recording chunk handling, summaries, voiceprints, native audio paths, logout, and test-account cleanup also passed. Grafana queries and both backend scrape targets were healthy. Browser timing count/sum matched Prometheus; the measured clock difference was approximately 0.019 seconds.

## Limits

This was not a 500-user capacity test. External ASR/translation/summary services were mocks, so real model quality and capacity remain unverified. Local disk stalls, exhausted browser storage, or hardware failure can still trigger protective pauses. Safari/Firefox hardware, GPU, multi-node failures, and production capacity were not validated. Background upload stops when the browser closes; use local recovery after reopening.

See [recording reliability](RECORDING_RELIABILITY.md) for implementation choices, primary sources, and reproduction commands.

Evidence: summary (local historical data), deployment (local historical data), fault test (local historical data), monitoring (local historical data).
