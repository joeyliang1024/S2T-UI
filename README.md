# S2T-UI

以 Electron、TypeScript 與 Web gateway 建立的即時語音轉文字、雙語字幕、會議整理與錄音應用。支援 Web 與 Electron；Web 版透過 gateway 保護模型憑證與帳號隔離的 Storage。

- [統一需求與改善清單（唯一待辦來源）](Enhancement.md)
- [早期功能研究（歷史參考）](docs/PLAN.zh-TW.md)

- [語音處理技術參考與自有模型整合方案](docs/OPEN_SOURCE_BACKENDS.zh-TW.md)
- [自有模型接入契約](docs/MODEL_ADAPTER.md)
- [Web ASR Gateway](docs/WEB_GATEWAY.zh-TW.md)
- [部署與本機 Docker Compose 測試](docs/DEPLOYMENT.zh-TW.md)
- [驗收手冊](docs/VALIDATION.zh-TW.md)
- [sherpa-onnx 離線講者分離與模型安裝](docs/SHERPA_ONNX.zh-TW.md)

目前已有麥克風與系統音訊收音、PCM16 WAV、HTTP ASR、翻譯、登入、歷史紀錄、摘要、模型及聲紋管理等功能路徑；逐字稿支援 TXT／VTT／JSON／CSV。實作不等於上線驗收，具體缺口與三項急迫需求以 [Enhancement.md](Enhancement.md) 為準。

ASR／翻譯等模型由使用者提供並以環境變數或帳號模型列表設定。講者分離可選用本機 sherpa-onnx；Linux x64 環境可直接從 Docker Hub 取得離線模型包。

## 功能狀態

| 範圍 | 可用功能 | 尚待真人／正式環境驗收 |
| --- | --- | --- |
| 即時收音 | 麥克風／系統音訊、VAD 與字幕切段滑桿、即時與整句翻譯策略 | 斷句延遲、不同裝置與長時間收音品質 |
| 講者 | sherpa 分群、聲紋註冊／NT 比對、字幕講者手動編輯與 VTT 匯出 | 多人重疊、長會議與誤配率 |
| 資料 | 登入隔離、歷史、搜尋、排序、複製、摘要模板、術語與 MinIO／PostgreSQL／Milvus | 正式外部 HTTPS 部署與故障情境 |
| 介面 | 繁中、簡中、英文、日文、德文與深／淺／系統主題 | 全頁窄視窗、無障礙與視覺回歸 |

完整範圍、未完成項目與驗收條件以 [Enhancement.md](Enhancement.md) 為準。

## Web 版啟動

Web 版需要同時執行兩個本機程序：`web:serve` 是 gateway，負責登入、模型 key 與 Storage（預設 `8787`）；`web:preview` 是瀏覽器介面（固定 `5173`），並將 `/api` 轉送給 gateway。請從 [http://127.0.0.1:5173/](http://127.0.0.1:5173/) 開啟；`8787` 只提供 API，不是網頁頁面。

### 1. 安裝與設定

```bash
npm install
cp .env.example .env
```

編輯 `.env`，至少填入 ASR 的 `S2T_ASR_API_KEY`、`S2T_ASR_ENDPOINT`、
`S2T_ASR_MODEL`。模型 key 只由 gateway 讀取，不會傳入瀏覽器。

首次使用本機資料時，可使用預設登入帳號 `admin`／`admin`。正式環境務必在第一次啟動前設定 `S2T_BOOTSTRAP_ADMIN_USERNAME`、`S2T_BOOTSTRAP_ADMIN_PASSWORD` 與長且隨機的 `S2T_AUTH_SECRET`。

### 2. 選擇 Storage

**本機 fallback（最適合快速驗收）**：`.env.example` 內有外部 Storage 的示範值；請把每一組 `S2T_MINIO_*`、`S2T_POSTGRES_*`、`S2T_MILVUS_*` 全部清空，並保留 `S2T_LOCAL_DATA_DIR=.s2t-data`。每組服務只能「全部設定」或「全部留空」，部分設定會讓 gateway 拒絕啟動。

**外部 Storage**：請依下方「外部 Storage」章節啟動 Docker，並載入 `.env.local-storage`。此模式使用 MinIO 存音檔、PostgreSQL 存帳號／文字資料、Milvus 存聲紋向量。

### 3. 建置並啟動

在**終端 A**執行：

```bash
npm run build
npm run web:serve
```

在**終端 B**執行：

```bash
npm run web:preview
```

然後開啟 [http://127.0.0.1:5173/](http://127.0.0.1:5173/)。修改前端程式後，重新執行 `npm run build` 後再整理瀏覽器；修改 `server/` 或 `.env` 後，重新啟動 `npm run web:serve`。

可用下列指令確認 gateway 與 Storage：

```bash
curl http://127.0.0.1:5173/api/storage
```

fallback 會回傳三個 `local` adapter；外部模式會回傳 `minio`、`postgres`、`milvus` 與 `001-core-storage`。

開發驗證可依序執行：

```bash
npm run typecheck
npm run build
npm run gateway:auth-smoke
npm run import-checkpoint:smoke
```

`gateway:auth-smoke` 會啟動暫時的 localhost gateway，驗證登入隔離、撤銷、模型 registry 與加密 key 不會由讀取 API 洩漏。`import-checkpoint:smoke` 驗證大檔 WAV checkpoint 只在檔案、模型、語言與術語設定完全相同時接續。

### Linux x64 離線 sherpa 模型

公司網路無法由 gateway 下載聲紋模型時，可先在能存取 Docker Hub 的 Linux x64 主機取出模型，再放到 gateway 工作目錄。模型 image 僅用作離線交付，不包含 gateway 或應用程式：

```bash
docker pull joeyliang1024/s2t-sherpa-models:1.13.8
docker create --name s2t-sherpa-models joeyliang1024/s2t-sherpa-models:1.13.8 /bin/sh
mkdir -p ./models
docker cp s2t-sherpa-models:/models/sherpa-onnx ./models/sherpa-onnx
docker rm s2t-sherpa-models
export S2T_SHERPA_MODELS_DIR="$(pwd)/models/sherpa-onnx"
```

此 image 的目標平台為 `linux/amd64`。完整講者分離設定、模型檔結構與 API 請見 [sherpa-onnx 文件](docs/SHERPA_ONNX.zh-TW.md)。

### Web 常見問題

- **登入出現 HTTP 404**：確認瀏覽器網址是 `http://127.0.0.1:5173/`，且終端 A、B 都在執行。不要直接開 `8787`，也不要沿用先前 Vite 程序的 `4173`／`4174` 網址。
- **顯示 `Origin is not allowed`**：預設只允許 `http://127.0.0.1:5173` 與 `http://localhost:5173`。若從自訂網域或 port 開啟，將完整 origin 加入 `.env` 的 `S2T_WEB_ORIGINS`（多個值以逗號分隔），例如 `S2T_WEB_ORIGINS=http://127.0.0.1:5173,http://localhost:5173,http://localhost:4173`，再重啟 gateway。
- **`5173` 無法開啟或 port 已被占用**：停止舊的 `vite preview` 程序後重新執行 `npm run web:preview`。此專案固定使用 `5173`，避免 proxy origin 與 gateway 設定不一致。

## 外部 Storage（MinIO、PostgreSQL、Milvus）

本機驗收可用 Docker Compose 啟動三個服務。先複製範例，再以實際本機測試密碼更新 `.env.local-storage`：

```bash
cp .env.local-storage.example .env.local-storage
docker-compose --env-file .env.local-storage -f docker-compose.local-storage.yml --profile milvus up -d
npm run storage:remote:smoke
```

`storage:remote:smoke` 會實測 MinIO blob、兩個獨立程序的 PostgreSQL CAS 與 Milvus 向量搜尋，並在結束時清除隨機測試資料。通過後，先停止目前 gateway，再以相同外部環境啟動它：

```bash
set -a
source .env.local-storage
set +a
npm run web:serve
```

gateway 與外部服務都啟動後，可執行 `npm run storage:compensation:smoke`。它會建立臨時帳號，驗證未提交 session 的音檔可被「重試 Storage 補償」清除、已提交的音檔會保留，以及聲紋補償佇列可清空；結束時會刪除測試帳號與資料。

`npm run storage:voiceprint-backup:smoke` 會驗證聲紋快照包含 PostgreSQL metadata 與 Milvus embedding，並在刪除後還原兩者及帳號下可見的聲紋清單；測試使用隨機帳號與 collection，結束時清除資料。

若要驗證外部服務故障恢復，執行 `npm run storage:outage:smoke`。此測試會短暫停止本機 Docker 的 MinIO 與 Milvus，確認音檔／聲紋補償佇列保留，然後重新啟動服務並確認重試成功；請勿在使用中的共享環境執行。

瀏覽器重新整理後，設定頁的 Remote Storage 會顯示實際 adapter 與 schema version。容器停止指令如下；加上 `-v` 才會刪除測試資料卷：

```bash
docker-compose --env-file .env.local-storage -f docker-compose.local-storage.yml --profile milvus down
```

## 從 fallback 遷移到外部 Storage

先停止使用舊 `.s2t-data` 的 gateway，並確定 Docker 外部服務已啟動。遷移工具預設只盤點，不會寫入：

```bash
npm run storage:migrate:remote
```

確認輸出後才執行：

```bash
npm run storage:migrate:remote -- --apply
```

它只會搬移可由本機 `auth:account-*` 對應至帳號的設定、術語、音檔 blob、聲紋向量與 metadata。匿名／無帳號 scope 的資料會列在 `unowned` 並跳過，避免自動歸給錯誤使用者。確認某個舊 scope 的歸屬後，可明確設定 `S2T_MIGRATION_SCOPE_MAP_JSON` 為「舊 scope → 既有外部 user ID」的 JSON，例如 `{"old-scope":"external-user-id"}`；工具會先確認所有目標 user ID 存在，再採用這些 mapping。外部服務已有同 key 但內容不同時會列為衝突並保留原資料，不會覆蓋。若外部 gateway 已建立相同 username、NT、Department 但不同 user ID 的帳號，確認要沿用外部帳號密碼後，改用：

```bash
npm run storage:migrate:remote -- --apply --adopt-matching-users
```

這會把本機帳號資料改寫到既有外部帳號 ID 下，不會改動外部密碼。要遷移不同的本機資料目錄，設定 `S2T_MIGRATION_SOURCE_DIR`。

每次 `--apply` 都會在來源資料夾建立 `migration-last-run.json`（權限僅限目前使用者），記錄開始／完成／失敗與盤點結果。若程序中斷，下一次執行會標示前次未完成；由於遷移不覆蓋不同內容的既有資料，可在先檢視 dry-run 後安全重跑。

## Electron 開發

安裝依賴後執行 `npm run dev` 啟動桌面程式，使用 `npm run build` 產生 production bundle。首次啟動請允許麥克風權限。

自有模型整合入口在 `src/renderer/src/features/models/model-adapter.ts`。將 `NoopModelAdapter` 替換為符合 `ModelAdapter` 的適配器，即可接收每個 PCM 音訊分塊並回傳 partial／final 字幕事件。瀏覽器預覽會下載檔案；Electron 執行時則使用系統儲存對話框。

OpenAI 相容 Breeze ASR 可使用環境變數：複製 `.env.example` 為 `.env`，填入 `S2T_ASR_API_KEY`；endpoint 與模型預設值已附在範例中。`.env` 會被忽略，不應提交到 Git。停止收音只會建立尚未保存的記錄，請在「記錄」頁按「保存工作階段」才選擇正式資料夾。
