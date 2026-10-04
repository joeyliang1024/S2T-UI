# K8s 容量測試

這個測試不會自行推算或宣稱 Pod 數。請在與正式 ASR／翻譯服務同網段、可授權的測試帳號下，逐次執行 1、10、25、50、100 路，100 路至少持續 30 分鐘。

```sh
S2T_LOAD_BASE_URL=https://s2t.example.internal \
S2T_LOAD_TOKEN=... \
S2T_LOAD_WAV=/secure-fixtures/speech-1s.wav \
S2T_LOAD_CONCURRENCY=100 \
S2T_LOAD_DURATION_SECONDS=1800 \
S2T_LOAD_INTERVAL_MS=1000 \
node scripts/benchmarks/gateway-load-test.cjs | tee capacity-100.json
```

輸出包含 ASR 與翻譯各自的所有嘗試、成功、錯誤、timeout、P50/P95/P99。同步收集每個 Pod 的 `/metrics`、CPU throttling、memory peak、PostgreSQL 連線、Redis／MinIO／Milvus 指標；只有在來源音訊、模型版本、CPU/GPU、Deployment/HPA 與結果都保留後，才能據此提出 Pod 數與資源建議。
