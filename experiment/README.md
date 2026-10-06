# 實驗入口

| 類別 | 入口 | 內容 |
| --- | --- | --- |
| 多 Pod／儲存／滾動更新 | [Kubernetes](k8s/README.md) | 現行至少 2 Pod 測試及必要歷史修正證據 |
| 首字延遲／監控 | [Monitoring](monitoring/README.md) | 單張 Grafana、階段占比與採樣限制 |
| 字幕／VAD／停止暫停 | [Captions](captions/README.md) | 音訊保留、字幕延遲與模型比較 |
| 講者分離 | [Diarization](diarization/README.md) | 最終比較、參考音訊與回放 |
| 小型歷史評測 | [Evaluation](evaluation-reports/README.md) | 已記錄的參數比較，非現行操作入口 |

每輪只保留摘要、可重現腳本與能證明結果的資料。已被取代的部署快照、重複資料、build 日誌、無效試跑已移除；更早版本可由 Git 歷史找回。

現行操作請看 [文件入口](../docs/README.md)。private/ 為本機憑證與帳號資料，不納入版本控制。
