# S2T UI

目前預發行版：**0.2.0-rc.1**。[更新說明](docs/releases/0.2.0-rc.1.zh-TW.md)；發布目標為 feature branch，未表示已合併至 main。

繁體中文 | [English](README.en.md)

Web 即時語音辨識、翻譯、錄音與摘要。React 前端、Python 後端；正式環境由 Nginx 提供前端。

## 開發啟動

使用 Node.js 22+、Python 3.12。從專案根目錄執行：

```sh
python3.12 -m venv .venv
.venv/bin/pip install --require-hashes -r backend/requirements-audio.lock
.venv/bin/pip install -r backend/requirements-integration.txt
npm ci --ignore-scripts
cp -n frontend/.env.example frontend/.env
cp -n backend/.env.example backend/.env
npm run dev
```

既有環境檔請保留，不要以 example 覆蓋。後端初次啟動需在 `backend/.env` 設定管理員帳號／密碼，
或只在開發時明確使用 `S2T_ALLOW_DEFAULT_ADMIN=true`。音訊轉換需安裝 FFmpeg 或設定 `S2T_FFMPEG_PATH`。

- 前端：[http://127.0.0.1:5173](http://127.0.0.1:5173)，`frontend/.env` 的 `FRONTEND_PORT`。
- 後端：[http://127.0.0.1:8787](http://127.0.0.1:8787)，`backend/.env` 的 `BACKEND_PORT`。
- `npm run dev` 同時啟動兩端，任一端失敗會停止另一端；Ctrl+C 同時結束。
- 單獨啟動使用 `npm run dev:frontend`、`npm run dev:backend`。
- 瀏覽器透過前端 `/api` 代理使用後端；`S2T_DEV_API_URL` 只放前端環境檔，勿加入 API key。

## 目錄

```text
frontend/src/         React UI
frontend/shared/      前端型別契約與驗證器
backend/app/          Python API、音訊處理與背景工作
backend/resources/    內建提示詞與摘要範本
backend/tests/        Python 測試
backend/.env          後端私有設定與模型／儲存憑證（不提交）
frontend/.env         前端開發 port 與代理位置（不提交）
data/                 本機帳號、設定、錄音與金鑰（不提交）
models/               模型權重與原生 runtime（不提交）
deploy/docker/        Dockerfiles
deploy/compose/       Compose 主設定、GPU 與儲存服務設定
deploy/k8s/           K8s：前端 1 Pod、後端 2 Pods
deploy/monitoring/   Prometheus／Grafana
```

Web 不再保留 Node Gateway 或 Electron runtime。舊資料格式相容性由 Python 測試驗證。

## Docker／Kubernetes

```sh
npm run docker:up
npm run docker:down
```

Compose 同時啟動前後端，對外 port 也從各自環境檔載入。
建置 registry 設定另放 `deploy/compose/.env`，依其 example 填寫。

K8s 的共享 PostgreSQL／MinIO／Redis 設定放 `backend/.env.k8s`，映像與叢集設定放
`deploy/k8s/.env`。先將映像推至叢集可存取的 registry 或載入本機叢集，再執行：

```sh
npm run k8s:up
```

此命令先跑資料庫 migration，再啟動 1 個前端與 2 個完整 Python 後端。
兩個後端均包含音訊程序池與 durable worker，透過共用儲存及 Redis 協調。
詳細步驟與限制見 [Web 部署指南](docs/guide/WEB_SPLIT.zh-TW.md)。

## 驗證

```sh
npm run check
npm run test:backend
npm run test:e2e
```

Playwright 優先使用 `S2T_BROWSER_EXECUTABLE`，其次是已安裝的 Playwright Chromium；
套件瀏覽器不存在時會自動尋找本機 Chrome／Edge／Chromium。都找不到時才要求安裝瀏覽器。
端到端測試使用暫存資料與測試帳號，不應對正式資料庫執行。

整理後結果與重現方式見 [結果索引](docs/reports/README.md)；原始實驗與中間輸出僅留本機、不納入 Git。

完整文件見 [文件入口](docs/README.md)，最新部署、相依稽核、計時與容量證據見 [2026-10-26 驗證報告](docs/reports/VALIDATION_2026-10-26.zh-TW.md)。

[錄音可靠性與慢上傳處理](docs/guide/RECORDING_RELIABILITY.zh-TW.md)。

## 授權

[PolyForm Noncommercial](LICENSE)。

登入與使用者管理統一使用 NT，見 [NT 登入](docs/guide/NT_LOGIN.zh-TW.md)。
