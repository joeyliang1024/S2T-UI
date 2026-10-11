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

### 8787 網頁入口與測試站的量測來源

`S2T_GATEWAY_METRICS_URL` 指定 **Prometheus 所在環境可連線**的 Gateway `/metrics` URL，與 Grafana 的 `PROMETHEUS_URL` 分開。環境變數優先，其次讀專案 `.env`。本機 Colima 的範例是 `http://192.168.5.2:8787/metrics`；在其他環境需替換為實際可達位址，不能直接把 Pod 的 `localhost` 當成使用者電腦。

設定後執行 `python3 deploy/monitoring/configure-gateway-target.py`。此工具只更新 scrape ConfigMap、Dashboard、Prometheus 到指定 IP/port 的 egress 規則並重載 Prometheus，不更動 PostgreSQL、MinIO、帳號或模型。URL 使用 DNS 名稱時須另備對應 egress 規則。

同一張 Dashboard 的「字幕量測來源」預設選 **8787 網頁入口**，可切換到 **K8s 測試站**。Web 字幕、Gateway 階段、HTTP 及應用儲存操作均依來源過濾，避免混合真實測試與模擬負載。其餘 Redis、PostgreSQL、MinIO、Milvus 與 K8s 資源圖仍代表隔離測試 cluster 的服務。

API roundtrip 在瀏覽器完成讀取回應時結算。瀏覽器的 request、chunk 及翻譯延遲樣本，必須完整落在同一段即時字幕頁可見期間；跨越切換功能頁、隱藏分頁的請求，即使切回後才完成也排除，避免 fetch 回呼與 RAF 被背景節流拉長。Gateway 的 request／用量仍正常記錄。只有當即時字幕頁可見、字幕實際可見時，才納入 chunk 說話到 UI 首次呈現及 response-to-paint 的樣本。離開字幕頁、隱藏分頁或字幕位於可視區外，會丟棄待呈現樣本；切回頁面不補報歷史字幕。沒有有效呈現樣本時顯示 No data，不能以 0 或舊值冒充。頂部 P50/P95/P99 仍使用固定最近 5m。


## 每位帳號與總體使用量

同一張 dashboard 新增使用量區塊，沿用「字幕量測來源」選擇 `gateway-web`（8787）或 `s2t`（隔離測試站），不混合兩個入口。總體數字不受「使用量 NT」篩選影響；每位使用者的表格及趨勢可多選 NT。NT 與部門直接由 gateway 驗證過的帳號資料提供，可先篩選部門，再多選 NT。帳號 ID 由 gateway 驗證登入結果取得，前端不能以 header 或 telemetry payload 指定歸戶帳號；Prometheus 保留帳號 ID、NT、部門作為用量標籤，不包含密碼、登入 token、音訊內容、prompt 或逐字稿。

- `s2t_user_requests_total`：已驗證帳號的 API 請求，按固定 operation 與 success／client_error（4xx）／server_error（5xx）／aborted 分開。包括 telemetry、資料 API、重試、限流拒絕和 idempotency 命中；未登入請求只保留原有總體 gateway HTTP 指標。
- `s2t_user_request_seconds_total`：gateway 處理 request 的累積時間，含等候模型與回應寫出，不能當成 CPU 時間。
- `s2t_user_model_executions_total`：ASR、翻譯、摘要成功完成的實際執行次數。ASR／翻譯的快取命中不增加執行或用量；摘要沿用既有 SDK 重試，內部失敗重試不另計模型成功次數。講者分離目前只有 request 統計，非同步背景工作完成數尚未歸入本組指標。
- `s2t_user_audio_bytes_total`／`audio_seconds_total`：成功 ASR 執行的音訊 bytes 與可解析 PCM／float WAV 時長；其他格式的時長以 `audio_duration_unknown_total` 計數，不假造零秒。
- `s2t_user_input_tokens_total`／`output_tokens_total`：翻譯／摘要模型回應中的 prompt_tokens／completion_tokens。未回報完整非負整數用量時增加 `token_usage_missing_total`，不以字元數估算 token。失敗模型呼叫可能有供應商費用，本監控無法取得。
- `s2t_user_input_characters_total`／`output_characters_total`：成功文字模型執行的 Unicode 字元數，輸入包含送給模型的 prompt／glossary；ASR 僅記錄輸出字元。

所選範圍以 Prometheus `increase` 計算，處理多程序與重啟時先對各 series 計算再加總；數字可能是小數。新帳號在第一次 scrape 前完成的請求、scrape 空窗與監控保存期外的歷史無法完整還原。「目前 gateway 程序累計 requests」直接顯示 raw counter，可查看程序啟動後已收到的精確次數。重啟會重置程序 counter，這不是永久用量帳本或帳單；本次修改也不回補歷史。每程序最多保留 10,000 個帳號，額外帳號歸入 `__overflow__`，總體仍計算，帳號分布精度會受限。

驗證：

```sh
node tests/smoke/caption-navigation-metrics-smoke-test.cjs
node tests/smoke/caption-gateway-browser-metrics-test.cjs
node tests/smoke/gateway-usage-smoke-test.cjs
```

瀏覽器測試使用本機 Chrome 與既有 Playwright，實際 gateway 靜態頁、API 與 telemetry 路徑都在隨機 loopback port 上，等同 8787 的 serving 路徑。測試模型僅為本機 mock，不會呼叫正式模型；隱藏分頁事件另由 deterministic smoke test 驗證。程式修改需要重建 Web renderer、重啟 8787 gateway，dashboard 則需更新 provisioned ConfigMap 並重新整理整個 Grafana 頁面。


### 可視化驗收資料與部門總量

`python3 deploy/monitoring/install-acceptance.py` 在既有隔離 namespace 建立獨立 `monitoring-acceptance` Deployment。沿用現有 gateway 映像的依賴並覆蓋本次 server 程式，所有 ASR／翻譯／摘要只呼叫同容器 mock。真實 gateway 的帳號與資料不灌入驗收流量。三個驗收 NT 為「驗收使用者甲／乙／丙」，分屬「驗收研發部」（甲、乙）與「驗收營運部」（丙）；資料持續生成，來源選擇器明確標示「驗收模擬資料（非正式）」。字幕階段延遲是人工構造的示範樣本，不能當模型效能實測。

部門區塊以 `department` 彙總請求數、成功模型完成次數、ASR 音訊時數、輸入／輸出 token、請求錯誤率與時間趨勢；部門總量不受 NT 篩選影響。全站總量不受部門／NT 篩選影響。所有用量查詢排除缺少 NT／部門的舊版本 series，避免無標籤歷史混入新版彙總。

驗收入口：`http://127.0.0.1:13000/d/s2t-overview?var-caption_gateway=gateway-acceptance&var-usage_user=$__all&var-usage_department=$__all`。需開啟 Grafana port-forward；如果 Grafana rollout 導致轉發中斷，重跑既有 port-forward 指令即可。

8787 本次使用 `s2t-ui:monitoring-20261011` 修正映像，從原執行映像的既有依賴加上目前 server／Web renderer 建置，不下載套件。`deploy/monitoring/gateway-override.yml` 搭配原 Compose 設定保留既有 `.env` 和資料 volume；重建 renderer 後需重新整理 Web 頁面。測試與截圖存於 `experiment/monitoring/acceptance-2026-10-11/`。


### 值班總覽

新增 `/d/s2t-oncall`，順序固定為「延遲 → 使用者 → 請求」，使用者 row 緊接延遲 row。延遲看固定最近 5 分鐘的 P50／P95／P99、趨勢與有效樣本數；使用者看最近 5 分鐘有請求的 NT／部門（不是在線人數）、所選範圍的音訊／token 與 NT／部門請求比較；請求看 scrape 狀態、API 速率、4xx＋5xx 錯誤率、in-flight 與錯誤分類趨勢。來源可切換 8787、K8s 測試站和獨立驗收資料。詳細內容透過「詳細監控與用量」連結開啟原總覽，保留所選來源與時間。
