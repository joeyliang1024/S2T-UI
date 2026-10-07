# 隔離多 Pod 測試部署

只操作 `colima-s2t-stress`／`s2t-stress-20261005`。`core.json` 是唯一 Storage／Gateway／worker 模板：Gateway 和 worker 各至少兩個 Pod；Redis 3＋Sentinel 3、PVC、經修正的認證 PING probes。`fixtures.json` 是 mock API 與負載 client；來源位於 scripts/testing。

先以 Dockerfile.web 建置 `s2t-stress:20261008-admin-release`。映像需能由本機 Colima Docker runtime 取得，不能直接套用至其他 cluster。

```sh
python3 deploy/test/bootstrap.py
python3 deploy/monitoring/generate.py
python3 deploy/monitoring/install-test.py
```

bootstrap 先啟動 Storage、跑 migration，再啟動應用；已存在的 Secret／PVC 不輪替或清除。新環境生成的密碼只在 Secret，備份在 ignored `experiment/k8s/private/`。現有 load-client Pod 不重建，避免遺失 /tmp 測試帳號。已有帳號時重用其測試檔，首次初始化才註冊新帳號。

`ingress.json` 保存雙副本測試入口，bootstrap 會一併部署。啟動瀏覽器測試前執行 `kubectl --context colima-s2t-stress -n s2t-stress-20261005 port-forward svc/test-ingress 8790:8080 --address 127.0.0.1`。重跑操作見 [目前實驗](../../experiment/k8s/README.md)。模型 API 只在 namespace 內 mock，不送真實外部 API；不同 Storage 不可以單純 scale 出多個共用 writer 當高可用。此模板仍只有一個 Colima node，沒有驗證跨 node／Storage 叢集故障。

舊實驗中的 manifests／stack-final 是歷史快照，可能含舊 Redis 名稱、1 秒 liveness 或過期映像，請勿當作目前部署來源。目前模板集中於 deploy/test。

目前已驗證模板的 Kubernetes server dry-run 與既有叢集相容；尚未完成空白叢集的完整 bootstrap 驗證。

負載測試使用版本控管的 `scripts/testing/load-test.cjs`，預設經由 `http://test-ingress:8080`。從專案根目錄執行 `python3 experiment/k8s/current-2026-10-06/run-load.py <phase> <gateway-replicas>`；先準備 load-client 中的測試帳號。工具不覆寫既有帳號，會記錄實際目標並驗證每個必要 Deployment 至少兩個 Ready Pods。
