# 部署、備份與還原

## 本機測試

1. 複製 `.env.example` 為 `.env`，保留 Storage 相關變數空白。
2. 執行 `npm run web:serve` 啟動本機 gateway；預設為 `http://127.0.0.1:8787`。
3. 執行 `npm run dev` 啟動 Electron，或以 Web 開發伺服器連線。
4. 以 `admin`／`admin` 登入。正式部署前必須修改 `S2T_BOOTSTRAP_ADMIN_PASSWORD` 與 `S2T_AUTH_SECRET`。
5. 執行 `npm run storage:smoke` 驗證本機 blob、config、vector 的隔離與 CRUD。

本機 fallback 使用 `S2T_LOCAL_DATA_DIR`，預設為專案下的 `.s2t-data`。它包含設定、文字紀錄、音檔 blob、向量資料與本機登入資料；請以作業系統帳號權限保護此目錄。

## 遠端 Storage

每一個服務可個別啟用。某一組變數全部留空時，該服務會使用本機 fallback；不可只填同組中的一部分。

| 資料 | 服務 | 必填環境變數 |
| --- | --- | --- |
| 音檔 blob | MinIO | `S2T_MINIO_ENDPOINT`、`S2T_MINIO_BUCKET`、`S2T_MINIO_ACCESS_KEY`、`S2T_MINIO_SECRET_KEY` |
| 文字與設定 | PostgreSQL | `S2T_POSTGRES_HOST`、`S2T_POSTGRES_PORT`、`S2T_POSTGRES_DB_NAME`、`S2T_POSTGRES_USER`、`S2T_POSTGRES_PASSWORD` |
| 聲紋 embedding | Milvus | `S2T_MILVUS_ENDPOINT`、`S2T_MILVUS_DB_NAME`、`S2T_MILVUS_COLLECTION`、`S2T_MILVUS_TOKEN` |

Web 端所有 Storage 存取都經過 gateway 的登入驗證。Electron 可設定預設保存位置為本機或遠端，載入時會合併兩端資料。

## 備份

- **本機模式**：在 gateway 停止後備份整個 `S2T_LOCAL_DATA_DIR`。還原時以備份目錄覆蓋目標目錄，再啟動 gateway。
- **MinIO**：使用 bucket versioning 與物件備份工具備份指定 bucket；保留使用者 scope 的完整 key hierarchy。
- **PostgreSQL**：使用 `pg_dump` 備份資料庫，並定期執行還原演練。
- **Milvus**：依部署版本使用官方 backup 工具或 collection export；向量備份必須和 PostgreSQL 的聲紋 metadata 同一時間點保存。

## 還原檢查

還原後請登入兩個不同帳號，確認：各自的設定與紀錄可讀取、音檔可播放、聲紋查詢可用，且任一帳號都不能讀取另一帳號資料。
