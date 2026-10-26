# Python 後端

從 repository 根目錄執行 `npm run dev` 同時啟動前後端，或 `npm run dev:backend` 單獨啟動。
依賴安裝方式見根目錄 README，使用 Python 3.12；音訊依賴由 `requirements-audio.lock` 鎖定。

- `.env`：本機 port、模型服務與私有憑證。預設 `BACKEND_PORT=8787`。
- `.env.k8s`：K8s 的共享 PostgreSQL／MinIO／Redis 連線與共用認證密鑰。
- `app/`：API、音訊處理、durable jobs、儲存與量測。
- `resources/`：內建提示詞與摘要範本。
- `tests/`：Python 與實際 PostgreSQL／音訊測試。

應用資料在根目錄 `data/`，權重在 `models/`。不要將私有設定複製到前端或提交 Git。
