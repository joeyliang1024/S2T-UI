# 開發

繁體中文 | [English](CONTRIBUTING.en.md)

目前產品為 React Web 前端與 Python 後端，啟動及部署入口見 [README](README.md)。
前端位於 `frontend/`，後端位於 `backend/`，部署設定集中在 `deploy/`。
不得將帳號、錄音、權重、真實 API key 或私有 `.env` 提交到 Git 或放入前端映像。

變更前端後執行 `npm run check`。變更後端後使用 Python 3.12 執行 `npm run test:backend`。
更動跨端 API 或登入流程時執行 `npm run test:e2e`。實際 PostgreSQL 測試需安裝
`backend/requirements-integration.txt` 並設定 `S2T_TEST_EMBEDDED_PG=1`；模型測試需掛載權重。

本機啟動 port 由 `frontend/.env` 與 `backend/.env` 分別載入，請勿另加硬編碼 port 或根目錄私有環境檔。
Web 前端不使用 Electron IPC 或直接呼叫模型服務，所有私有憑證與儲存權限由 Python API 管理。
