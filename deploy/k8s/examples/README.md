# 可選部署範例

這些設定是先前的 API／audio 分層拓撲與 HPA 範例，未被目前 `kustomization.yaml` 或 `npm run k8s:up` 載入。
目前正式入口使用上層 `web.json` 的前端 1、完整 Python 後端 2；migration 由啟動腳本產生。
如另行採用分層拓撲，需自行設定對應映像、共享 Secret、音訊 token、模型 PVC 與監控，不能直接混用。
