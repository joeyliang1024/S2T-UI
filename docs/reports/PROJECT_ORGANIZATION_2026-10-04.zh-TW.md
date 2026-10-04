# 專案整理與 Docker 驗證（2026-10-04）

測試分為 tests/smoke、integration、helpers、fixtures；工具分為 scripts/audio、evaluation、benchmarks、storage；29 份評測結果搬至 experiment/evaluation-reports。保留 npm 指令名稱，補上各目錄索引與 config/vite.web.config.ts，修復 web:preview 原先不存在的設定路徑。

現有模型、音訊素材、資料庫、Docker 啟動入口保持原路徑。SHA256 比對确认 .env、.env.local-storage、兩份 Compose、Dockerfile.web、package-lock.json 及 29 份歷史結果內容不變。既有未提交修改保留，沒有提交或重置。

## 驗證結果

- TypeScript 檢查、51 份 CJS 語法檢查與 npm 入口存在性通過。
- 本機儲存、登入、字幕 Gateway、環境變數、模型路徑、字幕合句、翻譯策略、匯入 checkpoint、品質校正、逐字稿匯出、OPFS、語系測試通過。
- 評測 mapping 自測 400 個隨機矩陣通過。
- 真實 MinIO／PostgreSQL／Milvus 讀寫、CAS、durable job 與向量查詢通過；測試資料清理。
- Docker 使用原 npm registry、ignore-scripts 成功重建；8787 livez／readyz 正常。既有其他服務容器持續運作。
- Docker 18 種短音訊格式轉換及拒絕／取消清理測試通過；未測完整 2GB。
- 相同 image 及環境模型掛載，60 秒 CPU 講者分離得到 13 區段、3 位講者及 3 組聲紋，耗時 10.7 秒。
- 容器 18 個預期環境變數一致；Chrome 網站載入無 pageerror。
- 已授權旁白前 20 秒：既有 ASR HTTP 200、有文字，約 6.9 秒；既有翻譯 HTTP 200、有文字，約 3.5 秒。此次屬連線／推論煙霧測試，未重評字幕準確度或長會議準確度。

8787 繼續使用原本 local blob/config/vector。外部服務另以隔離測試確認可連線，未切換主站儲存或遷移使用者資料。

## 背景處理待修

已查明三項問題並記錄於 SESSION_LIFECYCLE.zh-TW.md；目前僅提供修正設計，尚未實作／驗證取消路由、跨分頁 owner 協定或 Electron metadata 同步。
