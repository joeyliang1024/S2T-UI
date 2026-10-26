# 開發規範

前端在 `frontend/src/`，共用前端契約在 `frontend/shared/`；後端業務在 `backend/app/`。Node 僅作建置與測試工具。避免重新引入 Electron IPC 或 Node Gateway。

前端不得讀後端私有環境檔；設定變更同步更新所屬 `.env.example` 與 guide。HTTP I/O 保持非同步，重型音訊使用常駐程序池，跨 Pod 狀態放共享儲存，不能依賴程序記憶體 session。

提交前依 [CONTRIBUTING](https://github.com/joeyliang1024/S2T-UI/blob/codex/feature-python-backend/CONTRIBUTING.md) 及 [驗收手冊](https://github.com/joeyliang1024/S2T-UI/blob/codex/feature-python-backend/docs/guide/VALIDATION.zh-TW.md) 執行符合變更範圍的檢查。範例、mock 結果與正式模型效能須分開描述。
