# 應用映像

從 repository 根目錄建置，context 使用 `.`：

- `frontend.Dockerfile`：建置 React，最終由 Nginx 執行，`FRONTEND_PORT` 預設 5173。
- `backend.Dockerfile`：Python 3.12。完整後端使用 `--target audio`，含 FFmpeg／本機音訊依賴；`api` target 是精簡分層用途。`BACKEND_PORT` 預設 8787。
- `audio-cuda.Dockerfile`：可選 H100／H200 路徑，尚未經 GPU 實機驗收。
- `nemotron.Dockerfile`：可選獨立原生 CLI 打包。

私有環境檔與資料不進映像。詳細步驟見 [映像建置指南](../../docs/guide/DOCKERHUB.zh-TW.md)。
