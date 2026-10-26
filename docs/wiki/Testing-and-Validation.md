# 測試與驗收

`npm run check` 執行前端型別、架構、單元測試與 Web build。另行執行 `npm run test:backend`、`npm run test:e2e`、`npm run test:dev`；Python 與部署測試不包含於 `check`。

Playwright 缺少內建瀏覽器時自動尋找本機 Chrome／Edge／Chromium，可用 `S2T_BROWSER_EXECUTABLE` 指定。

隔離部署測試需明確設定 `S2T_ALLOW_DEPLOYMENT_TESTS=true`，再執行 `test:deployment`、`test:replicas`、`test:monitoring`。測試會清理專用帳號。

完整步驟見 [驗收手冊](https://github.com/joeyliang1024/S2T-UI/blob/codex/feature-python-backend/docs/guide/VALIDATION.zh-TW.md)，目前證據見 [2026-10-26 結果](https://github.com/joeyliang1024/S2T-UI/blob/codex/feature-python-backend/docs/reports/VALIDATION_2026-10-26.zh-TW.md)。
