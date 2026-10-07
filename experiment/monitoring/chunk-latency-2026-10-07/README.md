# Per-chunk UI latency, 2026-10-07

No Grafana custom plugin. Three native stat panels report fixed trailing-five-minute P50/P95/P99. A native pie reports six stage shares over the selected time range. New metrics do not reuse historical first-word observations.

Eight Chrome pages, fake six-second speech/two-second silence, isolated mock APIs, two Gateway Pods, two audio workers and two ingress Pods. 160 chunks were measured versus 32 speech onsets; each chunk's six disjoint stage durations summed to its exact audio-to-UI duration. Raw sample p50/p95/p99: 1.665/3.413/3.660 seconds. These are synthetic-load results, not a claim about real model speed.

The first chunk starts at its VAD-estimated speech onset; later continuous-speech chunks start at their own first audio sample. Audio collection and queues are included. UI endpoint uses two animation frames; hardware/input before JS and physical scanout are not measured. Missing/hidden/empty captions do not become zero latency.

Re-run `S2T_CAPTURE_MS=30000 node experiment/monitoring/chunk-latency-2026-10-07/browser.cjs`. Uses locally installed Chrome and the existing bundled Playwright path. The test only connects to the local isolated web origin and does not configure real API endpoints.
