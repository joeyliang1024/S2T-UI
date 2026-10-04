# K8s 擴容與 Docker 相容實作驗證（2026-10-04）

從 origin/main 建立 feature/k8s-scale-docker-compatible。保留原 Docker all 模式，未設定 K8s 不新增 Redis 或外部 worker 必要依賴。

## 已實作

- Redis 跨副本滑動視窗限流、登入失敗計數與模型用途併發上限；命令逾時／無離線佇列，故障不回退本地。
- 分離工作重送與重新處理、30 秒續租、續租失敗拒絕提交；本地檔案原子提交與 PostgreSQL 鎖／交易提交。
- HTTP ASR／翻譯冪等結果與內容衝突檢查、帳號隔離及過期清理。
- 音訊分段序號／sample／雜湊、durable ACK、進度、停止核對與串流組裝、後端轉存／完成備份清理；Web 分散式錄音接入現有有界 PCM writer。
- 音訊保存／下載串流化，長上傳租約保護，Storage audit 保護錄音備份。
- 可選內部 audio-service 與 API 轉送，Docker 仍同容器處理；HTTP／背景工作 SIGTERM 排空。
- migration Job／verify 模式、連線池配置、暖機開關、工作量指標、Kustomize／HPA／Adapter 範例。
- 固定到達率負載腳本，支援獨立 token、多於 100 路、掉落／錯誤／逾時與鏈路統計。

## 驗證結果

| 檢查 | 結果 |
| --- | --- |
| npm run typecheck、npm run build | 通過 |
| scale:smoke | 通過：本地原子提交、舊租約、去重、chunk 亂序／重疊／缺口、失敗不 ACK |
| scale:integration（專用 PostgreSQL 16、Redis 7） | 通過：競爭 claim／commit、重送、等待鎖時租約到期、共享配額／登入／容量、協調中斷 |
| scale:integration（另加專用 MinIO） | 通過：跨 adapter ACK、串流 WAV 組裝／下載與備份清理 |
| gateway-scale-http-smoke-test | 通過：兩 Gateway、chunk 接續、HTTP 去重、內部服務認證／Buffer RPC、音訊轉存、慢上傳、audit、SIGTERM 排空 |
| gateway-load-model-smoke-test | 通過：150 路固定到達節奏，過載記 dropped；僅 mock |
| gateway:auth-smoke、storage:smoke、storage:gateway:smoke | 通過 |
| caption:gateway:smoke、caption:regression、model-adapter:smoke、opfs:smoke | 通過；字幕測試使用隔離模型／虛擬時間 |
| import-audio:smoke | 通過：18 格式、上限、併發、取消／清理 |
| storage:grace:smoke | 通過 |
| storage:compensation:smoke | 在專用 Gateway／本地 Storage 通過；首次預設連到既有 Gateway 而讀寫不同 Storage，該次結果不採用 |
| Dockerfile.web 實際建置 | 通過：測試使用 npm 公開 registry；未重新驗證公司 Nexus／離線網路環境 |
| Docker 直接啟動及重啟 | 通過：不注入 K8s／Redis 設定，all/local、UI、登入、串流音訊、紀錄與密鑰持久化 |
| kubectl kustomize deploy/k8s | 通過；沒有套用到任何 K8s cluster |

測試容器與資料為專用暫存資源，完成後清理。原本工作目錄的未追蹤 Nemotron／Docker 檔案不納入提交。

## 未完成的正式驗收

未進行正式 K8s 上的 100 帳號 30 分鐘、150 路餘裕、GPU／模型推論容量、Redis 真正 failover、Pod kill／rolling／擴縮與瀏覽器完整延遲驗收。不得宣稱正式 100 人 P95 ≤2.5 秒已達標。HPA／資源／全域併發門檻需要依實際硬體與模型校正；模型部署沿用既有自架 API，範例不替代其部署設定。

Native Nemotron 仍按工作載入模型。未完成 ACK 的尾段依賴 OPFS 恢復，跨裝置自動發現錄音 ID UI 尚未提供。Redis 配額／容量在失去狀態後可能重置；可靠任務擁有權仍在 PostgreSQL。

操作與可重現流程見 ../guide/K8S_SCALE_DEPLOYMENT.zh-TW.md、../guide/CAPACITY_TEST.zh-TW.md。
