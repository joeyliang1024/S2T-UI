# 測試證據摘要

保留 100 人成功及兩輪 500 人失敗的實測摘要。舊 500 人 HTTP 報告沒有 P90，不反推；瀏覽器 P90 由原始樣本重算，見 `browser-p90-recalculation.json`。100 人瀏覽器摘要移除逐筆 telemetry／samples，其餘統計保留。

完整原始樣本及 Grafana 時序在本機 `experiment/evaluation-reports/k8s-performance/`（gitignored），以 `local-artifacts-sha256.json` 記錄 SHA-256 與大小；未將完整原始樣本上傳至 Git。數值與限制見上層兩份效能報告。沒有實際密碼、token 或正式用戶資料。
