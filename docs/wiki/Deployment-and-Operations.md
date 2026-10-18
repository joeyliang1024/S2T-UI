# 部署與維運入口

現行 Web 入口是同源 gateway `8787`。請依 repo guide 操作，不在 Wiki 複製整份環境變數表或遷移指令。

| 工作 | 權威文件 |
| --- | --- |
| Web／Docker、啟動與掛載 | [部署指南](https://github.com/joeyliang1024/S2T-UI/blob/feat/bug-fix/docs/guide/DEPLOYMENT.zh-TW.md) |
| 設定、模型與預設值 | [環境設定](https://github.com/joeyliang1024/S2T-UI/blob/feat/bug-fix/docs/guide/ENVIRONMENT.zh-TW.md) |
| Kubernetes／多副本／Storage | [Kubernetes 指南](https://github.com/joeyliang1024/S2T-UI/blob/feat/bug-fix/docs/guide/K8S_SCALE_DEPLOYMENT.zh-TW.md) |
| 監控、指標與延遲 | [監控指南](https://github.com/joeyliang1024/S2T-UI/blob/feat/bug-fix/docs/guide/OBSERVABILITY.zh-TW.md) |
| Admin／PostgreSQL 恢復 | [Admin 恢復](https://github.com/joeyliang1024/S2T-UI/blob/feat/bug-fix/docs/guide/ADMIN_RECOVERY.zh-TW.md) |
| 共享授權 | [共享授權](https://github.com/joeyliang1024/S2T-UI/blob/feat/bug-fix/docs/guide/SHARING_AUTHORIZATION.zh-TW.md) |
| sherpa 與 Silero 模型準備 | [sherpa 指南](https://github.com/joeyliang1024/S2T-UI/blob/feat/bug-fix/docs/guide/SHERPA_ONNX.zh-TW.md)、[Silero 指南](https://github.com/joeyliang1024/S2T-UI/blob/feat/bug-fix/docs/guide/SILERO_VAD.zh-TW.md) |
| 測試與正式環境驗收 | [驗收手冊](https://github.com/joeyliang1024/S2T-UI/blob/feat/bug-fix/docs/guide/VALIDATION.zh-TW.md) |

## 必須保留的資料與設定

blob、config、vector 各自配置；任一已設定的遠端服務故障不得靜默改存本機。正式部署先設定 bootstrap 管理員與固定的 `S2T_AUTH_SECRET`；所有 gateway Pod 共用，重部署沿用原值及原 config storage。變更密鑰會影響登入 token 與已加密模型 API key，不能當成普通重啟。

保留資料 volume／資料庫，避免把重建容器當成清除資料。刪除帳號、遷移、schema 修復與回收需先確認作用帳號、資料範圍、備份及失敗重試方式。不要把 recovery script 當健康檢查執行。

## 模型異常的調查順序

1. 確認目前帳號、模型用途、endpoint 與模型名稱。
2. 看健康檢查原因，分辨尚未確認、權限／key、連線／DNS／TLS、配額、模型清單或 runtime。
3. 重新部署後確認 storage 與 Secret 沿用；不要直接刪除重建模型來掩蓋根因。
4. 比對 server／worker 日誌及相同時間的 request；分享前移除金鑰、token 與個人資料。

健康狀態與 GPU／CPU backend 是不同概念，模型清單可達也不是完整推論驗收。健康提示 UI、GPU 單一模式開關等本機未合併修改，不因本 Wiki 說明而視為 main 已發布功能；發布後再把對應 guide 加入上表。
