# 部署與維運

前端 Nginx 預設 5173，Python 後端預設 8787，port 由各自環境變數載入。`npm run docker:up` 同時啟動兩端；K8s 使用 `npm run k8s:up` 部署前端 1 Pod、完整後端 2 Pods。

操作見 [部署指南](https://github.com/joeyliang1024/S2T-UI/blob/codex/feature-python-backend/docs/guide/DEPLOYMENT.zh-TW.md)、[K8s 指南](https://github.com/joeyliang1024/S2T-UI/blob/codex/feature-python-backend/docs/guide/K8S_SCALE_DEPLOYMENT.zh-TW.md)、[環境設定](https://github.com/joeyliang1024/S2T-UI/blob/codex/feature-python-backend/docs/guide/ENVIRONMENT.zh-TW.md)、[監控](https://github.com/joeyliang1024/S2T-UI/blob/codex/feature-python-backend/docs/guide/OBSERVABILITY.zh-TW.md)、[資料恢復](https://github.com/joeyliang1024/S2T-UI/blob/codex/feature-python-backend/docs/guide/ADMIN_RECOVERY.zh-TW.md)。

保存共用認證密鑰、資料庫與物件儲存。模型連線失敗先檢查 DNS／TLS／權限與實際 endpoint，不以刪除帳號、瀏覽器網站資料或重建模型設定取代診斷。
