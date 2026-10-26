# Web API 與代理邊界

繁體中文 | [English](../en/API.md)

現行 API 由 `backend/app/` 的 Python 應用提供；此檔保留原連結名稱，Node Gateway 已移除。

開發入口為 Vite（預設 5173），透過 `/api` 代理 Python（預設 8787）。正式入口為 Nginx，配置源是 `deploy/web/default.conf.template` 與 `deploy/k8s/default.conf.template`。

代理保留 Host，關閉串流 buffering，允許長時間音訊／摘要請求，不自動重送 POST。前端不得取得後端 API key。跨 origin 部署依 `S2T_WEB_ORIGINS` 設定，不以開放所有來源取代認證。

後端路由定義以 `backend/app/api.py` 與 `backend/app/routes/` 為準；認證、錄音與聲紋實作分別位於 `auth.py`、`recordings.py`、`voiceprints.py`。健康端點為 `/livez`、`/readyz`，Prometheus 入口為 `/metrics`。

兩個 Pod 共用認證密鑰、資料庫、物件儲存與 Redis。登入、錄音分塊及設定可跨 Pod，無須 sticky session；驗收見 [驗收手冊](../guide/VALIDATION.zh-TW.md)。

登入請求使用 `POST /api/auth/login` 與 `{"NT":"your.nt","password":"your-password"}`。註冊及管理員建立使用者填 NT、密碼與 Department，不需另填 Account。既有使用者的資料歸屬與密碼不變，見 [NT 登入](../guide/NT_LOGIN.zh-TW.md)。

## 字幕呈現

正常收音維持 3000ms／250ms。相容且未滿 40 字的含句號列可繼續接下一片段；明確邊界、已凍結群組及既有長度限制保留。顯示合併不改 ASR 請求、原始事件 ID 或保存資料；詳見 [回應速度](../guide/CAPTION_SPEED.zh-TW.md)。
