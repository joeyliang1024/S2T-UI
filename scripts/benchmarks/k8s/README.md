# 固定 2 Pod 效能驗證

工具固定使用本機 `colima-s2t-stress` context 與 `s2t-stress-20261005` namespace。模型由隔離 namespace 內的服務模擬，每次完整讀取請求後等待 500ms；禁止連往正式模型 API 的 NetworkPolicy 必須保留。

先確認既有測試儲存空間；完整一輪新增約 9.6GB PCM，還需要物件 metadata 空間。`deploy.py` 會沿用既有測試 Secret 與已遷移的 MinIO hostPath，不清空資料。PostgreSQL 測試環境使用既有 Pod 的 emptyDir，請勿刪除或重建該 Pod。

```sh
python3 scripts/benchmarks/k8s/build-image.py --full
python3 scripts/benchmarks/k8s/deploy.py --gateway
python3 scripts/benchmarks/k8s/configure-monitoring.py
```

後續只改應用程式可省略 `--full`。同標籤映像更新後須 restart Gateway deployment，再等 2 Pod ready。監控配置修改後須在 ConfigMap 掛載更新後 reload Prometheus；既有 Grafana dashboard 保留。

瀏覽器探針需要先建立本機 SSH 到 Gateway Service 的通道；同 Service 的 Gateway rollout 可沿用。另開 Grafana 的 `13000:3000` 通道可查看原 dashboard，URL 加上 `var-caption_gateway=s2t`。

```sh
python3 scripts/benchmarks/k8s/forward-gateway.py
```

用同步控制器啟動四個各 125 用戶的產生端與一個可見 Chromium renderer 抽樣。瀏覽器報告會記錄與負載開始的偏差；不得把未重疊的探針宣稱為壓力下 E2E。

```sh
S2T_PERF_SMOKE_SECONDS=60 python3 scripts/benchmarks/k8s/run-with-browser.py --smoke
python3 scripts/benchmarks/k8s/collect.py performance-load-smoke /tmp/s2t-smoke.json
python3 scripts/benchmarks/k8s/run-with-browser.py --load
# 100 人比較：相同 2 Pod、模型 500ms、持續 600 秒
S2T_PERF_TOTAL_USERS=100 python3 scripts/benchmarks/k8s/run-with-browser.py --load
python3 scripts/benchmarks/k8s/collect.py performance-load-10m /tmp/s2t-600s.json
```

完整 600 秒應提供 150,000 段音訊，無丟棄時合計 480,000 次 HTTP（另有 1,000 次初始化）。驗收延遲以 P90 為準：ASR E2E P90 <3 秒、包含 ASR 的翻譯 E2E P90 <3 秒。成功率必須同時看 HTTP 與 offeredSuccessRate；產生端丟棄的工作不能從 KPI 分母消失。`p90ApiChainPassed` 檢查 HTTP 鏈路 P90、無 HTTP 錯誤與無丟棄，仍須另核對同步 renderer 的實際字幕 E2E。`strictApiChainPassed` 保留為所有樣本小於 3 秒的診斷欄位，不作主要驗收門檻。`acceptance10mComplete` 只代表測試時間與發送數完整，不能代表 SLA 達標。

HTTP 鏈路與實際字幕 paint 分開報告。renderer 抽樣採正式 energy VAD、ASR adapter、翻譯佇列及雙 RAF，排除實體麥克風、Silero 與 WAN，不等同 500 個桌面瀏覽器。報告包含 t5/t7、P50/P90/P95/P99/max 與 ≥3 秒數；不排除冷啟動或錯誤樣本。四端原始樣本合併計算 P90，不平均各端分位數；Grafana 的分片分位數及 histogram 估計只作即時診斷。

`S2T_PERF_TOTAL_USERS` 預設 500，支援 4..500 人，平均分配至四個產生端；100 人即每端 25 人。瀏覽器結果檔包含人數，避免覆寫 500 人結果。100 人完整 600 秒應提供 30,000 段及 96,000 次 HTTP（另有 200 次初始化）；只代表 100 人容量驗證。收集器另存 `.raw.json.gz` 保留原始分位數樣本。

## 即時字幕優先混合診斷

Gateway `S2T_BACKGROUND_MAX_INFLIGHT=8` 為跨 Pod 共用的背景模型工作上限。相同 HTTP 連線角色內，等待中的即時工作優先；背景最多占動態容量的四分之一且不超過背景上限，已執行工作不搶占。Web 即時字幕明確標記 `x-s2t-workload: realtime`；品質校正／匯入／摘要翻譯標記 background，摘要與說話人辨識由伺服器強制歸為背景。未標記的 ASR／翻譯保留即時分類以相容舊客戶端。

先部署最新 Gateway 與 mock-models，再以相同起跑時間加入背景 ASR／翻譯／摘要；背景個別帳號遵守既有每分鐘限流。此 120 秒診斷不能取代 600 秒正式驗收：

```sh
S2T_PERF_TOTAL_USERS=100 S2T_PERF_BACKGROUND_WORKERS=32 S2T_PERF_SMOKE_SECONDS=120 python3 scripts/benchmarks/k8s/run-with-browser.py --smoke
python3 scripts/benchmarks/k8s/collect.py performance-load-smoke /tmp/s2t-priority-mixed.json
```

`performance-background` 的 9096 `/report` 保留背景完成／錯誤統計；mock-models `/metrics` 的 `s2t_mock_workload_peak{workload="background"}` 驗證模型實際在途上限。測試後保存資料再將該 Deployment 與四個產生端縮為 0。

背景上限驗證應使用 `max(s2t_redis_capacity_state{state="backgroundLeases"})` 與 mock 的 background peak；跨 Pod 的本地 active 抓取時間不同，直接 sum 可能誤報超過上限。`backgroundLeaseHealthy` 與 `backgroundLeaseAgeSeconds` 必須同時查看。

完整混合長測可將上述 `--smoke` 改成 `--load`（600 秒）；用 `S2T_PROBE_REPORT` 指定獨立結果檔，保留既有單純 100 人結果。增量 base 被回收時，建置工具會驗證現有映像 package-lock 雜湊後才重用，依賴不同須 `--full`。
