# Reproduce results

Run commands from the repository root. Follow the [quick start](../../README.en.md) to install locked dependencies and configure separate frontend/backend environment files. Use an isolated test environment. Ports default to 5173/8787 and are loaded from the respective environment files.

## Current caption merging

Normal capture remains 3000ms/250ms. Only the display punctuation split threshold changes from 24 to 40 characters; explicit speech boundaries, speaker changes, frozen membership and existing limits remain. No model download is needed to verify this display rule.

```sh
node tests/smoke/caption-display-group-smoke-test.cjs
node tests/smoke/model-adapter-smoke-test.cjs
node tests/smoke/vad-smoke-test.cjs
npm run check
S2T_TEST_EMBEDDED_PG=1 npm run test:backend
```

Check that compatible punctuated 24–39-character fragments merge, while explicit boundaries and other guards still split rows. Tests do not clear existing recordings.

## Deployed workflow and monitoring

Follow [deployment](DEPLOYMENT.md) to start isolated Kubernetes with one frontend and two backend Pods. Start forwards in one terminal:

```sh
node scripts/forward.cjs --monitoring
```

Then run in order, using the test deployment's bootstrap admin settings:

```sh
S2T_ALLOW_DEPLOYMENT_TESTS=true npm run test:deployment
S2T_ALLOW_DEPLOYMENT_TESTS=true npm run test:replicas
S2T_ALLOW_DEPLOYMENT_TESTS=true npm run test:monitoring
```

Tests create/delete their own identities. Monitoring requires the latest browser baseline from the same Pods; do not roll the deployment between checks. Playwright tries `S2T_BROWSER_EXECUTABLE`, installed Chromium, then local Chrome/Edge/Chromium. Existing 500ms model mocks establish integration behavior, not recognition quality. Report model time, HTTP round trips, browser paint and histogram-estimated Grafana percentiles separately.

## 500 users for 600 seconds

[Historical results](VALIDATION_2026-10-26.md): three-second cadence passed capacity; two-second cadence failed; browser translation P90 3.023s failed the strict under-three-second target. These are distinct test NT identities, 16kHz virtual PCM and separate 500ms ASR/translation mocks, not 500 physical browsers or real inference capacity. Capacity was measured on backend r23/r24; subsequent UI changes do not imply a repeated load test.

Prepare 500 distinct test-user JWTs as a private JSON string array in the isolated environment. See [API boundaries](API.md) and [NT login](NT_LOGIN.md) for authentication. Do not use production identities or commit tokens. Reserve 9.6GB for recordings plus assembly/database/image headroom. Record image tags, CPU/RAM, replicas, mock settings, locks and final results.

```sh
export S2T_ALLOW_DEPLOYMENT_TESTS=true
export S2T_LOAD_TOKENS_FILE=/absolute/private/test-user-tokens.json
export LOAD_POD=s2t-recording-reproduce
export LOAD_SECONDS=600
export LOAD_CADENCE_MS=3000
npm run test:load:k8s -- start
```

Explicit context/namespace come from `deploy/k8s/.env`; verify they identify an isolated cluster. Watch logs using kubectl with that context/namespace. Collect only after report generation, not simply after waiting 600 seconds: assembly, SHA256 readback and deletion have separate drain time.

```sh
S2T_LOAD_REPORT=/tmp/s2t-reproduced-load.json npm run test:load:k8s -- collect
npm run test:load:k8s -- cleanup
```

Cleanup removes only runner Pod, ConfigMap and Secret. Separately remove owned identities through the admin API using the recorded UUID/NT inventory, remove private JWTs and verify revocation. Clean owned test resources on failure/interruption as well. Preserve unrelated identities/data. The runner's default is two seconds: explicitly set 3000ms for the historically passing condition.

Acceptance requires duration, offered/completed work, drops, original HTTP failures/retries, exact recording hashes and cleanup. A short test, recovered retries or extended production interval cannot establish a full pass.

## Optional local ASR research

This is not required for the display-merge fix. On Apple Silicon, use an isolated Python environment with `mlx-whisper==0.4.3`, NumPy and `imageio-ffmpeg==0.6.0`. Do not add them to production requirements. Download `mlx-community/whisper-small-mlx` config/weights to a dedicated test directory. Historical weights SHA256: `55b6674c9b339702d486e2b1573839a66f8ec8f821ed2886993ef717a86b09f5`. Verify the hash; changed weights are a different run.

Download `test/test-000000.tar` from `adi-gov-tw/Taiwan-Tongues-ASR-CE-dataset-zhtw` on Hugging Face and extract its flat MP3/JSON entries into `music/taiwan-tongues/clips/`. Follow its TRAIL–TWM license, do not redistribute audio, and validate archive paths before extraction. The evaluator selects four unique speakers per slow/medium/fast tier from candidates with at least ten characters.

```sh
FFMPEG=/absolute/path/to/ffmpeg node scripts/evaluation/segmentation-sweep.cjs /tmp/s2t-asr-reproduce
/absolute/path/to/isolated/python scripts/evaluation/local-whisper-score.py /tmp/s2t-asr-reproduce \
  --model /absolute/path/to/whisper-small-mlx --ffmpeg /absolute/path/to/ffmpeg
```

Outputs include chunk metadata and raw/filtered model text. This small tuning set is not held-out validation and establishes neither Breeze accuracy, browser latency nor 500-user capacity. The scorer exits without a persistent server. After confirming processes have exited, remove only this run's environment, weights/cache and generated WAVs; retain the curated outcome.

## Version-control policy

Commit curated Markdown results, reproduction instructions, executable tests/evaluators and production locks. Ignore `experiment/` except its root README, `docs/reports/evidence/`, downloaded audio/models, private credentials and withdrawn capture-parameter experiments. Generate outputs in `/tmp` or ignored locations. Fresh clones do not contain raw historical evidence; reproduction generates new measurements. Re-run vulnerability audits rather than treating historical zero-known-advisory counts as current guarantees.
