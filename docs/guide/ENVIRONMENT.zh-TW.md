# 環境設定

繁體中文 | [English](../en/ENVIRONMENT.md)

環境檔依責任分開，實際欄位以各目錄的 `.env.example` 與 Python 設定實作為準。命令從 repository 根目錄執行；既有私有檔案不要以 example 覆蓋。

| 檔案 | 設定內容 |
| --- | --- |
| `frontend/.env` | `FRONTEND_PORT=5173`、`S2T_DEV_API_URL=http://127.0.0.1:8787` |
| `backend/.env` | `BACKEND_PORT=8787`、模型、資料位置、認證與儲存憑證 |
| `backend/.env.k8s` | K8s 專用共享儲存與共用認證密鑰 |
| `deploy/compose/.env` | npm／PyPI 建置來源 |
| `deploy/k8s/.env` | namespace、context、映像與 cluster DNS |
| `deploy/monitoring/.env` | Prometheus 與 metrics 連線 |

程序環境變數優先。Python 明確載入 `backend/.env`；Vite 使用前端環境目錄。後端憑證不可放入前端或 `VITE_*`。根目錄不再使用一份共用 `.env`。

## 模型、資料與認證

`S2T_MODEL_DIR=./models`、`S2T_DATA_DIR=./data` 從專案根目錄啟動時使用這兩個目錄。內建提示詞與範本位於 `backend/resources/`，首次啟動只補缺檔案。

ASR、翻譯、摘要各有 `S2T_*_ENDPOINT`、`S2T_*_MODEL`、`S2T_*_API_KEY`。先設定可用模型再驗證實際辨識；mock 測試只證明串接。講者分離使用 Sherpa 或 Nemotron 本機權重時不需遠端 key，詳細選項見 example。

正式部署設定 `S2T_AUTH_SECRET`、`S2T_BOOTSTRAP_ADMIN_USERNAME`、`S2T_BOOTSTRAP_ADMIN_PASSWORD`（至少 12 字元）。所有後端共用且保留同一密鑰；輪替前須處理登入 token 與已加密模型憑證。

## 儲存與多 Pod

PostgreSQL、MinIO、Milvus 每組設定完整填寫或全部留空。本機模式與遠端模式不可在故障時靜默互換。固定 2 個後端使用共享 PostgreSQL／MinIO／Redis；Milvus 可選。

Redis 可用 `REDIS_URL`，或 Sentinel nodes 與 master name。現有相容欄位 `REDIS_PASSWARD`、`REDIS_SENTINEL_PASSWARD` 的拼字需依 example 使用。

參數調校見 [環境選項](ENVIRONMENT-OPTIONS.zh-TW.md)，部署流程見 [Web 分離指南](WEB_SPLIT.zh-TW.md)。

## Python 工作進程與連線預算

`S2T_WEB_WORKERS` 控制每 Pod 的 Uvicorn 進程數，開發預設 1，K8s 預設 2；後端維持 2 Pods。每個進程各有 SQL、模型 HTTP 與原生音訊工作池，總預算必須乘上 Pod 數與進程數。K8s 預設每進程主 SQL 池 8、帳號保護池最多 5、健康檢查保留池 1，因此 2 Pods × 2 進程最多 56 條應用 SQL 連線，還需為監控及維護保留空間。

`S2T_NOFILE` 預設 8192，啟動時提高開檔軟限制但不超過主機硬限制；不足時會記錄警告。多進程 Prometheus 使用服務啟動時建立的專屬暫存目錄合併計數與延遲，收音請求數相加、共用工作積壓在 Pod 內取最新值、跨 Pod 取最大值；每個進程的 CPU／RSS 帶 `pid` 標籤。不要讓不同 Pod 共用這個指標目錄。

`S2T_HTTP_ACTIVE_PER_WORKER` 預設 64，在登入驗證與 SQL 查詢前限制活躍 API 請求。等待數受 `S2T_HTTP_MAX_WAITING` 限制，最多等 10 秒；背景請求另有每進程 4 個活躍名額，健康檢查不排這條隊。這與 Uvicorn 的連線總上限不同。容量設定範例位於 `deploy/k8s/examples/backend-capacity.env.example`，不能只改單一池大小而忽略 Pod、進程及滾動更新時的總連線數。

短 ASR 音訊在已知 `Content-Length` 且不需正規化時，最多使用 256 KiB 的記憶體路徑，避免暫存檔、重讀及執行緒往返。實際讀取仍有大小上限；大檔、未知長度或正規化請求使用既有的有界檔案流程。這個暫存策略不取代正式錄音的 OPFS／MinIO 持久化。

已驗證容量設定為每 Pod 4 個進程、每進程 query 16＋shared fence 16＋exclusive fence 1＋health 1，共 34 條；兩 Pod 272 條、滾動至三 Pod 408 條，測試 PostgreSQL 上限 448。這是容量測試設定，不是 base 預設。每 Pod exporter 約每 15 秒更新指標快照，超過 45 秒回 503。ASR／翻譯使用有界 aiohttp pool；摘要串流保留 HTTPX。
