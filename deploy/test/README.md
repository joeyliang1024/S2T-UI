# 隔離多 Pod 測試部署

只操作 `colima-s2t-stress`／`s2t-stress-20261005`。`core.json` 是唯一 Storage／Gateway／worker 模板：Gateway 和 worker 各至少兩個 Pod；Redis 3＋Sentinel 3、PVC、經修正的認證 PING probes。`fixtures.json` 是 mock API 與負載 client；來源位於 scripts/testing。

先以 Dockerfile.web 建置 `s2t-stress:20261006-telemetry-backpressure`。映像需能由本機 Colima Docker runtime 取得，不能直接套用至其他 cluster。

```sh
python3 deploy/test/bootstrap.py
python3 deploy/monitoring/generate.py
python3 deploy/monitoring/install-test.py
```

bootstrap 先啟動 Storage、跑 migration，再啟動應用；已存在的 Secret／PVC 不輪替或清除。新環境生成的密碼只在 Secret，備份在 ignored `experiment/k8s/private/`。現有 load-client Pod 不重建，避免遺失 /tmp 測試帳號。已有帳號時重用其測試檔，首次初始化才註冊新帳號。

測試入口 test-ingress 的模板及重跑操作見 [目前實驗](../../experiment/k8s/README.md)。模型 API 只在 namespace 內 mock，不送真實外部 API；不同 Storage 不可以單純 scale 出多個共用 writer 當高可用。此模板仍只有一個 Colima node，沒有驗證跨 node／Storage 叢集故障。

舊實驗的 manifests／stack-final 快照已移除，避免重套舊 Redis 名稱、1 秒 liveness 或過期映像。Git 歷史保留原始版本。
