# 第一批實作進度（2026-10-14）

Worktree：codex/technical-debt-refactor。以複製的未提交變更為基線；本批沒有修改原 checkout、stage、commit 或 push。

## 已完成

- 三方 session rebase：共同基線判斷兩端變更；刪除不復活，遠端不同筆編輯保留，同筆分歧以明確錯誤暫停。JSON key 順序不影響比較。
- Production save queue 保留連續 CAS 衝突中的最新編輯、離線 pending snapshot；遠端 ACK 基線與 UI snapshot 分開處理。
- OPFS recover 只讀，不刪来源；正常 stop 與啟動復原的 cleanup 都等待音訊可用且 metadata ACK，處理來源清理失败並保留待清理項。
- Draft cleanup 原子比對 expectedId，不刪新錄音的 draft；crash 後已有已提交 session 時不另建 recovery history item。
- Recovery harness 用 TypeScript AST 精確定位 handler，不再把其他宣告擷取進測試；同步更新 translation transport mock。仍屬過渡 harness，尚未以可直接 import 的 service 取代。
- 新增 session-sync:smoke 指令、三方合併測試與 production queue 連續衝突測試；擴充 OPFS 與 gateway draft 清理測試。

## 驗證

通過：typecheck、Electron/main/preload/renderer production build、session-rebase、session-storage-state、OPFS、session-recovery、session-recovery-handlers、recording-buffer-pressure、i18n 與 gateway-auth smoke tests。Gateway 使用隔離 tmp storage 與既有本機模型；未連接／清除正式 storage。

## 尚未完成

同筆衝突目前保留本機 pending 並暫停，尚未新增選擇 local/remote 的解決 UI；pending 編輯仍是記憶體狀態，不能宣稱 browser reload 後一定保留。來源清理失敗可在下一次保存再試，多份跨重啟 recovery manifest 仍需後續批次處理。

未修聲紋共享／Department 授權／revoke／bootstrap，也未拆平台 ports、domain workflows 或畫面目錄。未跑完整 browser/Electron E2E、遠端 storage/Kubernetes 或長時間壓力測試。

依整合修改計劃，下一批先補 durable pending/conflict resolution 與 recording cleanup coordinator，再抽正式 recovery handlers；功能與分層重構各自保持小範圍。
