# Grafana metric definitions

[繁體中文](../monitoring/GRAFANA.zh-TW.md) | English

Updated 2026-10-26. The Python backend exposes `/metrics`; Prometheus scrapes both Pods directly. `deploy/monitoring/generate.py` owns generated dashboards, on-call dashboard and stack. Preserve existing data sources, Secrets and PVC data when updating configuration. The removed report-preview installer is not an available operation.

ASR latency runs from estimated last speech sample to caption paint; translation latency uses the same origin and includes translation paint. VAD silence confirmation is excluded from that speech-tail estimate; this is not word alignment or physical microphone latency. The strict target is below three seconds. Disabled translation, hidden tabs and unpainted results do not produce zero samples.

Browser timings use sample offsets and performance.now(), not differences between machine wall clocks. Server-Timing is milliseconds; histogram observations are seconds. Model HTTP time includes pool wait/transport/scheduling, not only inference. Phase means or quantiles cannot be added into an end-to-end quantile. Missing samples remain missing. Grafana histogram percentiles are interpolated; benchmark JSON percentiles use sorted observations.

Journey telemetry uses authenticated identities/departments: L1 app load, L2 start/resume action, L3 opening nonempty recording/summary content. Events are best effort and are not replayed after ambiguous responses. Period-based stage ratios are not cohort conversion and can exceed 100%; zero denominators show no data. NT and department trends respect the documented dashboard filters. 4xx/5xx authenticated-user counts are separate; anonymous errors and interrupted connections do not become fabricated attributed 5xx events.

Dashboard time range applies across panels. Health is evaluated at the selected range end. Explicit minute-phase averages retain their one-minute window; other trends use configured automatic windows. Missing data does not mean healthy or zero latency. Storage endpoint reachability alone does not establish end-to-end object/database correctness.

One supervised exporter per Pod publishes snapshots every 15 seconds; `/metrics` returns 503 before an initial snapshot or after 45 seconds stale. Shared backlog uses latest worker values inside each Pod and a maximum across Pods, while event-loop lag retains the maximum worker value. Collection delay plus scrape delay is distinct from clock skew.

Run port forwards in one terminal and checks in another:

```sh
node scripts/forward.cjs --monitoring
```

```sh
S2T_ALLOW_DEPLOYMENT_TESTS=true npm run test:deployment
S2T_ALLOW_DEPLOYMENT_TESTS=true npm run test:monitoring
```

Monitoring must use the same Pods as the latest browser baseline. Local Grafana/Prometheus ports are 3000/9090. The historical synchronized 500-user/600-second test had translation P90 3.023s, failing the strict latency target even though three-second cadence passed capacity. Two-second cadence failed capacity. Fixed 500ms mocks do not establish real inference capacity. See [observability](OBSERVABILITY.md), [results](VALIDATION_2026-10-26.md) and [reproduction](REPRODUCE.md).
