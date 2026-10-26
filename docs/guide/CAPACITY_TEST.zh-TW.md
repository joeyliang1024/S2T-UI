# Python 後端容量量測

繁體中文 | [English](../en/CAPACITY_TEST.md)

功能正確與容量是不同驗收項目。先依 [驗收手冊](VALIDATION.zh-TW.md) 完成 Web、Python 與跨 Pod 測試，再以實際模型和音訊工作負載測量。

目前 `test:deployment`、`test:replicas`、`test:monitoring` 是功能與計時驗證，不是負載產生器。舊 Node Gateway 的壓測結果及 `experiment/` 中既有數據僅代表當時版本，不可套用到 Python 後端，也不能據此承諾使用人數。

記錄映像版本、Pod 數、CPU／記憶體限制、模型、音訊長度、語音比例、字幕速度檔位與外部 API 配額。在隔離環境逐步增加並行錄音，觀察端到端延遲、錯誤率、HTTP admission、音訊工作佇列、CPU／RSS、PostgreSQL 連線與儲存延遲。

應以持續一段時間後的穩定狀態判斷容量，並測停止錄音、保存、背景工作排空及 Pod 重啟恢復。mock 的固定延遲不代表模型計算成本；兩個後端也不代表吞吐量必然翻倍。

調校參數見 [環境選項](ENVIRONMENT-OPTIONS.zh-TW.md)，指標解讀見 [監控指南](OBSERVABILITY.zh-TW.md)，目前實測範圍見 [部署報告](../reports/VALIDATION_2026-10-26.zh-TW.md)。

## 可重現的錄音與模型混合負載

`scripts/benchmarks/k8s/recording-load.cjs` 在指定測試 namespace 內啟動負載，避免用 `kubectl port-forward` 承載 500 人。必須明確設定 `S2T_ALLOW_DEPLOYMENT_TESTS=true`，並提供 500 個不同測試帳號的 JWT JSON 陣列；每個帳號會在量測開始前驗證。憑證只放在測試 Secret，不會寫入報告。

```sh
S2T_ALLOW_DEPLOYMENT_TESTS=true S2T_LOAD_TOKENS_FILE=/private/path/tokens.json LOAD_POD=s2t-recording-acceptance LOAD_SECONDS=600 LOAD_CADENCE_MS=3000 npm run test:load:k8s -- start
S2T_ALLOW_DEPLOYMENT_TESTS=true LOAD_POD=s2t-recording-acceptance S2T_LOAD_REPORT=/tmp/recording-acceptance.json npm run test:load:k8s -- collect
S2T_ALLOW_DEPLOYMENT_TESTS=true LOAD_POD=s2t-recording-acceptance npm run test:load:k8s -- cleanup
```

預設每人每 2 秒 ASR 後翻譯，兩個 mock 各 500ms；16kHz PCM 錄音獨立分批上傳。500 人 × 600 秒會產生 9.6 GB PCM，必須另外預留合成、資料庫、日誌與 Kubernetes 磁碟壓力門檻的空間。負載來源是虛擬 PCM 暫存，不代表同時開啟 500 個真實瀏覽器；真實瀏覽器 OPFS、字幕與繪製延遲另測。

只要排程丟棄、工作失敗、錄音未完全回讀一致或未確認清理，就不算通過。HTTP 重試前的錯誤仍需逐項揭露。產生器逾時或無法依節奏送出請求，也必須判定失敗；不能延長錄製時間來補足請求後宣稱 600 秒通過。

目前採用的 3 秒 cadence 容量條件與清理程序見 [重現指南](REPRODUCE.zh-TW.md)；工具未指定時預設 2 秒，這是未通過的極限條件，不可當成 3 秒通過結果。
