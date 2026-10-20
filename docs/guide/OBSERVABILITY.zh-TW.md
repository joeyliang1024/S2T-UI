# Prometheus 與 Grafana

本機隔離環境：Kubernetes context `colima-s2t-stress`、namespace `s2t-stress-20261005`。只使用模擬模型 API；PostgreSQL／MinIO／Milvus／Redis 為獨立真實容器。

Grafana：[單張總覽](http://127.0.0.1:13000/d/s2t-overview?orgId=1&from=now-30m&to=now&refresh=5s)。Prometheus 5 秒抓取、Grafana 5 秒更新。設定源在 `deploy/monitoring/generate.py`；它產生 dashboard.json 與 stack.json，請改生成器後重生，避免三份設定不同步。

## 讀圖

延遲量測以完整字幕管線顯示，共七個階段（`phase` 標籤），每個階段再細分原子量測（`stage` 標籤）：

| 階段 | 含義 | 細項（stage） |
| --- | --- | --- |
| t1 | UI 截取音訊並傳送到伺服器 | `t1_queue` 瀏覽器佇列、`t1_encode` WAV 編碼與前置、`t1_upload` 伺服器收音訊 |
| t2 | VAD 邏輯處理時間 | `t2_vad` 本機 VAD process 執行時間、`t2_gate` worker 的 Silero 執行時間（僅啟用時）；不含講話、區段累積或 HTTP 往返 |
| t3 | ASR 模型推論（伺服器端） | `t3_queue` 容量排隊、`t3_preprocess` 音訊前處理（僅啟用 dynaudnorm 時）、`t3_model` 模型推論、`t3_gateway` 伺服器驗證／快取／寫出 |
| t4 | 標點符號等文字後處理 | `t4_postprocess` 文字清理（目前僅有清理步驟；不雅字過濾加入後同樣計在這裡） |
| t5 | 回傳轉錄文字到 UI 呈現 | `t5_network` 回傳網路與重試、`t5_paint` UI 呈現（兩次 requestAnimationFrame） |
| t6 | 翻譯模型（含不雅字過濾位置） | `t6_wait` 前端排隊等待、`t6_queue` 容量排隊、`t6_model` 模型推論、`t6_gateway` 伺服器固定處理 |
| t7 | 譯文回傳並渲染到 UI | `t7_network` 回傳網路、`t7_paint` 譯文 UI 呈現 |

端到端統一起點為使用者講完最後一字的時間：以最後 VAD 語音樣本的音訊時鐘估計，非逐字對齊。`e2e_asr` 量到原文最後一字實際呈現；`e2e_translation` 與 `e2e_translation_tail` 量到譯文最後一字呈現，包含斷句、排隊與模型等待。E2E 目標 ≤ 3 秒。硬體麥克風、JS 前的延遲、螢幕 scanout、Electron／浮動字幕視窗尚未量測。

**t1_upload／t3_\*／t6\_\* 的伺服器端拆分來自標準 `Server-Timing` 回應標頭**：Gateway 在 `/api/transcriptions` 與 `/api/translations` 回報 upload／queue／pre／model／total，瀏覽器用「往返時間 − 伺服器耗時」精確得到回傳網路時間（`t5_network`／`t7_network`），各細項用於定位處理成本；因起點不同、樣本數不同且可能有併行處理，不可把階段平均加總當作 E2E。沒有 `Server-Timing` 時（舊版 gateway）整段往返歸入 t5／t7_network，仍不重疊。未啟用的可選步驟（如 Silero 閘門、dynaudnorm）不輸出 0 秒樣本，避免把「沒跑」誤當「很快」。

儀表板頂部三個 KPI 為 E2E P90、ASR P90 與 API 成功率，均依右上所選時間範圍計算。t1～t7 顯示在兩個橫向長條圖：階段平均及 Detail 平均；翻譯 t6／t7 合併呈現。另保留 t1～t7 圓環耗時占比、Gateway、Storage、部門與 User 趨勢及 HTTP 錯誤面板。排行包含部門使用時數／次數、User 使用時數／次數前 10；時數採 ASR 提交音訊秒數除以 3600，重試可能重複計入，次數採 L2 開始／繼續錄音事件。沒有有效樣本時顯示 No data。圓環為各階段累積耗時占比，非百分位數拆分。所有面板使用 Grafana 原生功能；datasource 與來源由模板變數指定。

新量測使用 `e2e_asr`、`e2e_translation` 與 `t1~t7` 系列 stage，舊的 `chunk_speech_to_paint`、`first_word_*`、`chunk_*` 階段已停用。舊樣本只留在 Prometheus 歷史；更新 renderer 與 gateway、重新載入字幕頁後才有新樣本。

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

API roundtrip 在瀏覽器完成讀取回應時結算。瀏覽器的 request、chunk 及翻譯延遲樣本，必須完整落在同一段即時字幕頁可見期間；跨越切換功能頁、隱藏分頁的請求，即使切回後才完成也排除，避免 fetch 回呼與 RAF 被背景節流拉長。Gateway 的 request／用量仍正常記錄。只有當即時字幕頁可見、字幕實際可見時，才納入 `t5_paint`、`e2e_asr` 與翻譯繪出樣本；t1~t4、t6 的前段樣本在文字抵達時即記錄。離開字幕頁、隱藏分頁或字幕位於可視區外，會丟棄待呈現樣本；切回頁面不補報歷史字幕。沒有有效呈現樣本時顯示 No data，不能以 0 或舊值冒充。頂部 P90 依所選時間範圍計算。


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

`/d/s2t-oncall` 共用詳細總覽的 KPI 定義與查詢，包含 E2E P90、ASR P90、API 成功率、t1～t7 階段與 Detail 長條圖、部門與 User 排行及健康狀態。詳細內容透過「詳細監控與用量」連結開啟原總覽，保留所選來源與時間。

### 獨立模擬預覽

`python3 deploy/monitoring/install-report-preview.py` 使用獨立 Node 映像與 `gateway-report-preview` scrape job，建立明確標示「測試資料預覽」的 dashboard。3 部門、12 使用者的資料最多產生 15 分鐘，含 ASR 音訊時數與錄音次數；不呼叫模型或寫入使用者資料。`dashboard.json` 為 provisioning 的唯一來源，修改後重新執行 generator 才能更新 stack／oncall。
