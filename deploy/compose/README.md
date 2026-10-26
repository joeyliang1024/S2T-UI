# Docker Compose

從專案根目錄執行 `npm run docker:up` 同時啟動前後端，`npm run docker:down` 停止。

`compose.yaml` 為主設定；前端與後端分別讀 `frontend/.env`、`backend/.env`，預設 port 為 5173／8787。此目錄 `.env` 只放建置 registry 設定，依 `.env.example` 建立。

`storage.yaml` 是可選儲存服務，`gpu.yaml` 是可選 GPU overlay。手動 Compose 命令需以 repository 為 project directory，例如 `docker compose --project-directory . -f deploy/compose/compose.yaml config`。

保留 `data/` 與 `models/`，前者須容器 UID 10001 可寫，後者唯讀。詳見 [部署指南](../../docs/guide/DEPLOYMENT.zh-TW.md)。
