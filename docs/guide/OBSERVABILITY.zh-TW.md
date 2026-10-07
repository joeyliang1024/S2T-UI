# Prometheus 與 Grafana

本機隔離環境：Kubernetes context `colima-s2t-stress`、namespace `s2t-stress-20261005`。只使用模擬模型 API；PostgreSQL／MinIO／Milvus／Redis 為獨立真實容器。

Grafana：[單張總覽](http://127.0.0.1:13000/d/s2t-overview?orgId=1&from=now-30m&to=now&refresh=5s)。Prometheus 5 秒抓取、Grafana 5 秒更新。設定源在 `deploy/monitoring/generate.py`；它產生 dashboard.json 與 stack.json，請改生成器後重生，避免三份設定不同步。

## 讀圖

現在量測每個成功呈現的 chunk：起點是該 chunk 內開始說話的音訊樣本時間，終點是該 chunk 的文字首次在 Web UI 可見呈現（兩次 requestAnimationFrame 估計）。第一個 chunk 使用 VAD 回推的語音起點；連續說話的後續 chunk 使用自身起始樣本回推，沒有新的 VAD onset 也會記錄。時間包含音訊累積／切段、瀏覽器排隊、前處理、ASR 往返、畫面呈現。不是從送出 API 才開始計時，也不從整段會議開頭計時。靜音前卷中的新 onset 以實際 VAD 起點為準。硬體麥克風、JS 前的延遲、螢幕 scanout、Electron／浮動字幕視窗尚未量測。

頂部 P50／P95／P99 為固定最近 5 分鐘的即時查詢，不跟隨右上時間範圍。沒有有效樣本時顯示 No data，不沿用最後一次舊數值。下方原生圓環依所選時間範圍計算同一批 chunk 的六階段耗時占比，不是百分位數拆分；不同階段 P95 不能相加。連續語音後續 chunk 的 VAD 等待為零。所有面板都使用 Grafana 原生功能，無自訂 plugin 或允許未簽名插件的設定。

新量測使用 `chunk_speech_to_paint` 與 `s2t_chunk_stage_duration_seconds`，不混用舊首字樣本。舊樣本留在 Prometheus 歷史，更新並重新載入字幕頁後才有新 chunk 資料。

分位數為 histogram 的估計，與原始樣本排序分位數可能不同。不同步驟的 p95 不能直接相加。樣本累計以目前 Pod 生命週期為準，重啟會歸零；歷史時序由 Prometheus 保存。

## 遙測與資料可靠性

瀏覽器每批最多 128 個測量、每個事件計數最多 1000。一次只送一個請求，3 秒 timeout，失敗時退避；丟棄完整樣本以保留占比一致性。不重播失敗的 histogram，避免「server 已接受但回應遺失」造成重複計數。結束時可補一次失敗通知；無新活動的故障期間不持續輪詢。資料沒有音訊、文字或使用者／逐句 ID，沒有新增 durable Storage 寫入。

這是 best-effort 監控，不能當帳務或 exactly-once 日誌。speech_detected、asr_empty、asr_failed、audio_gap、telemetry_dropped 用來看遺失／失败；telemetry_dropped 包含緩衝丟棄和客戶端看到的傳送失敗，不保證 server 一定沒收到。

服務端要求登入、16KiB、每帳號每分鐘 240 次與有限 stage/event。依賴中斷仍 fail closed。PostgreSQL exporter 為 pg_monitor／3 connections／3 秒 SQL timeout。Redis／Sentinel 分別認證，K3s metrics 走 service-account API proxy；cgroup collector 只讀 cpu.stat，補此 Docker runtime 缺失的 CPU 節流指標。

## 部署與查看

```sh
python3 deploy/monitoring/generate.py
python3 deploy/monitoring/install-test.py
kubectl --context colima-s2t-stress -n s2t-stress-20261005 port-forward svc/grafana 13000:3000
```

測試字幕入口走 test-ingress Service，Gateway 滾動不再使 forward 指向的 Pod 被刪除：

```sh
kubectl --context colima-s2t-stress -n s2t-stress-20261005 port-forward svc/test-ingress 8790:8080
```

本隔離測試的 Grafana 允許匿名 Viewer；隨機管理密碼只在 Secret／ignored private/。MinIO metrics 只在 ClusterIP 設 public。這份測試設定不是公開網路生產部署配置。修改 provisioned dashboard 後需重新整理整個頁面，普通 5 秒 refresh 只更新原有查詢。

[實驗證據](../../experiment/monitoring/README.md)／[多 Pod 驗證](../../experiment/k8s/README.md)。

## Prometheus 連線設定

在專案 `.env` 或部署命令的環境變數設定 `PROMETHEUS_URL=http://prometheus:9090`，再執行 `python3 deploy/monitoring/configure-connection.py`。命令的環境變數優先於 `.env`，未設定時使用上述叢集內預設值。URL 必須能從 Grafana Pod 存取；`localhost` 指 Grafana 容器本身。

Grafana 的 datasource provisioning 使用 `${PROMETHEUS_URL}`，Deployment 從 `monitoring-connection` ConfigMap 注入環境變數。安裝程式會在 URL 改變時重新啟動 Grafana，套用資料來源；Prometheus 仍透過 scrape 拉取應用程式 `/metrics`。隔離測試叢集的 NetworkPolicy 只允許既有叢集內連線，外部 Prometheus 地址需另行配置允許的 egress。
