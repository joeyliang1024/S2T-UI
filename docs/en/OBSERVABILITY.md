# Timing, Prometheus, and Grafana

[繁體中文](../guide/OBSERVABILITY.zh-TW.md) | English

Each Python Pod exposes `/metrics`. Scrape both backend Pods directly rather than only a load-balanced Service. The main caption dashboard uses `job="s2t"`, matching `app=s2t-backend`.

For an existing isolated monitoring deployment:

```sh
node scripts/forward.cjs --monitoring
S2T_ALLOW_DEPLOYMENT_TESTS=true npm run test:monitoring
```

Local forwards expose the frontend on 5173, backend on 8787, Grafana on 3000, and Prometheus on 9090. Forwarding uses the configured Kubernetes context and namespace and can reconnect after Pod replacement.

## What the two latency values mean

ASR latency measures estimated speech end to caption paint. Translation latency measures estimated speech end to translation paint, including segmentation, scheduling, queueing, and model waits. The common origin is the last detected speech sample mapped to the browser clock, not word-level alignment.

Measurements use the audio sample clock and browser `performance.now()`. They do not subtract wall clocks on separate machines. `Server-Timing` values are milliseconds; Prometheus histogram observations use seconds.

| Phase | Meaning |
| --- | --- |
| t1 | Browser queue, encoding, and upload |
| t2 | VAD computation |
| t3 | ASR queue, preprocessing, model execution, backend processing |
| t4 | Text postprocessing |
| t5 | Transcription response/network and UI paint |
| t6 | Translation scheduling, queue, model, backend processing |
| t7 | Translation response/network and UI paint |

Server timings split work within an HTTP request so the full round-trip is not counted again as another stage. Different phases can have different sample counts and overlapping work; adding phase averages or percentiles does not produce an end-to-end percentile.

P90 is a histogram estimate, not an exact sorted-sample percentile or a mean. Missing observations should display no data, not zero latency. Process counters reset on restart; Prometheus retains historical time series. Queue oldest-wait metrics indicate waiting time, not audio duration.

## Reliability and scope

Browser telemetry is best effort. Failed requests may be dropped rather than replayed to avoid duplicate histogram observations after an ambiguous response. It is not an exactly-once event log or billing source. Reported timing does not establish physical microphone latency or display scanout latency.

`deploy/monitoring/generate.py` generates monitoring resources and the main dashboard; keep generated output consistent when editing its source. Connection configuration belongs in `deploy/monitoring/.env`. `PROMETHEUS_URL` must be reachable from Grafana. The compatibility name `S2T_GATEWAY_METRICS_URL` configures an optional metrics source reachable from Prometheus. Container localhost does not refer to the developer's computer.

The [2026-10-24 report](VALIDATION-REPORT-2026-10-24.md) verifies browser samples against Prometheus count/sum and checks queries on the main and Python performance dashboards. Real-model performance and GPU capacity still require separate measurement.

### ASR and translation measurement boundaries

`Server-Timing total` starts when the ASGI request enters and includes HTTP admission queueing, authentication, rate checks, settings/body reads, idempotency and model-service round trips. `http_queue`, `auth` and `rate` expose their respective waits. `model` measures the model HTTP call, including its connection pool, transport and scheduling; it is not pure inference time. ASR `upload` measures body acquisition.

Browser caption/translation end-to-end measurements include the corresponding VAD, queueing, transport and rendering stages. Double-RAF paint is measured separately. Client duration minus server duration still includes proxy and browser scheduling overhead, not just wire latency. UTC synchronization aligns timelines; elapsed durations use monotonic clocks. Grafana histogram quantiles interpolate within buckets; benchmark JSON quantiles are computed from individual samples.

When started with `python -m app`, each backend Pod uses one supervised process to merge multiprocess Prometheus metrics and atomically publish a shared snapshot every 15 seconds. API workers only read that snapshot, keeping expensive per-user metric serialization outside their GIL. The exporter restarts after an unexpected exit. `/metrics` returns 503 before the first snapshot or when its age exceeds 45 seconds. Charts can trail events by approximately 15 seconds plus the Prometheus scrape interval; this collection delay is distinct from clock skew.

Ordinary ASR and translation model requests use separate aiohttp sessions with bounded connection pools; summary streaming retains its existing streaming client. Model sessions neither retain nor forward cookies, do not follow redirects, and do not automatically replay disconnected POST requests. See the [aiohttp session, pooling and DummyCookieJar reference](https://docs.aiohttp.org/en/stable/client_reference.html). Local and Linux client CPU benchmarks are retained with validation evidence and do not establish whole-service capacity.

Shared pending-job and pending-audio gauges select the most recent worker measurement within a Pod, preventing a drained queue from retaining another worker's old maximum. Grafana takes the maximum across Pods so the shared queue is not counted twice. Event-loop lag still takes the maximum worker value to expose the slowest worker.
