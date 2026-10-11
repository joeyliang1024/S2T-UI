# K8s 容量測試

驗收 100 個獨立帳號同時收音翻譯，另測 150 路餘裕；逐階 1／10／25／50／100／150，100 路至少 30 分鐘。部署與指標設定見 K8S_SCALE_DEPLOYMENT.zh-TW.md。

```sh
S2T_LOAD_BASE_URL=https://s2t.example.internal \
S2T_LOAD_TOKENS_FILE=/secure-fixtures/tokens.json \
S2T_LOAD_WAV=/secure-fixtures/speech-1s.wav \
S2T_LOAD_CONCURRENCY=100 \
S2T_LOAD_DURATION_SECONDS=1800 \
S2T_LOAD_INTERVAL_MS=1000 \
node scripts/benchmarks/gateway-load-test.cjs > capacity-100.json
```

tokens.json 為 JSON 字串陣列，至少每路一個不同 token，須屬於不同帳號；不可提交 token。舊 S2T_LOAD_TOKEN 仍可用於單帳號診斷，不是 100 帳號驗收。

腳本使用固定到達節奏，均匀錯開使用者，ASR 成功後用其文字發起翻譯；不因前一請求變慢而降低 offered 流量。S2T_LOAD_MAX_INFLIGHT 預設路數 ×4，超限記錄 dropped，整體結果失敗；保留錯誤、timeout、status、P50／P95／P99 與排程延遲。translation attempts 只包含 ASR 成功的鏈路，gatewayChain errors 包含 ASR 失敗。測試完成會等待進行中請求，因此牆鐘時間可能長於發送時間。

一秒音訊／一秒間隔只是起始模型；另外使用真实快／正常／慢切段與實際語音、不同內容、模型／翻譯策略及同步突發。腳本重複 fixture 不代表真實準確率或完整模型負載分布。

gatewayChain 包含到達排程、ASR、翻譯，未包含麥克風、VAD 與瀏覽器繪製。正式 P95 ≤2.5 秒需另使用瀏覽器來源時間戳量測到字幕／翻譯顯示；不可用 Gateway 時間替代。記錄失敗與無結果，不僅統計成功請求。

同步收集 /metrics、event loop／CPU throttling、memory、DB 連線與鎖等待、Redis、MinIO／Milvus、模型排隊／GPU；評估最老工作等待和持續增長的佇列。100 路正常及擴容期間 P95 ≤2.5 秒、非預期錯誤／逾時 <1%、無已 ACK 音訊遺失或跨帳號混用。150 路另報結果，不預設保證。

另測 scale up/down、rolling update、kill Pod、依賴中断／恢復。結果保留映像／模型版本、CPU／GPU、Deployment／HPA、來源音訊與完整統計，才提出最低／建議 Pod 與資源。Mock 測試不作正式容量證據。
