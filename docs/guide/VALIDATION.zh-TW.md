# Web／Python 驗收

繁體中文 | [English](../en/VALIDATION.md)

所有命令從 repository 根目錄執行，依 [README](../../README.md) 安裝前後端依賴。

## 自動檢查

```sh
npm run check
S2T_TEST_EMBEDDED_PG=1 npm run test:backend
npm run test:e2e
npm run test:dev
```

`check` 包含 TypeScript、架構邊界、前端單元測試與 Web build；不包含 Python、瀏覽器或部署測試。Python 測試使用根目錄 `.venv`；可用 `S2T_PYTHON_EXECUTABLE` 明確指定 Python。

Playwright 依序選擇 `S2T_BROWSER_EXECUTABLE`、已安裝的 Playwright Chromium、本機 Chrome／Edge／Chromium。缺少套件瀏覽器時會自動 fallback；所有選項皆不可用時才需安裝瀏覽器。共用實作為 `tests/helpers/browser.cjs`。

## 實際部署驗收

先在 localhost 隔離環境啟動部署與 port-forward，再執行：

```sh
S2T_ALLOW_DEPLOYMENT_TESTS=true npm run test:deployment
S2T_ALLOW_DEPLOYMENT_TESTS=true npm run test:replicas
S2T_ALLOW_DEPLOYMENT_TESTS=true npm run test:monitoring
```

測試會建立及刪除專用帳號，涵蓋登入、設定 CAS、錄音 chunks、保存與移除、字幕／翻譯／摘要、聲紋、跨 Pod 讀寫與撤銷，以及 Grafana／Prometheus。不要對正式資料執行。

真人驗收應確認：麥克風權限、連續錄音、即時字幕與翻譯、停止與重載後播放、摘要串流、帳號隔離、登出，以及網路慢時的錄音保存。網站資料可能含未保存音訊，不可將清除網站資料當成修復步驟。

## 已驗證範圍

[2026-10-26 驗證報告](../reports/VALIDATION_2026-10-26.zh-TW.md) 記錄 1 前端／2 後端、跨 Pod 與計時核對結果。外部 ASR／翻譯／摘要使用 mock，只能證明串接；辨識品質、真實模型延遲與生產容量需要可用服務另測。GPU 未經實機驗證。最新測試數量、相依稽核與容量限制見 [2026-10-26 驗證報告](../reports/VALIDATION_2026-10-26.zh-TW.md)。
