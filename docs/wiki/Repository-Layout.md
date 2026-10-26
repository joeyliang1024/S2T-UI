# 目錄規範

| 路徑 | 責任 |
| --- | --- |
| `frontend/src/` | React Web |
| `frontend/shared/` | 前端契約與驗證器 |
| `backend/app/` | Python API、音訊、儲存與工作 |
| `backend/resources/` | 隨版本發布的範本與提示詞 |
| `backend/tests/` | Python 測試 |
| `tests/` | 前端 smoke、瀏覽器及部署整合測試 |
| `data/` | 私有本機資料，不提交 |
| `models/` | 權重及原生 runtime，不提交 |
| `deploy/docker/` | Dockerfiles |
| `deploy/compose/` | Compose 設定 |
| `deploy/k8s/` | Active 1＋2 部署與獨立 examples |
| `deploy/monitoring/` | Prometheus／Grafana |
| `docs/`、`experiment/` | 文件與有日期的驗證證據 |

不再使用根目錄 `server/`、Electron `src/main`／`src/preload`。環境檔隨所屬元件放置，禁止把後端 key 加入前端。
