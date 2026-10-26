# Python 後端調校選項

繁體中文 | [English](../en/ENVIRONMENT.md)

以下為現行主要選項；完整可填欄位見 [backend/.env.example](../../backend/.env.example)。不要沿用已移除 Node Gateway 的 worker threads、Electron 或 `S2T_WEB_PORT` 設定。

| 變數 | 用途／注意事項 |
| --- | --- |
| `FRONTEND_PORT` | 前端環境檔，預設 5173 |
| `BACKEND_PORT` | 後端環境檔，預設 8787 |
| `S2T_DEV_API_URL` | Vite 代理的後端 URL，port 改動時同步調整 |
| `S2T_HTTP_MAX_CONCURRENCY` | Uvicorn 連線／任務總限制；example 1024，與每 worker 活躍 API gate 不同 |
| `S2T_HTTP_MAX_WAITING` | 等候上限；example 512，不代表可持續吞吐量 |
| `S2T_POSTGRES_POOL_MAX` | 一般查詢連線池；example 16，K8s 預設覆寫為 8 |
| `S2T_POSTGRES_FENCE_SESSIONS` | shared fence 連線；example 4，K8s 預設每工作程序 4，另需 exclusive fence 連線 |
| `S2T_AUDIO_LIGHT_WORKERS` | 常駐輕量音訊子程序數；example 1 |
| `S2T_AUDIO_HEAVY_WORKERS` | 常駐重型音訊子程序數；example 1 |
| `S2T_SHUTDOWN_GRACE_SECONDS` | 關閉排空等待；example 660 秒 |
| `S2T_PROCESS_ROLE` | 空值為 `all`；也支援 `api`、`audio-service`、`audio-worker` |
| `S2T_STORAGE_MIGRATIONS` | K8s migration Job 完成後使用 `verify` |
| `S2T_FFMPEG_PATH` | 可指定本機 FFmpeg 路徑 |
| `S2T_WEB_ORIGINS` | 允許的瀏覽器 origin，逗號分隔 |

K8s base 每 Pod 預設 2 個 Uvicorn 進程，兩個 `all` 後端；容量驗證設定為每 Pod 4 個。每個進程各有常駐音訊程序池，避免每次重新載入模型。增加 worker 必須同時量測 CPU、記憶體、模型常駐成本與排隊時間。

資料庫 budget 必須計入每 Pod 的查詢、shared fence、exclusive fence，健康檢查保留池每工作程序 1 條，以及 migration／exporter。提高 HTTP concurrency 不會自動提高模型或資料庫容量。先用 [驗收與容量測試](CAPACITY_TEST.zh-TW.md) 的實際工作負載量測，再調整。
