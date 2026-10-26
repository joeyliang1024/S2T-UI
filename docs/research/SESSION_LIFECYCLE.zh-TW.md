# 背景處理工作生命週期設計

> 歷史／研究文件：以下數據、路徑與命令僅代表記錄版本，不是現行操作入口。最新操作與驗收請以 [文件入口](../README.md)、[目前結果](../reports/VALIDATION_2026-10-26.zh-TW.md) 及 [重現指南](../guide/REPRODUCE.zh-TW.md) 為準。


本文件整理背景工作（durable job）的生命週期設計：持久化佇列、取消 API、租約續期、多分頁 owner 與 Electron metadata 同步。系統整體背景見 [架構文件](../reference/ARCHITECTURE.zh-TW.md)，部署與重送行為見 [部署指南](../guide/DEPLOYMENT.zh-TW.md)。

## 刪除與 durable job

deleteSession 未取消工作。worker 找不到 session 會 retry，但也可能是工作早於紀錄同步，不能全面將缺少 session 視為刪除。

設計：新增登入保護的 `DELETE /api/data/diarization-jobs?id=...`，調用 `removeDiarizationJob(user.id, id)`，確保帳號隔離與冪等。取消後以既有 `stillOwnsDiarizationJob` 阻止在途結果回寫。刪除與取消失敗要能重試；POST 尚未回傳就刪除的情況，取得 jobId 後須檢查紀錄是否仍存在，否則立即取消。

驗證情境：排隊／推論中刪除、POST 回傳競態、跨帳號拒絕與重複取消，確認無復活及殘留 retry。已開始的推論若要立即停算，另需 AbortSignal／worker 中止；取消資料列本身不保證停止計算。

## 多分頁 owner

`recoverStaleProcessing` 只認識本頁 finishing 和 durable jobId，因此另一分頁會把前一分頁的尾段處理誤判為中斷。

設計：rebase 只合併，另建立以 `processingToken` 為單位的存活協定。以 Web Locks 持有處理所有權，BroadcastChannel 查詢狀態；確認沒有 owner 才恢復 interrupted。背景分頁計時器會節流，不宜僅以短期限 heartbeat 判定死亡。最終寫入仍核對 token。不能只停用 recovery，否則真正中斷的紀錄仍卡在 running。

驗證情境：一分頁收音／尾段／翻譯時另一分頁載入與 CAS 衝突、背景分頁、關閉原分頁、續錄新 token、durable job 完成。

## Electron metadata 同步

`session:save` 與 `session:list` 需雙向同步 processing 欄位，完成／失敗時同步更新磁碟與最終講者逐字稿。

設計：session.json 保存穩定 `sessionId`、`processingState`、`processingStage`、`processingToken`、`processingError`；用暫存檔 rename 原子寫入；IPC 檢查帳號、路徑及 token，拒絕舊結果。重啟後未完成的本機工作顯示 interrupted／failed，保留字幕與音檔供重跑，不宣稱已恢復推論。舊檔缺欄位顯示未知或舊版已保存，不能推定講者已完成。

驗證情境：每個處理階段強制關閉與重開、成功／失敗重開、續錄、舊 metadata、跨帳號路徑與過期 token。
