# Recording and cleanup fixes — 2026-10-25

> Historical report: measurements and commands describe the recorded version. Use [current results](VALIDATION_2026-10-26.md) and [reproduction](REPRODUCE.md) for current scope and operations.


[繁體中文](../reports/RECORDING_FIXES_2026-10-25.zh-TW.md) | English

All five findings from the [recording review](RECORDING_REVIEW_2026-10-25.md) have been fixed and deployed in the existing isolated local Kubernetes environment. Images: `s2t-frontend:web-20261025-r1` with one ready Pod, and `s2t-backend:web-20261025-r1` with two ready Pods.

## Fixes

1. Permanent write failures cannot emit a pressure-release resume or be cleared by the controller. The failed recording remains paused and draining rejects explicitly.
2. A verified cleanup endpoint permits retiring an unfinished upload only after checking replacement audio, session/key/token, and non-running state. Missing audio, stale tokens, and other accounts cannot authorize cleanup.
3. Upload intent is committed before object writes. Per-recording transactions coordinate writes/finalization/cleanup. Rejected conflicts create no blob, failed writes remain tracked, and exact-prefix cleanup also removes legacy orphan chunks.
4. Normal save and reload recovery share remote → draft → OPFS cleanup. Local recovery metadata remains until remote cleanup succeeds. Registration schedules retry even without subsequent edits.
5. Individual Worker requests have a 30-second deadline. Timeout terminates the Worker, rejects pending writes, and preserves committed recovery data; late replies cannot turn failure into success.

Cleanup commits a deleting fence before object removal and retains a small audio-free deleted fence afterward. Partial cleanup is retryable, late PUTs cannot resurrect a deleted capture, and authoritative audio/other capture namespaces are preserved. Legacy DELETE still refuses unfinished uploads without a verified replacement.

## Validation

- Frontend type/architecture checks, 51 unit tests, and web build passed.
- Python: 38 passed, 1 skipped with isolated embedded PostgreSQL. The skipped host FFmpeg case was covered by actual container transcoding.
- Browser end-to-end: 2/2 passed using repository Python and automatic local Chrome fallback.
- PostgreSQL replicas verified conflicting upload coordination, no orphan creation, cross-replica cleanup, and late-upload rejection.
- Actual backend Pods passed shared JWT, CAS, recording handoff, and logout revocation checks.
- Grafana queries, two backend scrape targets, and browser/Prometheus timing agreement passed.

The deployed fault test blocked recording uploads for 65 seconds and discarded three durable ACKs while capture/captions continued. It then forced remote finalization to fail, verified complete-file WAV fallback, interrupted cleanup, and reloaded the page. Recovery removed the remote temporary recording and local OPFS; authoritative WAV bytes were unchanged.

```sh
S2T_ALLOW_DEPLOYMENT_TESTS=true S2T_TEST_RECORDING_UPLOAD_STALL_MS=65000 S2T_TEST_RECORDING_CLEANUP_RELOAD=true npm run test:deployment
```

These are not 500-user capacity results. External model services were mocks. Real-model capacity/quality, Safari/Firefox hardware, GPU, and multi-node failures remain unverified. Physical storage/quota failures can still require protective pauses and lose uncommitted audio.

See [recording reliability](RECORDING_RELIABILITY.md), summary (local historical data), deployment (local historical data), fault-test evidence (local historical data), and monitoring (local historical data).
