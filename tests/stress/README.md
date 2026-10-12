# Browser recording pressure test

Run from the repository root:

```sh
npm run recording:stress -- --seconds 600 --report /absolute/path/results.json
```

Use `--only normal-48k` or `--only normal-96k` to run a single continuous scenario. The current harness uses installed Google Chrome and the bundled Codex Playwright runtime; no external ASR service or production account is used.

The fixture runs the production AudioWorklet with an oscillator, actual browser OPFS writes, the production PCM writer/resampler/model adapter, the current correction runner and preview retention code extracted from the controller, and the React Highlight component. It measures real wall time, frame handling, main-thread heartbeat delay, long tasks, JavaScript heap samples, write durations, queue pressure, and completed corrections. Every accepted recording batch is verified against the final WAV using SHA-256.

Five concurrent isolated browser contexts cover ordinary 48/96 kHz capture, a three-second write stall every thirty seconds with new buffering, the same stalls with the old byte thresholds/batch size, and a single ten-second stall. The old-threshold scenario is a control, not a checkout of the complete old application. Short stalls must not pause the new writer; sustained stalls must pause and resume with every accepted byte intact.

Pass criteria also require actual correction results, no ASR gaps/page errors, heartbeat p95 below 100 ms and maximum below one second, heap peak below 256 MiB, and exact resampled timeline length. Per-frame p95 timings are sampled once per 32 frames; frame maximum includes every frame. Heap is sampled every five seconds, so it is not a native/process-memory peak.

This does not validate a physical microphone, the user's existing browser profile, production ASR latency, remote recording upload, or the full application navigation/authentication flow. It is a real browser pressure test of the recording and correction paths, not a complete end-to-end product test.
