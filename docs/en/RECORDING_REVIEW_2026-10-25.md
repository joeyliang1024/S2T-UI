# Recording and cleanup review — 2026-10-25

Status: all five findings are fixed. Findings and original reproduction assertions below describe the pre-fix implementation. See [fix report](RECORDING_FIXES_2026-10-25.md).

[繁體中文](../reports/RECORDING_REVIEW_2026-10-25.zh-TW.md) | English

Scope: workspace capture, PCM buffering, OPFS persistence, remote chunks, and post-save cleanup. This was a review with minimal reproductions; no application fixes, user-data cleanup, or deployment changes were performed.

1. **P1 — A storage failure can resume capture while silently ignoring new audio.** When buffering pressure precedes a failed write, the failure handler pauses capture but the writer's finally handler immediately emits pressure=false. The controller resumes recording while every later push returns because the writer remains failed. Reproduced the exact event sequence and absence of later writes. Source: `buffered-writer.ts:79` and `useAppController.ts:1563`.
2. **P2 — Successful full-file fallback cannot clean an unfinished remote upload.** Remote finalization failure can leave the original manifest in recording/finishing state. The normal DELETE only accepts completed/deleting and repeatedly returns 409. Local OPFS is removed before this failing step. Reproduced the backend rejection with in-memory storage. Source: `backend/app/recordings.py:154` and `useAppController.ts:1762`.
3. **P2 — Rejected chunk conflicts leave untracked blobs.** Append writes a digest-keyed blob before checking the manifest conflict. A rejected request leaves its new blob outside the manifest, and ordinary recording deletion does not find it. Reproduced two blobs for one accepted chunk and one blob remaining after cleanup. Source: `backend/app/recordings.py:50`.
4. **P2 — Reload recovery omits remote temporary-recording cleanup.** The reconstructed acknowledgement removes the live draft and local OPFS but never removes remote chunks, manifest, or assembled temporary audio. Confirmed by source tracing, not by deployed fault injection. Source: `useAppController.ts:852` and `recover-recordings.ts:29`.
5. **P2 — A silent OPFS Worker can leave recording stop pending indefinitely.** Startup has a timeout, but individual writes have no deadline. Local drain/finalization occurs before the network deadline starts, so the 30-second network timeout cannot release it. Reproduced a pending request with no I/O timer; explicit close was required. Source: `opfs-write-client.ts:35` and `pcm-sinks.ts:34`.

Fix the terminal failure/resume transition first. Then add a verified abandon path and durable, retryable cleanup intents shared by normal save and reload recovery. Blob compensation must be concurrency-safe; do not indiscriminately delete digest keys or active recordings. Add Worker liveness/deadline handling while preserving committed data.

The existing type, architecture, 50 unit-test, and web-build checks passed. Those checks miss these failure combinations. This review does not establish 500-user capacity, real external-model performance, Safari/Firefox hardware compatibility, or live-cluster health.

Evidence: summary (local historical data), buffer failure reproduction (local historical data), silent Worker reproduction (local historical data). Run Node reproductions from the repository root; they do not access user recordings or external services.
