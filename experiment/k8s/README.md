# Kubernetes experiments

Current deployment: [deploy/test](../../deploy/test/README.md). Monitoring: [guide](../../docs/guide/OBSERVABILITY.zh-TW.md). Historical manifests are evidence, not current deployment instructions.

## Latest verification, 2026-10-06

[Raw results](current-2026-10-06/results) use mock model APIs with latency and tail latency, and real isolated storage. Each rollout runs 100 users for 90 seconds, one ASR + translation chain every 1.5 seconds, without client or ingress retries.

| Gateway Pods | Successful / scheduled chains | Failed | Minimum ready Gateway Pods |
| --- | --- | --- | --- |
| 2 | 6,000 / 6,000 | 0 | 2 |
| 4 | 6,000 / 6,000 | 0 | 4 |

Both configurations retain two audio workers and two ingress Pods. Eight Chrome pages measure actual subtitle first-word display. Four-Pod first-word P95 is 2.909 seconds including intentional model tail latency, so this does not establish a universal 2.5-second guarantee. Twenty diarization jobs completed on their first attempt; partial completion logs confirm both worker Pods processed jobs.

## 最新一輪結果：兩 Gateway Pod 與 UI 檢查，2026-10-06 20:54–22:01

原始檔都在 [results](current-2026-10-06/results)。這一輪分為負載、UI 瀏覽器驗證與字幕慢速檢查三部分，只有負載通過。

### 負載：通過

兩次 100 人、90 秒、間隔 1.5 秒、走 `http://test-ingress:8080` 的壓測，拓撲為 Gateway 2 副本、audio-worker 2、ingress 2、Redis 三節點加 Sentinel，無客戶端或 ingress 重試：

| Phase（開始） | 完成／排程 | 失敗／丟棄 | 峰值 pending | 佇鏈 P50 / P95 / P99 / Max |
| --- | --- | --- | --- | --- |
| `two-pods-sentinel-ui`（20:54:06） | 6,000 / 6,000 | 0 / 0 | 690 | 2.313 / 9.889 / 11.696 / 13.079 秒 |
| `two-pods-sentinel-ui-verified`（20:56:31） | 6,000 / 6,000 | 0 / 0 | 950 | 0.682 / 11.201 / 13.300 / 16.068 秒 |

ASR P95 分別為 5.672 與 6.981 秒、翻譯 P95 為 5.015 與 5.289 秒，來自模擬模型的長尾設定。Pod 觀察共 38 與 41 次取樣，gateway、audio-worker、test-ingress 全程 ready ≥ 2，gateway、audio-worker、redis、sentinel、test-ingress 的重啟次數皆為 0。見 [load](current-2026-10-06/results/two-pods-sentinel-ui-load.json)、[verified load](current-2026-10-06/results/two-pods-sentinel-ui-verified-load.json)、[pods](current-2026-10-06/results/two-pods-sentinel-ui-pods.json)、[verified pods](current-2026-10-06/results/two-pods-sentinel-ui-verified-pods.json)。

### UI 瀏覽器驗證：未完成

同一輪的 8 個 Chrome 頁面中，4 個（index 0、3、4、5）在收音檢查點時按鈕已變成「繼續／結束收音」，即頁面處於暫停狀態，頁面快照存為 [pre-pause-0](current-2026-10-06/results/pre-pause-0.json)、[pre-pause-3](current-2026-10-06/results/pre-pause-3.json)、[pre-pause-4](current-2026-10-06/results/pre-pause-4.json)、[pre-pause-5](current-2026-10-06/results/pre-pause-5.json)。這些頁面沒有 page error，字幕仍持續輸出 5–6 段（最長段落 00:10）；但後續點擊「暫停」失敗，該次執行中止，`two-pods-sentinel-ui.json` 未產出，`two-pods-sentinel-ui-browser-summary.json` 與 `two-pods-ui-network-count-summary.json` 都是 0 位元組空檔。

因此本輪沒有新的 UI 首字延遲通過數據，最近一次通過仍是四 Pod 的 P95 2.909 秒。4/8 頁面提前進入暫停狀態是待查問題，暫停原因沒有在頁面上留下錯誤訊息。

**根因已確認（2026-10-06 晚間分析）**：分散式錄音模式下 `BufferedPcmWriter` 的背壓門檻為 `sampleRate * 8`（約 8 秒音訊）。`RemotePcmRecording.append` 做串行網路 PUT，8 頁並發時網路上傳比即時慢，緩衝區滿後觸發 `onPressure(true)` → 自動暫停。暫停原因透過 `stBrowserStagingWriteSlowPaused` 設定，但 `statusToast` 4 秒後自動清除（`AppView.tsx:222`），測試在 `S2T_CAPTURE_MS`（10–20 秒）後才檢查，早已看不到。

**修正已套用**：
- `AppView.tsx`：`captureState === 'paused'` 時 status toast 不自動清除，暫停原因持續顯示直到錄音恢復。
- `browser.cjs`：頁面自動暫停時立即捕捉 `.status-toast` 文字並存入 `pre-pause-N.json` 的 `statusToast` 欄位，然後點擊「繼續」恢復錄音再走正常暫停/停止流程，不再直接崩潰。診斷檔新增 `autoPaused` 與 `pauseReason` 欄位。

尚未重跑驗證；下次執行時應確認暫停原因能被完整記錄。

### 字幕慢速檢查 `subtitle-slow-check`：未通過

22:00 的 8 頁面檢查沒有對應的 load 檔，在「單頁 telemetry 上傳最多一個 in-flight」斷言失敗：頁面 0 與 3 的併發峰值為 2，其餘輸出正常——各 5 次回應全為 200、無 page error、攔截器延遲峰值為 1，另有 `telemetry_dropped` 各 1 次。見 [failure-0](current-2026-10-06/results/subtitle-slow-check-failure-0.json)、[failure-3](current-2026-10-06/results/subtitle-slow-check-failure-3.json)，`subtitle-slow-check-summary.json` 為 0 位元組，本輪沒有通過結論。

失敗頁各錄到 3 個語音開頭的首字時間：頁 0 為 2.263／3.949／3.350 秒，頁 3 為 2.396／4.040／3.256 秒，主要落在 `asr_roundtrip_with_retries`（0.778–3.038 秒）與 `chunk_wait`（0.839–1.371 秒），與模擬長尾一致。需注意本輪計數改為從 request 發出算到 `requestfinished` 才遞減，量測窗口比先前以 fulfill 為準的版本長，峰值 2 有可能是口徑差異；要判定是否為真實併發回歸，須以同一口徑重跑對照。

**根因已確認（2026-10-06 晚間分析）**：`CaptionMetricTransport` 本身是 single-flight（`sending` 標記 + `arm()` 檢查），`interceptorPeak: 1` 也證實攔截器每次只處理一個請求。峰值 2 是量測口徑差異：Playwright 的 `requestfinished` 事件在 `fetch()` promise resolve 之後才觸發，負載高時事件處理延遲可能超過 transport 的 500ms 重試間隔，導致下一個請求已被發出但前一個的 `requestfinished` 還沒來，計數暫時為 2。

**修正已套用**：`browser.cjs` 改用 `response` 事件遞減計數（`response.request()` 取回對應 request），量測窗口縮小到「請求發出 → 回應標頭收到」，與 transport 實際的 in-flight 窗口更接近。斷言維持 `telemetryPeak === 1`。

尚未重跑驗證；下次執行時應確認峰值為 1。

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

### Failover latency fix

The original controlled switch retained a five-second Redis diskless-sync batching delay while Sentinel waited for replica reconfiguration. The test deployment now starts Redis with `--repl-diskless-sync-delay 0`. Under the same 100-user delayed-mock load, chain P95 improved from 6.096 to 1.460 seconds, P99 from 8.619 to 2.641 seconds, and maximum from 9.881 to 4.460 seconds, with 6,000/6,000 successful chains. These sequential tests promote different replicas, so the result supports improvement in this scenario, not a general SLA. See [comparison](current-2026-10-06/results/sentinel-fast-sync-summary.json) and Sentinel/Redis logs. The tradeoff is less batching of full syncs; this tuning is for the small isolated three-node topology. Residual switch latency remains.

[Current two-Pod rollout verification, 2026-10-07](two-pods-2026-10-07/README.md): 6,000 successful chains and 100-account integrity, preserving zero artificial model delay.
