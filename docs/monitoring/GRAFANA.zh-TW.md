# Grafana 指標口徑

執行 `python3 deploy/monitoring/generate.py` 會同步產生 dashboard.json、oncall.json 與 stack.json。值班總覽重用詳細總覽的 KPI、部門分析與 storage 健康圖，避免口徑漂移。

- E2E P90：所選時間區間，音訊時鐘上的最後 VAD 語音樣本到該段譯文在可見即時頁呈現。扣除 VAD 靜音確認區間，但仍是語音尾端估計，非逐字強制對齊。目標嚴格小於 3 秒。翻譯未開啟、分頁隱藏、切換頁面或未呈現時不補零。
- t1～t7：瀏覽器先加總每段各 phase 的子切片，再送一個 phase 樣本。t5 等畫面呈現後合併 network 與 paint；不將子切片樣本數當分母。不同 phase 的有效樣本可能不同，不將平均相加當 E2E。
- API 成功率：HTTP < 400 的完成請求比例。個人／部門 API 成功率另外將中斷視為未成功。無流量時顯示無資料。
- Storage：PostgreSQL、Redis、Sentinel、MinIO、Milvus、etcd 只保留健康卡。MinIO／Milvus 目前是 metrics endpoint 可達性；不代表端到端讀寫驗證。未抓到資料不視為健康。

## 部門事件

僅 Web 已登入使用者送出；使用伺服器驗證的帳號及部門，不接受瀏覽器提供部門。

- L1：已登入應用首次載入，每次頁面載入一次。
- L2：按下開始／繼續錄音按鈕，一次點擊一次，包含開始失敗的嘗試。
- L3：開啟紀錄內容或摘要，且實際有非空內容。切換其他紀錄或離開後重新進入可再次觸發；空內容、尚在生成的摘要不算。

部門選單置頂，All 每部門一條線；單選部門只顯示該部門。L2 人數依 user_id 去重，次數加總 L2 事件，不受 NT 篩選影響。各圖跟隨上方所選區間，折線依區間自動調整取樣窗口；預設最近一週、每 30 秒刷新。

漏斗使用 Grafana 內建水平階段長條，顯示所選期間的 L1／L2／L3 不重複人數與三個轉換率，不需安裝插件。這是同期間各階段人數比例，非依序完成的 cohort 漏斗：既有使用者及跨週使用可能使比例超過 100%。分母為零顯示無資料。

遙測是 best effort；不自動重送事件以避免回應遺失造成重複計數。Prometheus 的 increase 是 scrape 間估算，新帳號第一個 scrape 前的事件、程序重啟及遙測失敗可能造成低估，不作稽核帳本。舊 API 計數不能回補成 L1／L2／L3。

## 部署

本次工作只更新原始碼與產生的設定，未更新線上服務。

1. 建置、更新 Web 與 Gateway，兩者需同時支援新 phase／E2E 樣本及 `/api/telemetry/journey`。
2. 將 stack.json 的 s2t-dashboard ConfigMap 更新至既有 Grafana 部署。保留既有 datasource／連線設定；不要為更新報表重建整個叢集或重設 Secret。
3. Prometheus 產生設定改為最多 90 天／8 GB，PVC 需求改為 10 GiB。既有 PVC 必須先確認 StorageClass 可擴充及磁碟容量後再調整；Grafana PVC 維持 2 GiB。容量上限可能使實際保留時間短於 90 天。
4. 新事件需累積資料，部署前週次不會有歷史事件；部署後第一週為部分資料。確認來源選擇正確，避免與 acceptance 模擬資料混用。

## 獨立測試資料預覽

`python3 deploy/monitoring/install-report-preview.py` 在既有測試叢集建立 metrics-only 的 `report-preview`，來源為 `gateway-report-preview`。3 部門／12 位使用者皆有「測試」標記，不呼叫模型、不寫正式帳號與儲存；僅產生合成監控數據，15 分鐘後停止增加。

預覽大表為 `/d/s2t-report-preview`，值班版為 `/d/s2t-oncall-preview`，標題均顯示「測試資料預覽」。正式報表只保留真實 gateway-web 來源，並移除 mock 模型圖與 mock／驗收／預覽 Pod 資源列。預覽沿用最近一週、每 30 秒刷新的預設，沒有回填歷史資料。

停止預覽可將 `deployment/report-preview` scale 至 0；重新執行 installer 可重跑。Prometheus restart 不會清除既有 TSDB。此 installer 僅追加獨立 scrape job 和 Grafana 預覽掛載，不更新真實 Gateway。完整重新產生 stack 後，若仍需預覽，須重新執行 installer 保留其 scrape／掛載。

## 使用量趨勢

User 使用量改為 NT 折線圖：每個 NT 一條線，以 L2 按開始／繼續錄音次數計算。部門沿用兩張折線圖，每部門一條線，分別顯示 L2 不重複使用人數及使用次數。所有圖表的橫軸跟隨上方選取的時間區間，取樣窗口自動調整；沒有回填歷史資料。部門／NT 篩選套用於 NT 趨勢；部門趨勢與漏斗不受 NT 篩選影響。

原使用者明細表、比較長條、部門 API／Token 用量長條與速率圖已移除，保留 L2 使用量趨勢及 L1→L2→L3 漏斗。

## HTTP 錯誤趨勢

4xx 與 5xx 分成兩張折線圖，依 NT 彙總錯誤次數；同 NT 的各 API 操作合併。兩圖共用上方部門／NT 篩選，依所選區間自動調整取樣窗口。依已驗證帳號的 `client_error`／`server_error` 計數，無法歸屬 NT 的未登入請求及連線中斷不計入，亦不將中斷視為 5xx。正式版與預覽版皆保留 HTTP 成功率 KPI，移除原本混合 4xx／5xx 的 HTTP 失敗圖。

## 共用時間範圍

正式／預覽的大表及值班版，預設均為最近一週（now-7d 到 now），每 30 秒刷新。上方選取其他區間後，所有圖表一起跟隨；不設個別面板的 timeFrom／timeShift，也不再固定最近 5 分鐘或每週 7 天的查詢窗口。

KPI、平均延遲、分位數與漏斗等摘要圖以完整所選區間計算，於所選區間終點查詢。折線圖橫軸使用所選區間，速率／延遲趨勢使用自動 rate 窗口，使用及錯誤次數使用自動取樣窗口；各點是該窗口的數據，並非整段區間的累計。健康卡顯示所選區間終點的狀態。

## ASR 堆疊趨勢與資源區塊

ASR 階段堆疊圖加大為半版寬、8 格高，使用 50% 填色、可見資料點及較高解析度，避免短暫測試在一週尺度只剩一個不明顯的點。無樣本期間維持空白，不補零或回填虛構延遲。Kubernetes Pod／Deployment／CPU／Memory／PVC 資源區塊已從報表移除。

## ASR 分鐘平均趨勢

依最新需求，原「ASR 端到端延遲趨勢 P50／P95／P99」替換為「ASR t1～t5 每分鐘平均耗時」。每個 phase 一條折線，使用完整 phase 的 `_sum`／`_count` 之 1 分鐘增量比例；固定 1 分鐘取樣，預設一週可容納 10,080 個時間點。這張圖是明確指定 1 分鐘窗口的例外，橫軸仍跟隨上方區間；其餘圖維持自動窗口。無樣本留白，不補零。
