# Web 部署：React／Nginx 與 Python

繁體中文 | [English](../en/DEPLOYMENT.md)

目前只有 Web 產品程式：前端 `frontend/`，後端 `backend/`。Node 只負責前端工具與測試，
不再有 Node Gateway、Electron 主程序或 IPC adapter。

## 環境變數與同時啟動

所有指令從 repository 根目錄執行。先依根目錄 README 安裝 Node 與 Python 3.12 依賴。

| 檔案 | 用途 |
| --- | --- |
| `frontend/.env` | `FRONTEND_PORT=5173`、`S2T_DEV_API_URL=http://127.0.0.1:8787`；不可放 API key |
| `backend/.env` | `BACKEND_PORT=8787`、模型端點、API key、認證及儲存設定 |
| `backend/.env.k8s` | K8s 專用共享 PostgreSQL、MinIO、Redis、AUTH_SECRET；不提交 |
| `deploy/compose/.env` | npm／PyPI build registry 設定 |
| `deploy/k8s/.env` | namespace、context、image tag、cluster DNS；依 `.env.example` |
| `deploy/monitoring/.env` | 可選的 Prometheus datasource URL |

```sh
npm run dev
```

同時啟動 Vite 與 Python。兩端 port 分別讀取上述環境檔；process 環境變數優先。
前端代理 `/api`，後端私有環境檔不會注入前端。
任一程序失敗會關閉另一個；Ctrl+C 同時停止。

`npm run dev:frontend`、`npm run dev:backend` 可單獨啟動。`npm run build` 產出 `out/web`。

## 資料與模型

- `data/`：本機設定、帳號、錄音、聲紋、`auth-secret` 及自訂 prompt／template。不提交且不放進映像。
- `backend/resources/`：隨程式版本管理的預設提示詞／摘要範本，首次啟動只補缺少的檔案。
- `models/`：Silero、Sherpa、Nemotron 權重與 runtime。掛載唯讀，不自動下載。
- 本工作區已將舊 `.s2t-data` 搬到 `data`；其他環境須停機後搬移或明確保留原 `S2T_DATA_DIR`。
- PostgreSQL 舊資料 schema、bcrypt/JWT 與加密模型憑證格式相容；migration 003 增加 Python 向量 fallback。

## Docker Compose

Dockerfile 集中於 `deploy/docker/`，Compose 集中於 `deploy/compose/`。

```sh
npm run docker:up
npm run docker:down
```

主 Compose 同時啟動 Nginx 前端與完整 Python 後端，port 都取自各自環境檔。
Python backend 使用 `deploy/docker/backend.Dockerfile --target audio`，包含常駐音訊程序與背景工作。
Nginx 透過 Docker DNS 代理 API，保留 Host 並停用串流 buffer；不自動重送 POST。
資料 bind mount 需允許容器 UID 10001 讀寫；權重唯讀掛載。

GPU 額外使用 `deploy/compose/gpu.yaml`；H100/H200 使用 `audio-cuda.Dockerfile`。
`storage.yaml` 是可選的本機儲存服務。Compose wrapper 固定使用 repository 作 project root，
手動呼叫 Compose 時也必須加 `--project-directory .`。

## Kubernetes：前端 1、後端 2

```sh
npm run k8s:up
npm run k8s:forward
# 同時連接 Grafana 與 Prometheus：
node scripts/forward.cjs --monitoring
```

部署入口會讀取各自 env，產生 Secret／ConfigMap，先跑 migration，再建立：

- `s2t-frontend`：1 Pod，Nginx，預設 5173。
- `s2t-backend`：2 Pods，Python API＋音訊程序池＋durable worker，預設 8787。

兩個後端使用共享 PostgreSQL／MinIO／Redis，沒有 sticky session 需求。
錄音 immutable chunks、sessions CAS、JWT 撤銷、工作 lease generation 與 account fencing 支援跨 Pod。
模型使用 `s2t-models` PVC；本機單節點叢集可以明確指定 `K8S_MODEL_HOST_PATH`。
`K8S_DNS_RESOLVER` 必須是實際 cluster DNS IP，Nginx upstream 使用 namespace 的完整 Service DNS。
API 每 Pod 預設 query pool 8、shared fence 2、exclusive fence 1；計算 PostgreSQL budget 時加上 migration／exporters。

映像需預先推至 registry 或載入本機 runtime。多節點環境必須每個節點可取得同一個 immutable image。
目前 active base 為 `web.json`；既有分層 API／audio workloads 與 HPA 範例保留供另案擴容，未套用至此次固定 1＋2 部署。

`npm run k8s:down` 只刪除應用 workload／Service，保留 Secret、PVC 與監控。
port-forward 在滾動更新選中的 Pod 結束後會自動重連；不是正式環境的 ingress。

## 量測與 Grafana

字幕 ASR：`speechEndAt → caption paint`；翻譯：`speechEndAt → translation paint`。
兩者都使用瀏覽器 `performance.now()`／sample clock，不以兩台主機 wall clock 相減。
Server-Timing 是毫秒，傳到 Prometheus 的 histogram 是秒；t1～t7 階段切片避免把同一個 HTTP RTT 再加一次。
看板的 P90 是 histogram 估計值，不是精確排序，也不是平均值。

Python Pod 直接提供 `/metrics`。Prometheus 必須逐 Pod scrape，不能只 scrape 負載平衡 Service。
主字幕看板的 datasource selector 使用 `job="s2t"`，對應 `app=s2t-backend`，不再使用舊 `gateway-web`。
無實際字幕樣本的區間應顯示無資料，不能用 0 代替延遲。

## 驗證與範圍

```sh
npm run check
S2T_TEST_EMBEDDED_PG=1 npm run test:backend
npm run test:e2e
S2T_ALLOW_DEPLOYMENT_TESTS=true node tests/integration/web-deployment.cjs
```

部署測試只允許 localhost 的隔離環境，會建立及刪除專用測試帳號。
測試期間使用既有 cluster 的 mock ASR／翻譯／摘要，驗證串接與計時，不能代表辨識準確率或真實模型容量。
本機權重的 Silero、Sherpa、FFmpeg／Nemotron 路徑另行驗證；GPU 需要實際 GPU 主機。
Playwright 缺少套件瀏覽器時會尋找本機 Chrome／Edge／Chromium，也可指定 `S2T_BROWSER_EXECUTABLE`。
