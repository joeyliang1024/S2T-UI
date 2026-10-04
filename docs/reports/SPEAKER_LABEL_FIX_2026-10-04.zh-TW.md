# 講者標註第一階段修正與驗證（2026-10-04）

## 已套用

- upsertLiveCaption 保存 ASR 原始 revision，避免講者更新提高 UI revision 後攔截有效 ASR 更新。相同時間範圍的 ASR 更新保留既有講者；時間範圍改變時不盲目繼承。人工講者與人工編輯旗標保留。
- 新 ASR 字幕會以已取得的講者時間軸補標，未涵蓋的新時間不猜測上一位講者。
- 續錄預覽在送出時固定 baseDurationMs 與 rolling offset，與字幕使用同一時間軸。
- 預覽固定 captureId，丟棄前一輪收音晚到的成功或失敗訊息，避免污染新录音。
- 本機 LocalConfigStore 增加持久化背景講者工作，使用既有跨程序檔案鎖與原子 JSON；支援 claim、重試退避、租約 generation、完成／失敗、取消。無工作時不反覆重寫設定檔。
- local／PostgreSQL 工作在推論中每分鐘續期五分鐘租約；完成或失敗後清除 timer。過期或舊 generation 不得续期或回寫。
- 登入保護的 DELETE /api/data/diarization-jobs?id=...，按帳號取消；前端刪除接線及 POST 回傳前已刪除的競態已處理。取消失敗會顯示；未宣稱可以立即終止已開始的原生計算。
- Nemotron catch 記錄 durationSec、code、exitStatus、signal、phase，避免輸出音訊、金鑰、原始 native stdout／stderr 或命令。這是診斷改善；原先偶發 502 根因仍未知。

## 驗證

- TypeScript、字幕背景、講者分配、字幕分組、本機儲存、登入、字幕 Gateway、品質校正、翻譯策略與字幕 lifecycle／10 分鐘虛擬收音回歸通過。
- 新增 speaker-flow-smoke-test：ASR 更新保留標籤、手動標記、時間範圍改變、ASR source revision、續錄偏移、過期 capture 不污染新錄音。
- 新增 local-diarization-jobs-smoke-test：不同實例持久化讀取、同程序及不同程序 claim 互斥、帳號隔離、retry 等待、過期租約恢復、generation fencing、續期、完成／失敗及取消不復活。
- 真實 PostgreSQL／MinIO／Milvus 隔離測試通過，含續期及拒絕錯誤／過期租約。
- 同一 Docker image、隔離 local 資料：60 秒 VoxConverse jcako 素材經 HTTP 上傳、session 保存、背景排程、真實 Nemotron 推論、session 回填。兩次測試皆完成；最終一輪約 8.1 秒（含輪詢及排隊），30 個測試時間片中 22 個得到自動講者，人工標記保留、音訊版本同步。這是功能煙霧測試，未評 DER，未宣稱所有字幕均應有標籤。
- 取消 API 驗證：未登入 401、別帳號不能刪除他人工作、本人取消後 404、重複取消 204。
- worker mock 驗證續租回呼及 timer 清理；未用真實超過五分鐘推論驗證續租，因此長會議仍需另測。
- 最終 Docker 重建完成，8787 readyz 正常。現有 local 主站資料卷、模型、環境設定與 npm registry 沿用；沒有切換儲存後端或新增套件。隔離容器已移除。

## 仍待驗證與下一階段

- 多段同講者覆蓋率加總未啟用，維持原 35% 門檻，需要真實字幕與跨講者句比較。
- 即時仍為每 30 秒最近 45 秒預覽，尚未整合 session 級持續 native stream。現有 native HTTP diarization 是完整上傳路徑，不能拿它冒充持續串流。後續需要 C ABI 或有狀態橋接、session／sequence／取消契約，並驗共享 CPU 下的 ASR 延遲。
- 多分頁存活協定及 Electron session.json 處理狀態同步尚未在本輪實作。
- 舊紀錄因先前 503 已標 failed 不自動重跑；可從記錄的「自動識別講者」重新辨識。新的停止錄音才會走新增背景工作。
