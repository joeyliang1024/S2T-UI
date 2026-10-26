# 即時字幕優先與背景模型工作限額

> 歷史／研究文件：以下數據、路徑與命令僅代表記錄版本，不是現行操作入口。最新操作與驗收請以 [文件入口](../README.md)、[目前結果](VALIDATION_2026-10-26.zh-TW.md) 及 [重現指南](../guide/REPRODUCE.zh-TW.md) 為準。


即時 ASR 與即時翻譯順位最高；品質校正、匯入、摘要及摘要翻譯延後處理。已送往模型的工作讓它完成，不為插隊而中斷重試。

## 修正前的問題

品質校正與即時字幕共用 ASR／翻譯容量，缺少工作分類與等待優先順序。摘要雖有獨立 HTTP 角色池，長篇摘要每一階段仍用 Promise.all 展開所有分塊；多用戶同時執行時，會增加模型呼叫、Gateway CPU／記憶體、PG 與儲存競爭。既有 100 人完整測試未混入這些背景工作，不能用來證明混合使用的延遲。

## 本次實作

- 每個 HTTP 請求以 AsyncLocalStorage 保存工作分類，避免並行請求互相污染。Web 即時 ASR／翻譯標記 realtime；品質校正、匯入、重試及摘要翻譯標記 background。摘要與說話人辨識路徑在伺服器強制為背景，不接受其自行升級。
- 經認證後，背景模型路徑先取得共用的 Redis 背景租約，才讀取大型 body、寫入 request metadata 或進入帳號 fence。預設全叢集最多 8 個在途背景工作，所有 Gateway Pod 共用；standalone 亦使用有界等待。等候上限為每 Pod 128、60 秒，取消或斷線清除等待，租約持續續期並在完成後釋放。
- 模型 HTTP admission 在同角色佇列內先派即時工作；背景最多占動態容量的四分之一，且不超過背景上限。背景排隊不能占滿即時等待佇列，串流直到消費／取消才釋放 permit。降容不會取消已在途的工作。
- 長篇摘要的分塊、壓縮與合併，每階段最多兩個並行，維持順序、取消隔離與完整結果，不刪掉尚未處理的分塊。
- 新增即時／背景 active、waiting、limit 的 Grafana 圖表；壓測 mock 模型另記實際 background peak，不能只憑用戶數推斷背景限制有效。

## 設定與邊界

`S2T_BACKGROUND_MAX_INFLIGHT` 預設 8，支援 1..64，各 Pod 須使用相同設定。這是應用程式請求 admission，不是模型 token 排程或作業系統 CPU 搶占。僅剩一個可用 slot 時，已啟動的背景工作仍須完成；所有設定均保留硬上限。

舊 ASR／翻譯客戶端未帶分類時維持 realtime，相容舊 API。這不是安全授權機制；需使用更新後的客戶端才能正確區分品質校正等用途。背景等待滿或超過期限會回傳可見錯誤，並非新增永久背景作業系統。

Gateway 路徑適用上述跨 Pod 保護；Electron 直接呼叫模型的模式不經 Gateway，不能宣稱具有相同的叢集排程。PG、MinIO、CPU 仍有共享資源，模型服務若共用 GPU 也仍會競爭，實際 P90 必須以混合負載測量。

## 驗證

原本 100 人／600 秒通過的結果屬於前一版，見 [100 人修正總報告](PERFORMANCE_100_2026-10-22.zh-TW.md)；500 人未通過的紀錄繼續保留。此次另執行固定 2 Pod、模型各 500ms、100 個即時用戶加 32 個背景執行者的混合驗證。

### 120 秒混合診斷

台北時間 2026-10-22 00:58:56 起跑，提供並完成 6,000 段即時音訊；19,200 次即時 HTTP 與 1,777 次背景模型請求全部成功，丟棄 0。背景包含 ASR 789、翻譯 796、摘要 192 次，模型端 background peak=8。

同步 Chromium 抽樣起跑偏差 24ms，原文／譯文各 50 組，ASR E2E P90 0.883s、包含 ASR 的翻譯 E2E P90 1.549s；t5／t7 network P90 12.58／12.70ms，無瀏覽器或傳輸錯誤。這是短測，不取代 600 秒驗收。

Grafana 本機通道中斷時，Prometheus 仍持續收集。恢復 SSH 通道後已補取完整 query_range，沒有指標缺口。

### 驗證時修正的監控誤差

跨 Pod 的本地 active gauge 由不同時間點抓取，直接相加會短暫顯示 14，不能拿來驗證全叢集上限。同期模型端實際背景峰值始終為 8。新增每 5 秒唯讀 Redis ZCARD 快照，取全叢集背景租約數；dashboard 使用各 Pod 快照的 max，另顯示健康及快照 age。初始未知為 -1，讀取失敗保留舊值並標成 unhealthy，不偽裝成零。租約包含尚在釋放的 permit，與模型實際 active 分開報告。

Sampler 只在該 Pod 首次執行背景工作後啟動；純即時流量不增加此 Redis polling。關閉時清理 timer。回歸證實 global gauge 取自 Redis，而不是本地 active 數。

### 測試資料與儲存空間

完整長測前已取得使用者明確同意，只整理先前失敗壓測分片 72db6f44：25,543 個 PCM 物件、125 個無法密碼登入的合成帳號及 250 筆 metadata。每個物件的 key、長度、ETag 與 manifest digest 均核對；全部 PCM 相同，已保存單一 canonical body、完整物件清單及 PG metadata，可重建。歸檔壓縮檔 366,493 bytes，代表 1,634,752,000 bytes PCM；SHA-256 為 dd06c509cda5e230f2bd955916796516dbb6935767d99f7f7b3deedc41efafde。本機歸檔位於 experiment/evaluation-reports/k8s-performance/synthetic-shard-72db6f44.json.gz，未上傳至 Git。其他帳號及物件不在整理範圍內。

### 提交前回歸

獨立暫存內容的 npm run check 通過：TypeScript、架構 203 modules、unit 87/87、HTTP 17/17、Electron 與 Web build。測試基底映像被 K8s 回收時，增量建置現改為先驗證既有映像的 package-lock SHA-256，匹配才重用；不匹配要求 --full，避免只覆蓋原始碼而漏裝依賴。

### 完整 600 秒混合驗證

本輪通過 P90、HTTP 成功率、工作完整性及背景上限檢查。台北時間 2026-10-22 07:33:21–07:43:21，固定 2 個 Gateway Pod、100 個即時帳號、32 個背景模型 API 執行者；模型每次讀完請求後等待 500ms，仍包含即時錄音分段保存及每 10 秒草稿。

| 指標 | 完整 600 秒結果 |
| --- | ---: |
| ASR E2E P90 | 0.877s |
| 含 ASR 的翻譯 E2E P90 | 1.498s |
| 全即時負載 ASR HTTP P90 | 0.764s |
| 全即時負載 ASR→翻譯 HTTP P90 | 1.311s |
| 即時提供／完成鏈路 | 30,000／30,000 |
| 即時 HTTP 成功 | 96,000／96,000（100%） |
| 背景 HTTP 成功 | 8,980／8,980（100%） |
| 背景 ASR／翻譯／摘要完成 | 4,023／4,014／943 |
| 負載 HTTP 合計成功 | 104,980／104,980（100%） |
| 丟棄／傳輸或 HTTP 錯誤 | 0／0 |
| Redis 全叢集背景租約峰值 | 8 |
| 模型端背景實際峰值 | 8 |
| 模型端即時實際峰值 | 192 |
| 模型端合計實際峰值 | 197 |
| Gateway／MinIO／PG／Redis／Prometheus 重啟 | 0 |
| t5／t7 network P90 | 8.68／8.31ms |

另有 200 次即時帳號初始化，全部成功。字幕數原文／譯文各 250，瀏覽器與負載起跑偏差 16ms；背景起跑偏差約 7ms。背景工作持續完成而非被暫停，也沒有排隊逾時。

模型計數交叉核對：即時完成 60,500 次（30,000 ASR + 30,000 翻譯 + 瀏覽器原文／譯文各 250），背景完成 8,980 次，合計 69,480，與模型端累積值完全一致。這也驗證分類有傳遞到實際上游，沒有把背景誤標成即時。

完整負載仍保留長尾：ASR→翻譯 HTTP 有 91／30,000 條 ≥3s，最大 3.815s；錄音上傳 17／30,000 次 ≥3s，最大 3.114s。瀏覽器抽樣沒有 ≥3s 的字幕，ASR E2E 最大 2.027s、翻譯 E2E 最大 2.743s。驗收以 P90，不隱藏這些長尾。

### Grafana 瓶頸核對

- 整輪查詢皆有實際資料，Gateway up 持續為 1／1。權威背景租約 ≤8，快照在啟動期後均 healthy，最大觀測 age 1.223s；模型端峰值另獨立驗證為 8。
- PG query waiting 單 Pod 抓取最高 1，fence／health 等候 0；沒有持續積壓。背景 waiting 抓取最高 18，低於有界等待上限。
- Gateway event-loop P99 抓取最高 123ms；單 Pod CPU rate 最高約 0.48 核。每分鐘 storage P95 估計最高：MinIO PUT 0.742s、request 清理 0.580s、錄音 metadata 0.259s，與整輪精確樣本分位數分開解讀。
- MinIO working set 抓取最高約 1492MiB，接近 1536MiB 上限，仍需保留監控；本輪沒有 OOM／重啟，中段 RSS 約 419MiB，不能把 working set 全當成 Go heap。Gateway working set 最高約 436MiB，PG 約 389MiB。
- 測後磁碟約餘 3.7GB；所有即時／背景負載產生端已縮為 0，Gateway、Grafana 與 Prometheus 保留。

### 驗證範圍與重現證據

這輪證明 100 個模擬即時用戶與 32 個背景模型 API 執行者混合時的上述結果。瀏覽器 E2E 是一個額外 Chromium 探針，不是 100 個實體瀏覽器；不含實體麥克風、Silero 模型或 WAN。背景請求涵蓋品質校正使用的 ASR／翻譯路徑及摘要 API，並未重現完整品質校正 UI 的音檔下載、說話人辨識及結果保存流程；長篇摘要兩個分塊並行與串流取消由回歸覆蓋。健康 Sentinel 下的上限已測，真實切主仍未驗證。

此次沒有重跑 500 人完整混合驗收，不能由 100 人結果外推。前一版 100 人測試與本輪之間還有不同的暖機／資料量／VM 狀況，不能將延遲改善全歸因於優先排程。

實測映像為 sha256:180536b7eb8d5e26eec237e695351bcdeef5c32bbf587a9aba1ce0ed1d701a8f；使用 --experimental-async-context-frame --max-semi-space-size=64。即時每人每 2 秒送 2 秒 PCM，沒有減少上傳／草稿或忽略丟棄。四分片原始樣本合併計算 P90，沒有平均分位數。

可隨 Git 檢視的摘要、Pod 映像與結果判定見 [混合測試證據](performance-evidence/2026-10-22/priority-mixed/README.md)。完整原始樣本、瀏覽器 telemetry、Grafana query_range 及歸檔仍在本機 experiment/evaluation-reports/k8s-performance/。
