# 實驗入口

每輪實驗只保留 markdown 紀錄（方法、數據表與結論）。原始 JSON／CSV、日誌、截圖、回放頁面與音檔不納入版本控制；需要時可由 Git 歷史或對應評測腳本重跑取得。

| 類別 | 入口 | 內容 |
| --- | --- | --- |
| 多 Pod／儲存／滾動更新 | [Kubernetes](k8s/README.md) | 現行至少 2 Pod 測試及必要歷史修正證據 |
| 首字延遲／監控 | [Monitoring](monitoring/README.md) | 單張 Grafana、階段占比與採樣限制 |
| 字幕／VAD／停止暫停 | [Captions](captions/README.md) | 音訊保留、字幕延遲與顯示分組 |
| 講者分離 | [Diarization](diarization/README.md) | Nemotron／sherpa 比較與參考結論 |
| 字幕切段與回應速度 | [Silero VAD Chunking](silero-vad-chunking/README.md) | 五格速度、VAD 修正與 CER 對照 |
| 摘要與資料復原 | [Summary](summary/README.md) | 摘要模板、錯誤復原與狀態標籤修正 |
| 翻譯排程 | [Translation](translation/README.md) | 排程佇列在不同延遲下的對照 |
| Admin 與儲存復原 | [Admin](admin/README.md) | 雙 Gateway schema 刪除與 bootstrap admin 復原 |
| 小型歷史評測 | [Evaluation](evaluation-reports/README.md) | 已記錄的參數比較，非現行操作入口 |

現行操作請看 [文件入口](../docs/README.md)。`private/` 為本機憑證與帳號資料，不納入版本控制。
