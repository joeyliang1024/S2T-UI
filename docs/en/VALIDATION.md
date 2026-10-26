# Validation and browser fallback

[繁體中文](../guide/VALIDATION.zh-TW.md) | English

Install dependencies using the [quick start](../../README.en.md), then run from the repository root:

```sh
npm run check
S2T_TEST_EMBEDDED_PG=1 npm run test:backend
npm run test:e2e
npm run test:dev
```

`check` runs TypeScript, architecture checks, frontend unit tests, and the web build. Python, browser, development-launcher, and deployment tests are separate. Python selection prefers `S2T_PYTHON_EXECUTABLE`, then the repository `.venv`, then system Python.

## Playwright fallback

The shared helper is `tests/helpers/browser.cjs`. It selects:

1. An existing executable supplied by `S2T_BROWSER_EXECUTABLE`.
2. Installed Playwright Chromium.
3. A local Chrome, Edge, or Chromium installation for the host OS.

If none is available, the test reports how to install or provide a browser. Missing Playwright-managed browser binaries alone do not require downloading a browser when a supported local browser exists.

## Deployed integration tests

Start the isolated deployment and local forwards first:

```sh
S2T_ALLOW_DEPLOYMENT_TESTS=true npm run test:deployment
S2T_ALLOW_DEPLOYMENT_TESTS=true npm run test:replicas
node scripts/forward.cjs --monitoring
S2T_ALLOW_DEPLOYMENT_TESTS=true npm run test:monitoring
```

These tests target a localhost isolated environment and create/delete dedicated test accounts. Do not run them against production data. They cover authentication, settings CAS, recording chunk upload/finalization, storage cleanup, captions, translation, summary streams, voiceprints, cross-Pod access/revocation, and monitoring.

Manual acceptance should include microphone permission, continuous recording, caption/translation rendering, stopping and replaying after reload, summaries, account isolation, logout, and saving under slow network conditions. Preserve browser storage containing unsaved audio.

## Capacity and model quality

Functional integration tests are not load generators. Use real models and representative audio before making capacity claims. Record image versions, resources, replica counts, audio duration, speech ratio, caption-speed settings, model versions, and upstream quotas. Increase concurrency gradually while observing errors, end-to-end latency, queues, CPU/RSS, database connections, and object storage.

Verify recording finalization, job draining, and Pod restart recovery under load. Mock latency does not represent model compute cost, and two Pods do not imply twice the throughput. See the [latest validation report](VALIDATION_2026-10-26.md) for established results, exact workload cadences and capacity limitations.

### Reproducible mixed recording/model load

Run `npm run test:load:k8s -- start` with `S2T_ALLOW_DEPLOYMENT_TESTS=true`, `S2T_LOAD_TOKENS_FILE` pointing to a private JSON array of 500 distinct test-user JWTs, `LOAD_POD=s2t-recording-acceptance` `LOAD_SECONDS=600`, and `LOAD_CADENCE_MS=3000` for the historically passing workload. The selected context/namespace comes from `deploy/k8s/.env`. Every identity is validated before measurement. Credentials are mounted as a Secret and never written to reports. Use `collect` with `S2T_LOAD_REPORT` to save the report, then `cleanup` to remove the runner and its credential Secret.

The default workload sends ASR followed by translation every two seconds per user, with each mock fixed at 500ms. Independent 16kHz PCM uploads total 9.6 GB for 500 users over 600 seconds. Reserve additional storage for assembly, database growth, logs and Kubernetes disk-pressure thresholds. This uses a virtual PCM spool, not 500 real browsers; real browser OPFS, captions and paint measurements are separate.

Dropped work, failed operations, incomplete byte verification or missing cleanup confirmation fail acceptance. Report original HTTP failures even after retries. A generator that cannot maintain its schedule also fails; extending capture to eventually send all scheduled work cannot establish a successful 600-second run.

Current capture/merge settings: [caption speed](CAPTION_SPEED.md). Complete commands and cleanup: [reproduction](REPRODUCE.md).
