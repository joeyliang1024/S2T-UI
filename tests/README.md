# 測試

`npm test` 執行不需要模型或外部服務的本機測試；`npm run test:http` 使用隔離 tmp storage 與 loopback mock services。`npm run check` 包含 typecheck、architecture gate、本機測試、HTTP 測試與 build。

`npm run test:models` 需要本機模型／native runtimes／ffmpeg；`npm run test:e2e` 需要 Playwright Chromium，可先執行 `npx playwright install chromium`。若使用系統瀏覽器，設定 `S2T_BROWSER_EXECUTABLE`，不在程式裡硬寫個人路徑。

`tests/suites.json` 明確列出分類。不得把所有 smoke scripts 自動全跑。`test:external` 必須在隔離服務環境設定 `S2T_ALLOW_EXTERNAL_TESTS=true`；包含清資料／停止容器的測試，勿指向使用中的環境。壓力測試另以 `npm run recording:stress` 執行。

Node 22 與 Docker 相同。測試 runner 移除繼承的 S2T/Redis 設定；各測試使用自己的環境與 fixtures。

CI 使用 `npm ci --ignore-scripts` 後執行 `node scripts/testing/prepare-runtime.cjs`，從已納入版本控制且驗證 checksum 的 Linux ffmpeg artifact 準備 binary。其他平台可明確指定 `S2T_TEST_FFMPEG_SOURCE`；沒有默默從公網下載 binary。
