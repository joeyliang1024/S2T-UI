# Prometheus 與 Grafana

繁體中文 | [English](../en/OBSERVABILITY.md)

Python 後端直接提供 `/metrics`，Prometheus 逐 Pod scrape；兩個後端應各有健康 target。主字幕看板使用 `job="s2t"`，來源為 `app=s2t-backend`。不要沿用舊 `gateway-web` selector。

```sh
node scripts/forward.cjs --monitoring
S2T_ALLOW_DEPLOYMENT_TESTS=true npm run test:monitoring
```

本機轉發：前端 5173、後端 8787、Grafana 3000、Prometheus 9090。轉發工具讀取 K8s context／namespace 設定，Pod 替換後可重連。監控驗證需先建立 localhost 隔離測試部署。

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

端到端統一起點為使用者講完最後一字的時間：以最後 VAD 語音樣本的音訊時鐘估計，非逐字對齊。`e2e_asr` 量到原文最後一字實際呈現；`e2e_translation` 與 `e2e_translation_tail` 量到譯文最後一字呈現，包含斷句、排隊與模型等待。E2E 目標 ≤ 3 秒。硬體麥克風、JS 前的延遲、螢幕 scanout、硬體顯示延遲尚未量測。

**t1_upload／t3_\*／t6\_\* 的伺服器端拆分來自標準 `Server-Timing` 回應標頭**：Python 後端在 `/api/transcriptions` 與 `/api/translations` 回報 upload／queue／pre／model／total，瀏覽器用「往返時間 − 伺服器耗時」精確得到回傳網路時間（`t5_network`／`t7_network`），各細項用於定位處理成本；因起點不同、樣本數不同且可能有併行處理，不可把階段平均加總當作 E2E。沒有 `Server-Timing` 時（舊版 gateway）整段往返歸入 t5／t7_network，仍不重疊。未啟用的可選步驟（如 Silero 閘門、dynaudnorm）不輸出 0 秒樣本，避免把「沒跑」誤當「很快」。

儀表板頂部三個 KPI 為 E2E P90、ASR P90 與 API 成功率，均依右上所選時間範圍計算。t1～t7 顯示在兩個橫向長條圖：階段平均及 Detail 平均；翻譯 t6／t7 合併呈現。另保留 t1～t7 圓環耗時占比、Gateway、Storage、部門與 User 趨勢及 HTTP 錯誤面板。排行包含部門使用時數／次數、User 使用時數／次數前 10；時數採 ASR 提交音訊秒數除以 3600，重試可能重複計入，次數採 L2 開始／繼續錄音事件。沒有有效樣本時顯示 No data。圓環為各階段累積耗時占比，非百分位數拆分。所有面板使用 Grafana 原生功能；datasource 與來源由模板變數指定。

新量測使用 `e2e_asr`、`e2e_translation` 與 `t1~t7` 系列 stage，舊的 `chunk_speech_to_paint`、`first_word_*`、`chunk_*` 階段已停用。舊樣本只留在 Prometheus 歷史；更新前後端、重新載入字幕頁後才有新樣本。

分位數為 histogram 的估計，與原始樣本排序分位數可能不同。不同步驟的 p95 不能直接相加。樣本累計以目前 Pod 生命週期為準，重啟會歸零；歷史時序由 Prometheus 保存。

## 遙測與資料可靠性

瀏覽器每批最多 128 個測量、每個事件計數最多 1000。一次只送一個請求，3 秒 timeout，失敗時退避；丟棄完整樣本以保留占比一致性。不重播失敗的 histogram，避免「server 已接受但回應遺失」造成重複計數。結束時可補一次失敗通知；無新活動的故障期間不持續輪詢。資料沒有音訊、文字或使用者／逐句 ID，沒有新增 durable Storage 寫入。

這是 best-effort 監控，不能當帳務或 exactly-once 日誌。speech_detected、asr_empty、asr_failed、audio_gap、telemetry_dropped 用來看遺失／失败；telemetry_dropped 包含緩衝丟棄和客戶端看到的傳送失敗，不保證 server 一定沒收到。

服務端要求登入、16KiB、每帳號每分鐘 240 次與有限 stage/event。依賴中斷仍 fail closed。PostgreSQL exporter 為 pg_monitor／3 connections／3 秒 SQL timeout。Redis／Sentinel 分別認證，K3s metrics 走 service-account API proxy；cgroup collector 只讀 cpu.stat，補此 Docker runtime 缺失的 CPU 節流指標。

## 設定來源與驗證

`deploy/monitoring/generate.py` 產生主看板與監控資源；修改生成器後需同步生成檔案。連線設定由 `deploy/monitoring/.env` 或程序環境提供：`PROMETHEUS_URL` 是 Grafana 可連到的 Prometheus，`S2T_GATEWAY_METRICS_URL` 是保留相容名稱的可選 metrics 來源。容器內 localhost 不代表使用者電腦。

標準 K8s 部署應逐 Pod 抓取 Python metrics，不能只抓負載平衡 Service。部署、授權與 datasource 應依實際環境設定；隔離環境的匿名 Viewer 設定不可直接當成公開站點配置。

[2026-10-26 驗證](../reports/VALIDATION_2026-10-26.zh-TW.md) 核對了瀏覽器原始 ASR／翻譯延遲與 Prometheus histogram 的 count／sum，並檢查主看板及 Python 效能看板的查詢。P90 是 histogram 估計值。未經真實模型與 GPU 量測的部分不能推論為生產效能。

### ASR／翻譯延遲的量測邊界

`Server-Timing` 的 `total` 從 ASGI 請求進入開始，包含 HTTP 名額排隊、登入驗證、限流、讀取設定／請求、冪等處理與模型服務往返；`http_queue`、`auth`、`rate` 分別揭露這些等待。`model` 是模型 HTTP 呼叫的往返時間，包含其連線池／傳輸與排程，不代表模型內部純推論時間。小片段 ASR 的 `upload` 是實際讀取請求資料的時間。

前端端到端字幕與翻譯量測包含對應的 VAD／排隊／網路及畫面更新；雙 RAF 繪製時間另外記錄。用戶端請求時間扣除伺服器時間的餘量，仍包含代理、傳輸與瀏覽器排程，不應解讀成純網路線路延遲。各機器以 UTC 校準供時間軸對齊；單次耗時使用單調時鐘，不受時區變更影響。Grafana histogram 分位數為桶內插值，壓測 JSON 的分位數則由逐次樣本計算。

以 `python -m app` 啟動時，每個後端 Pod 由獨立且受監督的程序合併 Prometheus 多程序指標，每 15 秒原子更新共用快照。API 工作程序只讀取快照，不執行大量指標序列化，避免高使用者數的監控計算競爭 API 的 GIL。彙整程序異常退出會自動重啟；首次快照尚未產生或快照超過 45 秒時，`/metrics` 回傳 503，不回傳過時數值。圖表資料因此可能較事件晚約 15 秒，再加上 Prometheus 抓取間隔；這是量測更新延遲，不是主機時鐘偏差。

ASR 與翻譯的一般模型請求使用獨立、有連線數上限的 aiohttp session；摘要串流維持原本的串流客戶端。模型 session 不保存或轉送 Cookie、不跟隨重新導向，且 POST 斷線不自動重送。這符合 [aiohttp 的 session／連線池及 DummyCookieJar 用法](https://docs.aiohttp.org/en/stable/client_reference.html)。本機與 Linux 的客戶端 CPU 比較證據位於驗證報告；其結果不能直接當作整體服務的容量結果。

共用待處理工作數及音訊秒數在單一 Pod 內取最新 worker 的量測值，避免已排空的佇列仍顯示其他 worker 的舊最大值；Grafana 再跨 Pod 取最大值，避免同一份共用佇列被加總兩次。事件迴圈延遲仍取各 worker 最大值，以呈現最慢工作程序。
