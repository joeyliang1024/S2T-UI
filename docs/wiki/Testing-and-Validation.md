# 測試與驗收規範

以下分類以重構後 `feat/bug-fix` 的 `package.json`／`tests/suites.json` 為準。main 的舊版本可能尚無這些入口；先確認 branch，不要自行猜測不存在的 script。

| 指令 | 範圍與前提 |
| --- | --- |
| `npm run typecheck` | TypeScript 型別 |
| `npm run check:architecture` | runtime cycle、依賴方向、無法解析的 import |
| `npm test` | unit；不需真實模型或外部服務，部分案例會開本機 mock HTTP |
| `npm run test:http` | 隔離 tmp storage 與 loopback HTTP |
| `npm run test:models` | 需本機權重、native runtime、ffmpeg |
| `npm run test:e2e` | Web bundle、Playwright 瀏覽器及測試前提 |
| `npm run test:external` | 隔離的外部服務環境；部分測試會清資料／停容器 |
| `npm run build:web` | Web 正式 bundle |
| `npm run check` | 現有完整檢查：型別、架構、unit、HTTP、Electron build、Web build |

Electron 開發暫停不代表現有 CI 被改成 Web-only；本次 Web 修改可選相關檢查，但 PR 必須區分實際跑過的內容與完整 CI 範圍。

## 準備與執行

```bash
# Linux CI 的核准 ffmpeg 準備方式，檔案存在於目前開發分支。
node scripts/testing/prepare-runtime.cjs
npm run typecheck
npm run check:architecture
npm test
npm run test:http
npm run build:web
npx playwright install chromium
npm run test:e2e
```

`npx playwright install` 會下載瀏覽器。測試可用 `S2T_BROWSER_EXECUTABLE` 指定已安裝瀏覽器，不要硬寫個人路徑。外部測試必須明確使用 `S2T_ALLOW_EXTERNAL_TESTS=true` 且指向可清除的隔離環境，不能使用正在服務的資料。

新增 smoke test 需登錄 `tests/suites.json` 的合適分類；不要用 glob 自動全跑所有腳本。測試直接執行 production service／UI，避免只驗證相同常數或字串。

## 依變更選驗證

文件修改核對路徑、連結、指令與範例即可；純規則改動跑該 domain 的直接測試；HTTP／權限／資料保存改動跑隔離 HTTP；UI 互動跑真實瀏覽器；模型 provider／權重／量化改動另做同素材的硬體與品質比較。

## 證據與完成定義

記錄 commit、日期、執行指令、環境／模型版本、結果與限制。測試次數不寫成永久能力指標。只有程式完成且適用檢查通過，才移除開發待辦；未做的真人／長時間／外部部署驗收仍保留在 [驗收手冊](https://github.com/joeyliang1024/S2T-UI/blob/feat/bug-fix/docs/guide/VALIDATION.zh-TW.md)。

HTTP 綠燈不等於模型推論品質；偵測到 GPU、載入 CUDA library 或占用顯存不等於已量得 GPU 加速。禁止以 mock／CPU 結果宣稱 H100／H200 驗收完成。

測試分類細節：[tests README](https://github.com/joeyliang1024/S2T-UI/blob/feat/bug-fix/tests/README.md)；CI 實際步驟：[CI workflow](https://github.com/joeyliang1024/S2T-UI/blob/feat/bug-fix/.github/workflows/ci.yml)。
