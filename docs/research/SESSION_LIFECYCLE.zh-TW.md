# 背景處理生命週期檢查（2026-10-04）

已核對現有程式。2026-10-04 第一階段已補本機 durable jobs、取消 API／前端接線及租約續期，見 [驗證報告](../reports/SPEAKER_LABEL_FIX_2026-10-04.zh-TW.md)。以下保留原修正設計；多分頁 owner 與 Electron metadata 同步尚未套用。

## 刪除與 durable job

deleteSession 未取消工作。worker 找不到 session 會 retry，但也可能是工作早於紀錄同步，不能全面將缺少 session 視為刪除。

新增登入保護的 DELETE /api/data/diarization-jobs?id=...，调用 removeDiarizationJob(user.id, id)，確保帳號隔離與冪等。取消後以既有 stillOwnsDiarizationJob 阻止在途結果回寫。刪除與取消失敗要能重試；POST 尚未回傳就刪除的情況，取得 jobId 後須檢查紀錄是否仍存在，否則立即取消。

驗證排隊／推論中刪除、POST 回傳競態、跨帳號拒絕與重複取消，確認無復活及殘留 retry。已開始的推論若要立即停算，另需 AbortSignal／worker 中止；取消資料列本身不保證停止計算。

## 多分頁

recoverStaleProcessing 只認識本頁 finishing 和 durable jobId，因此 B 會把 A 尾段處理誤判為中斷。

rebase 只合併，另建立以 processingToken 為單位的存活協定。建議 Web Locks 持有處理所有權，BroadcastChannel 查詢狀態；確認沒有 owner 才恢復 interrupted。背景分頁計時器會節流，不宜僅以短期限 heartbeat 判定死亡。最終寫入仍核對 token。不能只停用 recovery，否則真正中斷的紀錄仍卡在 running。

驗證 A 收音／尾段／翻譯時 B 載入與 CAS 衝突、背景分頁、關閉 A、續錄新 token、durable job 完成。

## Electron

session:save 沒寫 processing 欄位；session:list 也沒讀，兩側及後續完成寫入都需要補齊。

session.json 保存穩定 sessionId、processingState、processingStage、processingToken、processingError；開始及完成／失敗時同步更新磁碟與最終講者逐字稿。用暫存檔 rename 原子寫入；IPC 檢查帳號、路徑及 token，拒絕舊結果。重啟後未完成的本機工作顯示 interrupted／failed，保留字幕與音檔供重跑，不宣稱已恢復推論。舊檔缺欄位顯示未知或舊版已保存，不能推定講者已完成。

驗證每個處理階段強制關閉與重開、成功／失敗重開、续錄、舊 metadata、跨帳號路徑與過期 token。
