# Prometheus 與 Grafana

本機隔離環境：Kubernetes context `colima-s2t-stress`、namespace `s2t-stress-20261005`。只使用模擬模型 API；PostgreSQL／MinIO／Milvus／Redis 為獨立真實容器。

Grafana：[單張總覽](http://127.0.0.1:13000/d/s2t-overview?orgId=1&from=now-30m&to=now&refresh=5s)。Prometheus 5 秒抓取、Grafana 5 秒更新。設定源在 `deploy/monitoring/generate.py`；它產生 dashboard.json 與 stack.json，請改生成器後重生，避免三份設定不同步。

## 讀圖

首字延遲是 Web VAD 語音開頭估計，到主字幕 UI 第一段非空文字可見呈現；使用音訊樣本回推與兩次 requestAnimationFrame。它不等於模型 HTTP 回應，也不包含 Prometheus／Grafana 等待。未量測精確人類音素、硬體麥克風延遲、JS 前的音訊延遲、實體螢幕 scanout、Electron／浮動字幕視窗。

甜甜圈圖跟隨上方時間選擇器。同一批成功顯示首字的樣本分成六個互不重疊的步驟：VAD 語音確認、音訊累積／切段、瀏覽器排隊、前處理、ASR 往返、畫面呈現。百分比是各步驟累計耗時／六步驟總耗時，並非正在某一步驟的請求數。後續字幕與翻譯不混入分母；ASR 往返已含 server 排隊／模型／重試，不再疊加 Gateway 內部指標。分母必須是 scalar，不能直接把帶 stage 的向量除以無 stage 的向量。

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
