# Kubernetes experiments

Current deployment: [deploy/test](../../deploy/test/README.md). Monitoring: [guide](../../docs/guide/OBSERVABILITY.zh-TW.md). Historical manifests are evidence, not current deployment instructions.

## Latest verification, 2026-10-06

[Raw results](current-2026-10-06/results) use mock model APIs with latency and tail latency, and real isolated storage. Each rollout runs 100 users for 90 seconds, one ASR + translation chain every 1.5 seconds, without client or ingress retries.

| Gateway Pods | Successful / scheduled chains | Failed | Minimum ready Gateway Pods |
| --- | --- | --- | --- |
| 2 | 6,000 / 6,000 | 0 | 2 |
| 4 | 6,000 / 6,000 | 0 | 4 |

Both configurations retain two audio workers and two ingress Pods. Eight Chrome pages measure actual subtitle first-word display. Four-Pod first-word P95 is 2.909 seconds including intentional model tail latency, so this does not establish a universal 2.5-second guarantee. Twenty diarization jobs completed on their first attempt; partial completion logs confirm both worker Pods processed jobs.

## Fixes and limits

Slow telemetry previously accumulated six concurrent requests per page. A single in-flight request, bounded whole-cohort buffering and failure backoff reduce the peak to one. An earlier four-Pod test failed 63 chains when one-second Redis probes timed out and restarted containers. Authenticated PING remains enabled with more tolerant startup and liveness probes; subsequent two- and four-Pod rollouts have zero failed chains and zero Redis restarts. The local browser tunnel now targets a two-Pod ingress service to survive Gateway updates.

This is a single physical node. Results cover these tested loads and updates, not node failure or cross-node storage availability.

## Historical evidence

[Initial 100 users](history/initial-2026-10-05/README.zh-TW.md), [rollout](history/rollout-2026-10-05/README.zh-TW.md), [Sentinel](history/sentinel-2026-10-06/README.zh-TW.md), [UI responsiveness](history/responsiveness-2026-10-06/README.zh-TW.md), [large history](history/large-history-2026-10-06/README.zh-TW.md), [legacy history](history/legacy-history-2026-10-06/README.zh-TW.md).

## Load path audit

Earlier load results, including `canonical-ingress-load.json`, sent requests directly to `gateway:8787`; they recorded ingress readiness but did not measure nginx request handling. Browser first-word tests did use ingress. The versioned load harness now defaults to `test-ingress:8080`, reports `baseUrl`, and the runner verifies that URL. It uploads the current harness to a separate temporary filename without replacing existing account fixtures.

The `ingress-end-to-end` run sends 100 users through nginx while the four Gateway replicas roll. Raw load results and Pod observations remain in the current results directory.

Verified result: 6,000/6,000 chains, zero failures or drops, Gateway minimum Ready 4, workers 2, ingress 2. Pod observations captured the rollout in progress. See [summary](current-2026-10-06/results/ingress-end-to-end-summary.json).

## Controlled Sentinel failover

During 100-user ingress load with mock model latency, an authenticated `SENTINEL failover` switched the Redis master from redis-2 to redis-0. All 6,000 chains completed without failures or dropped arrivals. Original 100-account recording/session integrity passed after the switch. See [summary](current-2026-10-06/results/ingress-sentinel-failover-summary.json) and associated load/Pod observations. This proves controlled failover under this load; abrupt crashes and network partitions remain separate scenarios.
