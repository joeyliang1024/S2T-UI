# Web 啟動與部署

繁體中文 | [English](../en/DEPLOYMENT.md)

現行產品為 React Web 前端與 Python 後端。完整設定見 [Web 分離指南](WEB_SPLIT.zh-TW.md)，首次安裝見 [README](../../README.md)。所有命令從專案根目錄執行。

## 本機開發

保留既有環境檔；首次建立才從 `frontend/.env.example`、`backend/.env.example` 複製。安裝 Node 22+、Python 3.12、根目錄 `.venv` 的鎖定依賴與 FFmpeg 後執行：

```sh
npm run dev
```

此命令同時啟動前後端，Ctrl+C 同時停止。前端從 `frontend/.env` 讀 `FRONTEND_PORT=5173`，後端從 `backend/.env` 讀 `BACKEND_PORT=8787`。前端透過 `/api` 代理，開發代理位置由 `S2T_DEV_API_URL` 指定。修改後端 port 時需同步修改代理 URL。

`npm run build` 輸出 `out/web`；`npm run preview` 僅供預覽建置結果。正式前端使用 Nginx。

## Docker Compose

```sh
npm run docker:up
npm run docker:down
```

主設定為 `deploy/compose/compose.yaml`，同時啟動 Nginx 與完整 Python 音訊後端。Dockerfile 位於 `deploy/docker/`，建置 registry 設定位於 `deploy/compose/.env`。手動操作 Compose 必須指定 `--project-directory .`，路徑相對於 repository 根目錄。

`data/` 掛載讀寫，容器 UID 10001 需有權限；`models/` 唯讀掛載。正式環境需設定固定且隨機的 `S2T_AUTH_SECRET` 與 bootstrap 管理員，不能使用開發預設帳號。可選的 `storage.yaml` 與 `gpu.yaml` 應依環境另行合併。

## Kubernetes 與保存資料

K8s 使用 1 個前端與 2 個完整後端，操作見 [Kubernetes 指南](K8S_SCALE_DEPLOYMENT.zh-TW.md)。多 Pod 共用 PostgreSQL、MinIO、Redis 與認證密鑰。

備份須包含 PostgreSQL、錄音物件、向量資料（若使用 Milvus）、私有環境設定與原認證密鑰；本機模式保存完整 `data/`。還原需保持帳號 ID 與物件對應，不可只重建帳號。`backend/resources/` 是內建預設，不能取代使用者資料備份。

舊 `.s2t-data` 應停機後搬移至 `data/`，或明確保留原 `S2T_DATA_DIR`。不要清除瀏覽器網站資料來處理錄音寫入慢，可能仍有尚未保存的錄音。
