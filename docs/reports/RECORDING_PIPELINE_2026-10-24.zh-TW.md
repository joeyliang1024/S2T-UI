# 錄音寫入與背景上傳修正驗證

繁體中文 | [English](../en/RECORDING_VALIDATION_2026-10-24.md)

日期：2026-10-24。既有本機隔離 Colima／K3s：前端 `s2t-frontend:web-20261024-r8` 1/1 Ready，Python 後端 `s2t-backend:web-20261024-r5` 2/2 Ready。此次只修改前端錄音流程，後端介面與共享儲存沿用既有部署。

## 修正

- 本機 OPFS 寫入完成即可釋放 PCM writer；遠端上傳不再阻塞本機錄音。
- 支援的瀏覽器以 dedicated Worker／sync access 寫入，否則使用非同步 fallback。
- OPFS v2 以獨立 commit 標記排除崩潰時未提交尾段，仍可讀取 v1。
- 背景上傳從 OPFS 讀取，每次最多 1 MiB；失敗範圍固定，新增音訊不改變重送內容。
- 依 durable ACK 增加游標，暫時錯誤退避加 jitter、永久錯誤停止重試；帳號切換隔離。
- 停止錄音的遠端收尾有 30 秒網路期限；無法完成時保留本機音訊與保存／下載／恢復動線。

## 驗證結果

`npm run check` 通過型別、架構、50 項單元測試及 Web build。`npm run test:e2e` 兩項通過，使用自動選擇的本機 Chrome 與根目錄 `.venv`。

單元測試以兩分鐘模擬音訊驗證：上傳卡住不產生收音 backpressure、讀取範圍有界、恢復後音訊逐位元組一致。另驗證持續收音時遺失 ACK、永久 403、帳號切換及網路收尾逾時。

真實 Chrome 測試涵蓋 AudioWorklet → PCM writer → OPFS Worker → 背景上傳，核對收到的樣本數與 WAV 音訊位元組數、恢復後遠端與本機音訊完全一致。也驗證離線收尾、重載恢復、未提交尾段排除及獨立來源清理。

實際經 Nginx／Python／MinIO 的瀏覽器故障測試：

| 項目 | 結果 |
| --- | --- |
| 上傳受阻 | 65 秒，共 24 次請求被刻意中斷 |
| durable ACK 遺失 | 前 3 次請求已由真實後端持久化，再刻意丟棄回應 |
| 故障期間本機已提交音訊 | 64 秒；其餘尾段在後續 drain 提交 |
| 收音狀態 | `recording`，未因上傳 backpressure 暫停 |
| 字幕／翻譯 | 故障期間持續產生（外部模型為 mock） |
| 最後保存 | 7,988,268 bytes WAV、26 筆字幕，背景狀態 `completed` |

登入、設定 CAS、錄音分塊、摘要、聲紋、FFmpeg／Silero／Sherpa、登出與專用測試帳號清理也通過。Grafana／Prometheus 兩後端 targets 正常，看板查詢無錯誤，瀏覽器量測 count／sum 相符；時鐘差約 0.019 秒。

## 範圍限制

不是 500 人壓測。外部 ASR／翻譯／摘要是 mock，不能代表真實模型容量或準確率。磁碟寫入長期停滯、OPFS 配額耗盡或硬體失效時仍可能保護性暫停，不能保證無限錄音。Safari／Firefox 實機、GPU、跨節點故障與正式容量未在本輪驗證。關閉瀏覽器後不會繼續背景上傳，需使用本機恢復動線。

設計來源、操作與重跑指令見 [錄音可靠性指南](../guide/RECORDING_RELIABILITY.zh-TW.md)。

## 證據

摘要（本機歷史資料）、部署（本機歷史資料）、功能／故障測試（本機歷史資料）、監控核對（本機歷史資料）。
