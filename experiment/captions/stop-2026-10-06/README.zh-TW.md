# 停止收音與不可重試錯誤

Chrome 實際收音 600ms 後停止，模擬 ASR 1200ms，最後一段成功儲存：1 個請求、1 段字幕，約 3353ms 完成背景處理。停止時同步更新的 transcript ref 已保護尾段，這個路徑沒有重現儲存遺失。

發現 Web ASR 的永久 HTTP 400 會重送四次，額外等待 2750ms。現在 400/401/403/404/405/410/413/415/422 直接失敗；408/409/425/429 與服務端暫時錯誤保留重試及相同 idempotency key。修正後 probe 為一次請求、零重試等待。Electron IPC 不一定保留 HTTP 型別，此修正只保證 Web 路徑。

驗證：永久錯誤與暫時錯誤 smoke、慢 API backlog、字幕 regression、TypeScript 全部通過。原始結果在 results/。
