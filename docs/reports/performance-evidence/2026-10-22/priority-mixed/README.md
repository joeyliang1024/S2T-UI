# 即時優先混合測試證據

120 秒診斷與完整 600 秒結果分開保留。600 秒由 100 名即時用戶、32 個背景 API 執行者及一個可見 Chromium 探針同步執行；模型各 500ms。合併 P90、HTTP／丟棄、背景完成、Redis 權威租約與模型峰值均通過，見 verdict。

Grafana 摘要保留每條序列的樣本數及 min／max，不能拿來重算整輪分位數。完整 query_range、逐筆 HTTP／瀏覽器樣本與合成分片歸檔保留本機，SHA-256 與大小見 local-artifacts-sha256.json；未將完整原始樣本或可重建的 PCM 歸檔上傳到 Git。瀏覽器摘要移除逐筆 samples／telemetry，其餘診斷保留。

本次僅整理使用者明確授權的合成分片 72db6f44，清理摘要與歸檔來源雜湊保留；不包含真實密碼、token 或正式用戶資料。詳細範圍與限制見上層 REALTIME_PRIORITY_2026-10-22.zh-TW.md。
