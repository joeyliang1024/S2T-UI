# 管理員與資料恢復

繁體中文 | [English](../en/DEPLOYMENT.md)

Admin 以帳號角色判定，名稱與 Department 不授予權限。管理頁可建立、刪除帳號；刪除目前登入帳號或最後一個可用 admin 會被拒絕。清理失敗時保留停用狀態與清理意圖，再由管理頁重試。

首次初始化在 `backend/.env` 或 K8s 對應設定提供 `S2T_BOOTSTRAP_ADMIN_USERNAME`、`S2T_BOOTSTRAP_ADMIN_PASSWORD`（至少 12 字元）與固定的 `S2T_AUTH_SECRET`。bootstrap 不是重設既有帳號密碼的工具，重啟不應被視為恢復已刪除帳號的方法。

## Schema 與備份

K8s 透過 `npm run k8s:up` 先執行 Python migration Job，成功後再 rollout。獨立 migration 入口為 `python -m backend.app.migrate`，必須在專案根目錄使用正確 Python 環境，並事先注入目標儲存連線與認證設定。不要使用已移除的 Node storage recovery script。

重建 schema 不會恢復帳號、錄音或設定。資料遺失時先還原 PostgreSQL 備份，保持原帳號 ID，再對應 MinIO／向量資料；不要將孤立物件分配給新帳號。保存原認證密鑰，避免已加密模型憑證無法解讀。

恢復後確認 `/readyz`、管理員登入、錄音播放及兩 Pod 存取。資料庫連線預算使用 `S2T_POSTGRES_POOL_MAX`、fence 連線與副本數計算，不能套用舊 Node 連線池參數。

詳見 [部署指南](DEPLOYMENT.zh-TW.md) 與 [K8s 指南](K8S_SCALE_DEPLOYMENT.zh-TW.md)。
