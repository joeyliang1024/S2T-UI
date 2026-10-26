# Dependency, performance and UI review — 2026-10-25

[繁體中文](../reports/SECURITY_CODE_REVIEW_2026-10-25.zh-TW.md) | English

This was a read-only product review with isolated reproductions. Dependencies,
application code and running deployments were not changed during this review.
The current version cannot be described as CVE-free or validated for 500 real users.

## Dependency audit

Full `npm audit --json`, including development dependencies, reported zero known
vulnerabilities. `pip-audit` scanned 71 pinned package versions, 77 packages in the
local virtual environment, and 64 packages in the deployed backend container.
No Python packages were skipped. Combining these results yields **15 distinct
advisories across five packages**; raw duplicated records were deduplicated.

| Package | Installed | Unique advisories | Fixed-version floor | Scope |
| --- | --- | --- | --- | --- |
| starlette | 0.49.3 | 5 | 1.3.1 | Application runtime |
| anyio | 4.12.1 | 2 | 4.14.2 | Application runtime |
| python-dotenv | 1.2.1 | 1 | 1.2.2 | Environment loading |
| pytest | 8.4.2 | 1 | 9.0.3 | Local/CI development tooling |
| pip | 25.0.1 | 6 | 26.2.0 | Backend base-image tooling, not in application locks |

These are affected-version matches, not 15 proven remotely exploitable flaws.
Windows StaticFiles and HTTPEndpoint conditions are not used in the current Linux
application. Its primary authorization middleware uses `scope['path']`; an auth
bypass was not demonstrated. The application does not call dotenv's rewriting
functions or AnyIO's process-pool API. pip issues concern package installation or
download, and the Python 3.12 runtime already avoids the vulnerable fallback in
CVE-2025-8869 through PEP 706 support. These limitations do not justify a zero-CVE claim.

Upgrades must be coordinated: installed FastAPI 0.128.8 requires `starlette<1.0.0`,
and pytest-asyncio 1.2.0 requires `pytest<9`. Regenerate hashed locks, validate
compatible combinations, rebuild images and audit again.

Sources: [Starlette](https://github.com/Kludex/starlette/security/advisories/GHSA-86qp-5c8j-p5mr),
[AnyIO](https://github.com/agronholm/anyio/security/advisories/GHSA-82r6-8w77-94w6),
[dotenv](https://github.com/theskumar/python-dotenv/security/advisories/GHSA-mf9w-mj56-hr94),
[pytest](https://github.com/advisories/GHSA-6w46-j5rx-g56g),
[pip](https://github.com/advisories/GHSA-qwm4-qh6w-59xr).
Exact CVE/GHSA inventory and scan coverage (local historical data).
This package audit does not cover OS/Nginx/FFmpeg/native-model binary image CVEs,
unpublished vulnerabilities or a full penetration test.

## Confirmed bugs

1. **P1 — Audio cleanup races new session references.**
   `backend/app/recordings.py:155,185` and `backend/app/routes/data.py:127`.
   Cleanup checks references in its first transaction, but the deletion phase only
   locks the recording. Another Pod can commit a new referencing session, after
   which deletion succeeds and the session's WAV returns 404. Reproduced again
   with two applications and isolated PostgreSQL. Shared reference/deletion-state
   transaction rules are needed.
2. **P1 — Recording finish fails after storage exceeds the 10-second DB idle limit.**
   `backend/app/recordings.py:125,139` and `backend/app/storage.py:189`.
   All chunk reads and output streaming happen inside a PostgreSQL transaction.
   Delaying storage by 10.5 seconds with the default DB configuration produced
   HTTP 503 at 10.52 seconds; the manifest remained `recording`. Chunks were retained,
   so this reproduction does not establish permanent audio loss. Long storage I/O
   also occupies DB/account-fencing capacity. Use short fenced state transactions
   around external storage work rather than merely increasing the idle timeout.
   Reproduction (local historical data),
   output (local historical data).
3. **P2 — Async OPFS fallback and metadata can wait indefinitely.**
   `frontend/src/features/capture/recording/adapters/opfs-pcm-recording.ts:38`.
   Worker deadlines do not cover createWritable/write/close in fallback/metadata
   paths. Reproduced again with the production adapter and a nonresponding writable;
   append/finish never reach the network-finalization deadline.
4. **P2 — A new tab cannot discover a closed tab's pending session edits.**
   `frontend/src/features/sessions/services/session-outbox.ts:17,57`.
   The key includes a sessionStorage tab owner and reads only that key. Real Chrome
   reproduced an undiscovered pending edit after closing/reopening a tab; its old
   IndexedDB entry remains intact. Recovery requires account-level discovery and
   safe inactive-owner handoff before CAS/rebase and acknowledgment.
5. **P2 — Editing the trusted department alone is not saved.**
   `frontend/src/features/settings/views/SharingAuthorizationEditor.tsx:14,32`.
   Only the approval checkbox invokes save. Editing the field, blurring and reloading
   discarded the change with zero save requests. Reproduced against the production
   React build with isolated API fixtures. Provide explicit or blur-based saving
   without requiring an approval change.
   Reproduction (local historical data).

Issues 1, 3 and 4 were previously documented and remain present; issues 2 and 5
were newly confirmed in this review. Earlier reproductions:
[recording follow-up](RECORDING_FOLLOWUP_2026-10-25.md).

## Performance and UI

The eight 1536×1024 PNGs total 10.38 MB, approximately 1.22–1.45 MB each. Most header
artwork renders only 208px wide, smaller on mobile. Responsive thumbnails/WebP
could reduce transfer cost. Images are requested for the active page, not
necessarily all eight at initial load. CSV parsing is off-loop, but matching still
scans rows synchronously; the real CSV was not supplied, so its performance and
500-user translation capacity remain unmeasured.

The existing navigation/browser test passed all 48 page/theme/viewport combinations
and artwork/motion/reduced-motion checks. This does not cover department persistence.
UI output (local historical data).

## Current 500-concurrent-request probe

The current version was rerun with 500 requests at concurrency 500: all returned
HTTP 200, total 1.052s, successful throughput 475.48 req/s, P95 927.92ms, P99 937.53ms,
event-loop lag P95 8.10ms, peak RSS 107.0 MiB.
Raw output (local historical data).

This is one short ASGI transcription burst using one test account, isolated
PostgreSQL, distinct idempotency keys and a **30ms model mock**. It excludes real
TCP/Nginx/cross-Pod networking, MinIO, browsers, continuous capture, translation/CSV,
real inference, long-running stability and 500 distinct accounts. It is **not a
500-user end-to-end capacity pass**. A single run should not be compared with the
older host measurement as proof of a performance regression.

Prioritize coordinated security upgrades and both P1 recording transaction issues,
then OPFS/outbox/UI persistence. After fixes, validate staged 500-account sustained
workloads with real models and shared storage. A passing reproduction means the
bug was exposed, not that it was repaired.
