# 開發入門

依 [根目錄 README](https://github.com/joeyliang1024/S2T-UI/blob/codex/feature-python-backend/README.md) 安裝 Node 22+、Python 3.12、鎖定的 Python 音訊依賴與 npm 套件。首次從 `frontend/.env.example`、`backend/.env.example` 分別建立環境檔，保留既有憑證。

從專案根目錄執行 `npm run dev` 同時啟動兩端。瀏覽器開啟前端 5173；後端 8787 供 API 使用。port 由兩端的環境檔載入，修改後端 port 時同步調整 `S2T_DEV_API_URL`。

詳見 [環境設定](https://github.com/joeyliang1024/S2T-UI/blob/codex/feature-python-backend/docs/guide/ENVIRONMENT.zh-TW.md)、[測試與驗收](Testing-and-Validation.md)。
