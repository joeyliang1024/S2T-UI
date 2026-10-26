# Validation results — 2026-10-26

Capacity and recording integrity passed for **500 distinct users over 600 seconds, one ASR→translation chain per user every three seconds**. The **two-second extreme workload failed**, and browser translation P90 was **3.023 seconds**, exceeding the strict under-three-second latency target. This is not a complete acceptance pass.

## Measured results

| Condition | Every three seconds | Every two seconds |
|---|---:|---:|
| Distinct NT identities | 500 | 500 |
| Audio production interval | 600.000 s | 600.874 s |
| Offered / expected chains | 100,000 / 100,000 | 149,376 / 150,000 |
| Dropped arrivals | 0 | 27,126 |
| HTTP errors / retries | 0 / 0 | 0 / 0 |
| Ultimately failed users | 0 | 0 |
| Recordings finished / SHA-256 verified / cleaned | 500 / 500 / 500 | 500 / 500 / 500 |
| Capacity verdict | Pass | Fail |

Each run recorded 9.6 GB with distinct user/frame markers. The three-second run completed 100,000 ASR and 100,000 translation HTTP 200 responses. Its synchronized real browser completed 250 captions and translations without browser or HTTP failures. Browser ASR P90 was 1.727 s and translation P90 was 3.023 s; the latter was not rounded into a pass.


## Corrections and performance

- NT and password are the visible login credentials; duplicate Account fields were removed with internal legacy compatibility retained. Sharing settings have explicit save behavior, with form and alignment corrections.
- Immutable recording chunks, short SQL commits, leased finalization and atomic reference/deletion protection avoid long transactions around slow object storage. OPFS and cross-tab outboxes have bounded waits, late-write isolation and acknowledgement-based cleanup.
- Known-length ASR uploads up to 256 KiB that do not require normalization use memory directly. Large, streaming and normalization inputs retain bounded temporary files. HTTP admission happens early; health checks use a separate connection pool.
- Ordinary ASR/translation requests use bounded aiohttp sessions, with cookie isolation, disabled redirects and no automatic POST replay. Summary streaming is unchanged. Mean Linux loopback client CPU fell from 2.292 to 0.250 seconds, approximately 89%; this is not an overall throughput percentage. The package was already in the audited locks and its version did not change.
- Fewer idempotency SQL round trips, an expiry index and single-owner short cleanup transactions reduce contention. Batches preserve active leases and SKIP LOCKED behavior. Redis checkout is bounded and parallel; simultaneous glossary reads are coalesced.
- Nginx upstream keepalive, dynamic DNS, descriptor budgets and memory were corrected while preserving URIs and streaming. Real container connection-reuse and upstream-IP-replacement tests passed.
- One supervised process per Pod publishes an atomic metrics snapshot every 15 seconds. API workers avoid expensive serialization; snapshots older than 45 seconds return 503. Shared queue gauges select the latest worker value within a Pod and the maximum across Pods, avoiding stale worker maxima and double counting.

References: [aiohttp sessions/pooling](https://docs.aiohttp.org/en/stable/client_reference.html), [PostgreSQL batch DELETE](https://www.postgresql.org/docs/current/sql-delete.html), [Nginx keepalive](https://nginx.org/en/docs/http/ngx_http_upstream_module.html#keepalive).

## Functional, security and timing checks

- Backend: **84 passed, one skipped**, including isolated real PostgreSQL, cross-Pod CAS/idempotency/deletion races, cancellation, timeouts, model transport and exporter recovery.
- Frontend: type checking, architecture checks, **54/54 unit scripts** and production build passed. Playwright has a local-browser fallback.
- Deployed full Web workflow, actual Chrome capture/history, FFmpeg, Silero, voiceprints, two-Pod JWT/recording handoff/logout, Grafana/PromQL and exact browser-to-Prometheus count/sum comparisons passed.
- Fresh npm audits, including development dependencies, and Python lock (71 packages), installed environment (78) and full audio container (65) audits all found **zero known vulnerabilities**. Final image versions match audit inputs. OS packages and unknown/future vulnerabilities are outside this finding.
- ASR/translation totals start at middleware entry and include HTTP admission, authentication, rate limiting, upload and model round trip. Model timing is not pure inference; client residual time includes proxy, browser and transport overhead. Grafana percentiles are histogram estimates, not exact sample percentiles.
- Post-cleanup Prometheus-to-host clock difference was approximately **0.308 seconds**. Snapshot collection delay, up to approximately 15 seconds plus scrape interval, is separate from clock skew.

## Browser storage and cleanup

OPFS commits approximately every two seconds. Independent network batches are at most 1 MiB with a 15–30-second deadline and a final tail flush. Progress and cleanup follow durable acknowledgement. Real Chrome recovered 58,754,560 bytes exactly after uploads were blocked for 600 seconds, with 307 commits and no capture-pressure pause events. A separate 96 kHz, 30-times-real-time test recovered 115,200,000 bytes for 600 audio seconds exactly. Storage stalls, quota and close errors have separate fault-injection coverage.

Remote backlog peaked at 34 seconds in the three-second run and 42 seconds in the two-second run; this is distinct from local recording-write pauses. These local tests do not launch 500 actual browsers.

Cleanup verified UUID, NT and department before deleting **505 synthetic identities**, preserving 2 other identities. Test Pods, ConfigMaps, credential Secrets and the private JWT file were removed; a deleted user's JWT returned 401. Existing browser site storage was not cleared. Services remain running: [Web](http://127.0.0.1:5173/), [Grafana](http://127.0.0.1:3000/).

## Environment and scope

Dedicated Colima VM: 10 CPUs, 10 GiB RAM, 96 GiB data disk. Generator, mock models, PostgreSQL, MinIO, Redis and monitoring share the VM. One frontend Pod uses r14 with a 512 MiB limit; two backend Pods use r24, four Uvicorn workers each and a 3 GiB limit. Final Pods are ready with zero restarts. Per worker: 16 main, 16+1 fencing and one health connection; maximum 272 steady-state connections or 408 during a three-Pod rollout. Test PostgreSQL allows 448 connections and uses a PVC.

ASR and translation mocks each wait 500 ms. The capacity workload uses **16 kHz mono 16-bit virtual PCM**, not 500 physical browsers, universal 48/96 kHz uploads, real-model accuracy/compute, WAN or all background workloads at once. The three-second condition matches the normal setting's continuous-speech segment limit; natural pauses can produce requests more frequently, so capacity is not guaranteed for every speech pattern. Final assembly/readback/deletion uses eight concurrent users after the measured 600-second production interval.

Capacity and full Web/two-Pod/monitoring results use r23 as their baseline. Final r24 only removes unused imports; Ruff and 10 targeted regressions passed, and final login/ASR/translation smoke checks returned 200. Package versions and behavior are unchanged.

[Reproduction guide](REPRODUCE.md)
