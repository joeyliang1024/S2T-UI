# Recording cleanup follow-up — 2026-10-25

[繁體中文](../reports/RECORDING_FOLLOWUP_2026-10-25.zh-TW.md) | English

The five previous fixes are implemented. This follow-up identified three adjacent unresolved cases; the first is a cross-transaction race not closed by the cleanup change. This was a review with isolated reproductions, not an application fix or deployment.

1. **P1 — New references can commit during audio deletion.** Cleanup checks references under session and recording locks, then releases the session lock before deletion. Session CAS does not reject references to deleting/deleted recordings. Reproduced with two apps and real temporary PostgreSQL: pause deletion, commit a new referencing session through the other app, resume deletion; the session remains while its WAV returns 404. Sources: `backend/app/recordings.py:185`, `backend/app/routes/data.py:127`. Reference creation and deletion need shared transactional rules.
2. **P2 — Asynchronous OPFS and metadata writes still lack deadlines.** Worker request deadlines do not cover direct createWritable/write/close calls used for fallback and recovery metadata. Production OpfsPcmRecording stayed pending with a deliberately stalled asynchronous writer; the remote finalization deadline is not reached. Source: `opfs-pcm-recording.ts:38`. All local I/O paths need bounded failure handling without blindly rewriting ambiguous commits.
3. **P2 — A new tab cannot discover a closed tab's pending outbox.** Keys combine account ID with a sessionStorage owner. A new tab gets a new owner and reads only that key. Real Chrome reproduced a null restore while the previous tab's unsynced snapshot remained in IndexedDB. Sources: `session-outbox.ts:17`, `:57`. Account-scoped discovery needs ownership coordination and CAS/rebase before acknowledging old snapshots.

The reference race is a specific concurrent API scenario, not proof that ordinary single-user recording always loses audio. A reload and a completely new tab are also different: the outbox finding concerns a new tab after the original closes.

Evidence: summary (local historical data), PostgreSQL race (local historical data), asynchronous OPFS (local historical data), Chrome outbox (local historical data). Run from the repository root using its installed test dependencies. PostgreSQL needs `S2T_TEST_EMBEDDED_PG=1` and `PYTHONPATH=backend:backend/tests`. Assertions intentionally demonstrate current defects rather than claim a fix.

No full regression or capacity suite was rerun in this review. Five-hundred-user capacity, real external-model performance, and Safari/Firefox hardware remain unverified.
