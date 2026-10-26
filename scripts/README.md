# 維護腳本

- `dev.cjs`：同時啟動 Web 前端與 Python 後端。
- `backend.cjs`：選擇 Python 虛擬環境並啟動／測試後端。
- `runtime.cjs`：後端環境檔與 Python 路徑；不將私有設定傳給 Vite。
- `compose.cjs`：統一 Compose project root 與環境檔。
- `k8s.cjs`：migration、前端 1 Pod／後端 2 Pods 部署。
- `forward.cjs`：從各自環境檔讀取 port，連接 K8s 前後端；`--monitoring` 加 Grafana／Prometheus。
- `analysis/`、`testing/`：目前 Web 原始碼與測試入口。
- `docs/`、`evaluation/`、`audio/`：文件及通用資料分析工具。

舊 Node Gateway、Electron 及直接依賴其模組的工具已移除。歷史壓測報告保留於 `experiment/`、`docs/reports/`。
