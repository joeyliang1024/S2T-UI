# Recording persistence and slow uploads

[繁體中文](../guide/RECORDING_RELIABILITY.zh-TW.md) | English

Local PCM persistence and network upload now have independent lifecycles. A slow recording upload no longer occupies the local writer queue. Caption processing retains its separate audio/model path.

## Persistence and upload

AudioWorklet frames are batched into committed OPFS chunks. A background uploader reads only committed ranges, materializing at most one 1 MiB upload range at a time. It advances chunk/sample cursors only after a matching durable ACK. Lost responses retry the same range through the backend's immutable chunk handling.

Supported browsers use a dedicated Worker with `createSyncAccessHandle()`, flush, close, and a separate commit marker. Other browsers use the asynchronous OPFS implementation. OPFS v2 recovery excludes an uncommitted final chunk, including partial synchronous writes after a crash; v1 recovery remains supported. API completion is not a guarantee against every hardware power-loss scenario.

Transient failures use exponential backoff with jitter. Permanent client errors stop automatic retries. Account changes fence old uploads. Credentials remain outside the OPFS Worker.

On stop, local audio is finalized first. Remote finalization has a 30-second network deadline and cancels outstanding requests on timeout. If remote finalization fails, the existing full-file save/download and recovery path remains available. An unfinished remote upload is never promoted as complete. Closing the page stops background work; after reload, use local recovery. Uploading after the browser is closed is not implemented.

## Cleanup after a durable save

Normal save and reload recovery share the same cleanup path. The backend verifies the replacement audio, session ID, audio key, processing token, and non-running state before terminating the old upload. Cleanup removes remote backups first, then the live draft, and OPFS last. A failed step retains local recovery information for a later reload/retry.

Chunk writes persist an intent before storing bytes. Rejected conflicts do not create objects; cleanup sweeps the capture's exact prefix, including legacy orphan chunks. A small deleted fence remains to reject late uploads; it contains no audio.

Each Worker write has a 30-second deadline. Timeout terminates the Worker, reports failure, and retains committed audio. Ambiguous writes are not blindly retried. Permanent write failure cannot be cleared by a pressure-release callback.

## Limits

Local disk stalls, exhausted OPFS quota, or failed writes can still trigger protective capture pauses. The existing RAM buffer remains approximately 60 seconds, capped at 16 MiB. Audio during a protective pause can be missing. Worker I/O cannot make persistent disk failures disappear.

If the entire network is offline, external ASR and translation may also be unavailable. This change prevents recording-upload backpressure from stopping capture; it does not provide offline model inference. Preserve browser data containing unsaved recordings. Safari/Firefox hardware compatibility, storage limits, and 500-user capacity require separate tests.

## Validation

```sh
npm run check
npm run test:e2e
S2T_ALLOW_DEPLOYMENT_TESTS=true S2T_TEST_RECORDING_UPLOAD_STALL_MS=65000 S2T_TEST_RECORDING_CLEANUP_RELOAD=true npm run test:deployment
```

Tests cover two minutes of simulated blocked upload, exact byte catch-up, lost ACKs, account fencing, partial writes, commit ordering, actual Chrome AudioWorklet/OPFS Worker behavior, and reload recovery. The opt-in deployment test blocks recording uploads for 65 seconds against isolated localhost Kubernetes, then checks continued capture/captions and final persistence. It creates and removes a dedicated account.

## Design references

- [Chrome AudioWorklet design patterns](https://developer.chrome.com/blog/audio-worklet-design-pattern): separate realtime audio from waiting work. We retain the existing worklet and avoid adding SharedArrayBuffer isolation requirements.
- [MDN synchronous OPFS access](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemFileHandle/createSyncAccessHandle): dedicated Worker I/O with an asynchronous compatibility fallback and explicit commit markers.
- [tus resumable-upload protocol](https://tus.io/protocols/resumable-upload): coordinate progress using the server-confirmed offset. We retain existing cross-Pod chunk/sample ACKs; this application is not a tus-compatible server.
- [S3 multipart uploads](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html): retry failed parts independently. We retain Python account authorization and MinIO storage instead of exposing storage credentials or introducing browser-to-S3 uploads.

## Extreme storage tests (2026-10-25)

A real Chrome AudioWorklet continued recording through a 600-second blocked upload: 57,793,536 PCM bytes, no pressure pause, byte-exact upload catch-up, reload recovery and acknowledgement cleanup. A separate 96 kHz test offered 30 times real-time audio, committing 115,200,000 bytes (600 seconds equivalent) in about 19.94 seconds. All 300 writes completed, P95 about 4.9 ms, without pressure pauses; contents matched and cleanup was verified. These isolated browser results do not establish 500-user backend capacity.

Fault injection covers stalled writer creation, writes and close; quota exhaustion; an abort that never resolves; and late completion after timeout. Production storage deadlines remain 30 seconds; only the test bundle accelerates them to 40 ms. The committed prefix stays recoverable, further append/finish calls reject, and shutdown is bounded. Physical storage failure can still lose uncommitted memory; capture pauses protectively rather than promising unlimited buffering.

Reproduce with `S2T_OPFS_STALL_MS=600000 node tests/smoke/opfs-recording-browser-smoke-test.cjs`, `node tests/stress/opfs-throughput.cjs`, and `node tests/smoke/opfs-storage-extremes-smoke-test.cjs`. Tests use new isolated browser contexts and do not clear existing site recordings.

### Upload batching and local commits

Recording still commits to browser OPFS approximately every 2 seconds. Network uploads independently accumulate ranges of at most 1 MiB, with a randomized 15–30 second deadline to spread requests across users. Stopping recording flushes the remaining data immediately. Retries preserve the exact byte range; progress advances only after a durable server acknowledgement. Batching reduces upload request volume without changing caption inference scheduling.
