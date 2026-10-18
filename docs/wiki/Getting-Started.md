# 開發入門

先確認 checkout 與工作目錄，不要覆蓋他人的未提交修改：

```bash
git status --short
git branch --show-current
node --version
npm --version
```

CI 使用 Node 22。本文對應 `feat/bug-fix` 重構後的指令；其他分支請先查看該分支 `package.json`。

## 安裝與 Web 啟動

```bash
npm ci --ignore-scripts --no-audit --no-fund
cp .env.example .env
npm run build:web
npm run web:serve
```

已有 `.env` 時不要執行覆蓋複製。依 [環境設定](https://github.com/joeyliang1024/S2T-UI/blob/feat/bug-fix/docs/guide/ENVIRONMENT.zh-TW.md) 設定儲存、模型與 bootstrap 管理員。`--ignore-scripts` 不會準備所有 native binary；需要音訊轉碼／本機模型時，再依 [部署指南](https://github.com/joeyliang1024/S2T-UI/blob/feat/bug-fix/docs/guide/DEPLOYMENT.zh-TW.md) 與測試指南準備對應平台 runtime。

開啟 `http://localhost:8787`；Web UI 與 API 由同一 gateway 提供，不再另外啟動 4173／5173 的正式 Web 入口。修改 renderer 後重新執行 `build:web`；server／環境設定變更需重新啟動服務。

外部模型與本機模型依設定選用；沒準備模型不等於可以做模型品質驗收。自訂 API key 不放進 renderer 或 `VITE_*`。

## 開始一項修改

1. 先讀 [目錄規範](Repository-Layout)，確認責任所在 feature／service。
2. 檢查 [剩餘開發與規格](https://github.com/joeyliang1024/S2T-UI/blob/feat/bug-fix/docs/Enhancement.md) 與相關 reference，判斷是 bug、開發缺口或尚未決定規格。
3. 使用明確範圍的 branch／worktree；新增分支預設 `codex/<簡短主題>`，如團隊已有指定分支則沿用。worktree 不會自動帶入原 checkout 的未提交修改。
4. 完成實作、相關文件與必要驗證；PR 描述寫清觸發條件、前後差異、證據與限制。

此處不要求為單純文件修字重跑整套模型；驗證選擇見 [測試與驗收](Testing-and-Validation)。
