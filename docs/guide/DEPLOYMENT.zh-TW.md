# 部署、備份與還原

## 本機測試

本機有兩種測試模式：不啟動外部服務的 local fallback，以及使用 Docker Compose
驗證 MinIO、PostgreSQL 與 Milvus。`npm run storage:smoke` 只驗證 fallback，不代表
Docker 服務已連線。

1. 複製 `.env.example` 為 `.env`。若要測試 fallback，將三組 Storage 變數全部留空；
   若要測試 Docker，依下方「本機 Docker Compose 整合測試」設定 `.env.local-storage`。
2. 執行 `npm run build:web`，再以 `npm run web:serve` 啟動同時提供 UI 與 API 的本機 gateway；預設為 `http://127.0.0.1:8787`。
3. 需要桌面版時執行 `npm run dev` 啟動 Electron。它會先建置再以 preview 啟動，沒有 renderer HMR。
4. 以 `admin`／`admin` 登入。正式部署前必須在第一次啟動前設定 `S2T_BOOTSTRAP_ADMIN_USERNAME`、`S2T_BOOTSTRAP_ADMIN_PASSWORD` 與長且隨機的 `S2T_AUTH_SECRET`；之後更改 bootstrap 密碼不會覆蓋既有帳號。
5. 使用 fallback 時，執行 `npm run storage:smoke` 驗證本機 blob、config、vector 的
   隔離與 CRUD。

本機 fallback 使用 `S2T_LOCAL_DATA_DIR`，預設為專案下的 `.s2t-data`。它包含設定、文字紀錄、音檔 blob、向量資料與本機登入資料；請以作業系統帳號權限保護此目錄。

## Kubernetes 的 `S2T_AUTH_SECRET`

Kubernetes 部署**必須**設定 `S2T_AUTH_SECRET`，且所有 gateway Pod 必須使用同一個值。程式在 `S2T_KUBERNETES_MODE=true` 時若缺少此值，會讓 readiness 失敗，避免不同 Pod 使用不同的 JWT 簽章與模型憑證加密密鑰。

本機開發未設定時，gateway 會在 `S2T_LOCAL_DATA_DIR/auth-secret` 自動產生並保存一把私有密鑰；這個便利行為不適用於多 Pod、Pod 重建或正式環境。

請以 Kubernetes Secret 保存長且隨機的值，例如：

```bash
kubectl create secret generic s2t-auth \
  --from-literal=S2T_AUTH_SECRET="$(openssl rand -base64 48)"
```

再由 Deployment 注入所有 gateway container：

```yaml
env:
  - name: S2T_KUBERNETES_MODE
    value: "true"
  - name: S2T_AUTH_SECRET
    valueFrom:
      secretKeyRef:
        name: s2t-auth
        key: S2T_AUTH_SECRET
```

不要在每個 Pod 啟動時生成新值，也不要把此值寫進 ConfigMap、image、Git repository 或前端 `VITE_*` 變數。輪替密鑰會使既有登入 token 與已加密的帳號模型 API key 失效，應安排重新登入與模型憑證更新。

### 重新部署後保留自訂模型

自訂模型清單與加密 API key 存在帳號的 config storage；重新部署必須沿用相同的 config 資料與 `S2T_AUTH_SECRET`。Docker Compose 的 `gateway-data:/data` 包含預設本機資料與自動產生的密鑰，請保留該 volume；遠端 config 使用原本的 PostgreSQL 資料庫。不要在重新部署時重建 Secret 或改用新的資料目錄。若舊密鑰已遺失，現有 API key 無法解密，需恢復原密鑰或由使用者重新保存 API key，不能靠重加模型清單復原。

模型燈號是檢查結果：綠色代表模型清單確認或本機 runtime 就緒；黃色代表服務可達但模型／檢查能力尚未確認；紅色代表認證、連線或 runtime 明確失敗；灰色代表尚未檢查／缺設定或此次檢查無法取得結果。OpenAI 相容服務不支援 `/models` 的 404／405 顯示黃色，不直接推論為不能使用。燈號不會禁止使用模型，也不代表推論品質已驗收。

## Linux x64 離線 sherpa 模型

若公司環境無法讓 gateway 下載 sherpa-onnx 講者分離模型，可使用已發布的 Linux x64 模型 image。它是模型傳遞媒介，不會啟動 gateway：

```bash
docker pull joeyliang1024/s2t-sherpa-models:1.13.8
docker create --name s2t-sherpa-models joeyliang1024/s2t-sherpa-models:1.13.8 /bin/sh
mkdir -p ./models
docker cp s2t-sherpa-models:/models/sherpa-onnx ./models/sherpa-onnx
docker rm s2t-sherpa-models
export S2T_MODELS_DIR="$(pwd)/models"
```

標籤 `1.13.8` 與 `latest` 都是 `linux/amd64`。先以固定版本部署；驗收或升級完成後才更新標籤。模型路徑與講者分離 API 設定請見 [sherpa-onnx 操作文件](SHERPA_ONNX.zh-TW.md)。

## 本機 Docker Compose 整合測試

Web 版驗證可使用本機 Docker Compose 的 MinIO、PostgreSQL 與 Milvus，不需要等待外
部服務。預設啟動 MinIO 與 PostgreSQL；Milvus 使用 `milvus` profile，會連同 etcd
一起啟動，只有進行聲紋／向量驗證時才需要啟用。

1. 先確認 Docker daemon 已啟動，再複製 `.env.local-storage.example` 為
   `.env.local-storage`，替換 MinIO、PostgreSQL 與 Milvus 的本機 credentials。
2. 啟動 MinIO 與 PostgreSQL：

   ```bash
   docker-compose --env-file .env.local-storage -f docker-compose.local-storage.yml up -d
   ```

   本 Compose 使用 `cgr.dev/chainguard/minio:latest`、`postgres:16-alpine`；服務只
   綁定 localhost。MinIO credentials 也會傳給 Milvus，避免 Milvus 使用預設帳密連線
   失敗。

3. 需要驗證 Milvus 時，先在 `.env.local-storage` 成套填入 `S2T_MILVUS_ENDPOINT=127.0.0.1:19530`、`S2T_MILVUS_DB_NAME=default`、`S2T_MILVUS_COLLECTION=s2t_voiceprints` 與 `S2T_MILVUS_TOKEN=local-milvus-token`（若服務啟用認證，改用實際 token），再啟用 profile：

   ```bash
   docker-compose --env-file .env.local-storage -f docker-compose.local-storage.yml --profile milvus up -d
   ```

   啟用後可用 `docker-compose --env-file .env.local-storage -f docker-compose.local-storage.yml --profile milvus ps` 確認四個服務；Milvus gRPC 位於 `127.0.0.1:19530`，HTTP 位於 `127.0.0.1:9091`。

4. 在另一個終端載入同一份環境變數後建置 Web UI 並啟動 gateway：

   ```bash
   set -a; source .env.local-storage; set +a
   npm run build:web
   npm run web:serve
   ```

5. 完成上一步 Milvus profile 與四項設定後，先執行 `npm run storage:remote:smoke` 驗證 MinIO、PostgreSQL 與 Milvus 的實際
   adapter CRUD、兩個獨立程序的 PostgreSQL CAS 與 Milvus 向量查詢；它會建立隨機測試資料並在結束時刪除。
   gateway 啟動後再執行 `npm run storage:compensation:smoke`，驗證未提交 session 的音檔補償、已提交音檔保留與聲紋補償清理。
   `npm run storage:outage:smoke` 會暫停本機 Compose 的 MinIO 與 Milvus，再驗證音檔／聲紋補償保留與服務恢復後重試成功；不可對共享／正式服務執行。
   再啟動 gateway，以 Web 版登入兩個帳號驗證音檔、設定及聲紋資料隔離。
   `storage:smoke` 仍是 fallback 測試，不要用它代替 Docker remote storage 連線驗證。

   其他相關 smoke：

   - `npm run storage:gateway:smoke`：用暫存 PostgreSQL 資料庫真的啟動一次 gateway，驗證 schema migration 與 auth bootstrap 不會互相競爭（舊版會讓 `/readyz` 回 503，並讓第一個 API 要求直接 crash）。建議在外部模式啟動前執行。
   - `npm run storage:grace:smoke`：純本機、不需外部服務，回歸驗證「上傳後尚未提交的音檔不會被無關的 session 儲存刪除」。提交寬限期由 `S2T_STORAGE_COMPENSATION_GRACE_MS` 控制（預設 30 秒），過期後才會被補償佇列清除。
   - `npm run storage:voiceprint-backup:smoke`：驗證聲紋快照包含 PostgreSQL metadata 與 Milvus embedding，刪除後可還原兩者。

   gateway 啟動後可用 `curl http://127.0.0.1:8787/api/storage` 檢查。fallback 會回傳三個 `local` adapter；外部模式回傳 `minio`、`postgres`、`milvus` 與 `002-account-deletion`。瀏覽器重新整理後，設定頁的 Remote Storage 也會顯示實際 adapter 與 schema version。結束後執行：

    ```bash
    docker-compose --env-file .env.local-storage -f docker-compose.local-storage.yml \
       --profile milvus down
    ```

    加上 `-v` 才會刪除 MinIO、PostgreSQL、etcd 與 Milvus 的本機測試資料。

資源上限：MinIO 512 MB／0.5 CPU、PostgreSQL 384 MB／0.5 CPU、etcd 256 MB／0.25 CPU、Milvus 1.2 GB／1 CPU。資料卷沒有設定自動清除；啟動前請保留足夠的 Docker 磁碟空間，長音檔測試後應手動清理不再需要的資料卷。

## 遠端 Storage

每一個服務可個別啟用。某一組變數全部留空時，該服務會使用本機 fallback；不可只填同組中的一部分。

| 資料 | 服務 | 必填環境變數 |
| --- | --- | --- |
| 音檔 blob | MinIO | `S2T_MINIO_ENDPOINT`、`S2T_MINIO_BUCKET`、`S2T_MINIO_ACCESS_KEY`、`S2T_MINIO_SECRET_KEY` |
| 文字與設定 | PostgreSQL | `S2T_POSTGRES_HOST`、`S2T_POSTGRES_PORT`、`S2T_POSTGRES_DB_NAME`、`S2T_POSTGRES_USER`、`S2T_POSTGRES_PASSWORD` |
| 聲紋 embedding | Milvus | `S2T_MILVUS_ENDPOINT`、`S2T_MILVUS_DB_NAME`、`S2T_MILVUS_COLLECTION`、`S2T_MILVUS_TOKEN` |

Web 端所有 Storage 存取都經過 gateway 的登入驗證。Electron 可設定預設保存位置為本機或遠端，載入時會合併兩端資料。

## 從本機 fallback 遷移

先停止使用本機資料目錄的 gateway，再執行 `npm run storage:migrate:remote` 盤點資料。
命令預設不寫入，會列出帳號、設定、術語、blob、向量與聲紋 metadata 的數量及衝突。只會遷移
可由本機 `auth:account-*` 對應的 user scope；匿名或無帳號的設定、blob scope、孤立向量與聲紋
metadata 會列在 `unowned` 並跳過，避免資料被自動歸給錯誤帳號。確認輸出後，使用
`npm run storage:migrate:remote -- --apply` 寫入外部服務。遷移保留既有外部資料；同一個 key 的
內容不同會回報衝突並以狀態碼 2 結束，不會覆蓋。需要指定另一個舊資料目錄時，設定
`S2T_MIGRATION_SOURCE_DIR`。已有相同 username、NT、Department 的外部帳號但 ID 不同時，僅在
確認要沿用外部帳號後使用 `--adopt-matching-users`。

若已人工確認一個 `unowned` scope 的歸屬，設定 `S2T_MIGRATION_SCOPE_MAP_JSON` 為 JSON object，例如
`{"48dc33ab-d96e-474c-826a-028fe510304d":"外部 user ID"}` 後重跑盤點。工具會先確認每個目標
user ID 存在才遷移；沒有 mapping 時仍維持跳過，不會猜測帳號。

每次 `--apply` 在來源資料夾寫入僅限目前使用者讀取的 `migration-last-run.json`，記錄階段、完成／失敗狀態與盤點摘要。中斷後重跑時會標示前次未完成；遷移採保守新增與衝突保留，因此應先檢視 dry-run，再重跑同一命令恢復未完成的 copy。

## 備份

- **本機模式**：在 gateway 停止後備份整個 `S2T_LOCAL_DATA_DIR`。還原時以備份目錄覆蓋目標目錄，再啟動 gateway。
- **MinIO**：使用 bucket versioning 與物件備份工具備份指定 bucket；保留使用者 scope 的完整 key hierarchy。
- **PostgreSQL**：使用 `pg_dump` 備份資料庫，並定期執行還原演練。
- **Milvus**：依部署版本使用官方 backup 工具或 collection export；向量備份必須和 PostgreSQL 的聲紋 metadata 同一時間點保存。

可用 `npm run storage:voiceprint-backup:smoke` 在本機 Docker 服務演練聲紋 metadata 與 embedding 的快照、刪除、還原及失敗補償。它會建立並移除隨機測試帳號與 collection，不可取代正式環境的全資料庫備份。

## Web 常見問題

- **登入出現 HTTP 404**：確認已先執行 `npm run build:web`，再啟動 `npm run web:serve`，並開啟 `http://127.0.0.1:8787/`。
- **顯示 `Origin is not allowed`**：同源 Web UI 不需額外設定。若由其他網域反向代理或獨立前端呼叫 API，將完整 origin 加入 `.env` 的 `S2T_WEB_ORIGINS`（多個值以逗號分隔），再重啟 gateway。

## 還原檢查

還原後請登入兩個不同帳號，確認：各自的設定與紀錄可讀取、音檔可播放、聲紋查詢可用，且任一帳號都不能讀取另一帳號資料。

### 帳號設定與環境模型的優先順序

登入或重新載入時，先讀取帳號設定，再套用環境模型與帳號模型目錄。環境 ASR 與翻譯模型作為預設選擇；使用者新增的模型仍保留，之後可手動切換。即使模型名稱相同，帳號模型的 endpoint 與設定也不會被環境模型覆寫。摘要與講者分離使用已配置的環境服務，帳號模型目錄後續載入不會覆蓋環境服務，也不會將環境服務寫回去取代原有的帳號模型。沒有可用環境模型時，沿用帳號設定。Storage、模型檔案位置等伺服器設定依環境變數處理。只有紀錄內容以 Storage 保存的資料為準，不以環境設定取代紀錄。

可執行 `npm run settings:environment:smoke` 驗證預設選擇、帳號模型保留與載入優先順序。

本機講者分離模型會從共用 `models/` 根目錄偵測：Sherpa 需要 segmentation 與 embedding ONNX；Nemotron 需要 GGUF 與符合執行平台的 runtime。兩套模型都完整時，兩者都列在模型頁與「目前使用」選單。`S2T_DIARIZATION_MODEL` 只決定啟動預設，選單切換的模型會傳給即時預覽、完整音檔及背景工作。偵測清單不會預先對兩套模型同時執行推論。

## H100／H200 GPU worker

可透過環境變數選擇 CPU／CUDA；GPU image、Compose overlay、K8s worker 設定與硬體驗收限制見 [GPU 部署指南](GPU.zh-TW.md)。
