# Web 前端

React 原始碼位於 `src/`，契約／驗證器位於 `shared/`，公開靜態檔在 `public/`。
從專案根目錄執行 `npm run dev` 同時啟動前後端，或用 `npm run dev:frontend` 單獨啟動。
`FRONTEND_PORT` 從本目錄 `.env` 載入，預設 5173；代理後端預設為 8787。

`npm run build` 產出 `out/web/`。部署使用 `deploy/docker/frontend.Dockerfile` 的 Nginx。
Node 套件及 lockfile 位於 repository 根目錄。不要把模型、儲存或帳號金鑰放進前端環境檔。
