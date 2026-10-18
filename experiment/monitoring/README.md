# 監控實驗

現行設定只有一個入口：[監控指南](../../docs/guide/OBSERVABILITY.zh-TW.md)。Grafana [總覽](http://127.0.0.1:13000/d/s2t-overview?orgId=1&from=now-30m&to=now&refresh=5s) 包含首字、六步驟耗時百分比、HTTP／模型、Storage、Redis／Sentinel 與 Pod 資源。

[現行多 Pod／慢遙測重測](../k8s/README.md) 為最近部署的證據。以下保留各輪的量測結論，重跑指令以現行指南為準：

- [監控導入與量測定義](history/setup-2026-10-06/README.zh-TW.md)
- [六步驟時間守恆及占比](history/stage-share-2026-10-06/README.zh-TW.md)
- [Environment connection verification](connection-2026-10-06/README.md)
- [Per-chunk UI latency](chunk-latency-2026-10-07/README.md)
- [2026-10-11 監控驗收](acceptance-2026-10-11/README.md)

量測結果以 markdown 記錄，不另存 JSON／截圖。沒有樣本時不填虛構值；選取包含最近實驗的時間範圍即可查看已有資料。
