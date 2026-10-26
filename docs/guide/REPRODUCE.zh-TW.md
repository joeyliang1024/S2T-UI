# 結果重現與驗收

所有命令從專案根目錄執行。先依 [快速啟動](../../README.md) 安裝 npm 與 Python 鎖定依賴、建立各服務的環境變數，使用隔離測試環境。正式服務前端 5173、後端 8787，由各自環境變數設定。

## 目前採用的字幕合併

正常收音維持 3000ms／250ms。只把顯示列遇句號的分行門檻從 24 放寬為 40 字；語音邊界、換人、群組凍結與原有長度限制保留。這是顯示規則調整，不需要下載模型重測 ASR。

```sh
node tests/smoke/caption-display-group-smoke-test.cjs
node tests/smoke/model-adapter-smoke-test.cjs
node tests/smoke/vad-smoke-test.cjs
npm run check
S2T_TEST_EMBEDDED_PG=1 npm run test:backend
```

驗收重點：24–39 字且有句號的相容片段接成一列；40 字、有明確語音邊界、換人、超時或超長時仍按原規則分行。測試不修改使用者既有錄音。

## 部署後串接與監控

依 [部署指南](DEPLOYMENT.zh-TW.md) 啟動測試用 K8s，確認前端 1 Pod、後端 2 Pods，並開啟本機轉送：

```sh
node scripts/forward.cjs --monitoring
```

在另一個終端執行：

```sh
S2T_ALLOW_DEPLOYMENT_TESTS=true npm run test:deployment
S2T_ALLOW_DEPLOYMENT_TESTS=true npm run test:replicas
S2T_ALLOW_DEPLOYMENT_TESTS=true npm run test:monitoring
```

需要測試環境的 bootstrap admin 設定。測試建立並清理自己的帳號。監控驗證依賴同一批 Pod 的最新瀏覽器基線，因此依序執行，不在中途更新部署。Playwright 優先指定 `S2T_BROWSER_EXECUTABLE`，其次使用已安裝 Chromium，再 fallback 至本機 Chrome／Edge／Chromium。

現有 500ms 模型 mock 的整合結果僅證明串接，不能證明真實模型準確率。模型推論、瀏覽器 paint、HTTP 往返與 Grafana 直方圖百分位數須分開報告。

## 500 人、600 秒容量

[正式結果](../reports/VALIDATION_2026-10-26.zh-TW.md)：每人每 3 秒一次通過；2 秒極限未通過；同步瀏覽器翻譯 P90 3.023 秒，低於 3 秒的目標未通過。這是獨立測試 NT、16kHz 虛擬 PCM、ASR 與翻譯各 500ms mock，不是 500 個實體瀏覽器或真實模型容量。歷史基線為後端 r23/r24，不把後續 UI 版本當成已重跑容量。

先在隔離環境準備 500 個不同測試 NT 的有效 JWT，存成 private JSON 字串陣列。帳號建立／登入 API 與清理方式見 [API](../en/API.md)；不要使用正式帳號或把 token 放入版本控制。環境須有至少 9.6GB 錄音產出及額外組裝、資料庫與映像空間。保留當次映像標籤、CPU／RAM、Pod 數、模型 mock 設定、鎖檔與產生的結果。

```sh
export S2T_ALLOW_DEPLOYMENT_TESTS=true
export S2T_LOAD_TOKENS_FILE=/absolute/private/test-user-tokens.json
export LOAD_POD=s2t-recording-reproduce
export LOAD_SECONDS=600
export LOAD_CADENCE_MS=3000
npm run test:load:k8s -- start
```

context／namespace 來自 `deploy/k8s/.env`，確認指向隔離測試叢集。產出完成後才能收集；用明確 context／namespace 的 `kubectl logs` 觀察，不以等待 600 秒本身當成完成。最終組裝／SHA256 回讀／刪除另有收尾時間。

```sh
S2T_LOAD_REPORT=/tmp/s2t-reproduced-load.json npm run test:load:k8s -- collect
npm run test:load:k8s -- cleanup
```

`cleanup` 只移除測試 Pod、ConfigMap、Secret；測試身份須另外透過 admin API 按本次 UUID／NT 清單刪除，移除 private JWT 檔並確認 session 失效。失敗或中斷也要清理本次 runner 與身份，不清除其他使用者資料。不要把 2 秒（工具預設值）誤當通過的 3 秒條件。

驗收必須同時確認：生產時間、目標與完成數、排程丟棄、原始 HTTP 錯誤／重試、每份錄音 SHA256 一致與清理完成。短測、重試後成功或延長時間補送不能代替完整通過。

## 可選：本地真實 ASR 參數比較

此為研究工具，非目前顯示合併的必要測試。Apple Silicon 可用隔離 Python 環境的 `mlx-whisper==0.4.3`、`numpy`、`imageio-ffmpeg==0.6.0`；不加入正式 requirements。模型為 `mlx-community/whisper-small-mlx`，歷史權重 SHA256：`55b6674c9b339702d486e2b1573839a66f8ec8f821ed2886993ef717a86b09f5`。從該 Hugging Face 模型下載 config 與 weights 到測試目錄，確認 hash；不同權重不冒充相同重現。

語料來源：`adi-gov-tw/Taiwan-Tongues-ASR-CE-dataset-zhtw`，下載 `test/test-000000.tar`，將其中平面 MP3／JSON 解到 `music/taiwan-tongues/clips/`。遵循資料集 TRAIL–TWM 授權，音訊不提交 Git；不要以未驗證路徑解開不可信 tar。工具從至少 10 字的候選中選取慢／中／快各 4 位不同說話者。

```sh
FFMPEG=/absolute/path/to/ffmpeg node scripts/evaluation/segmentation-sweep.cjs /tmp/s2t-asr-reproduce
/absolute/path/to/isolated/python scripts/evaluation/local-whisper-score.py /tmp/s2t-asr-reproduce \
  --model /absolute/path/to/whisper-small-mlx --ffmpeg /absolute/path/to/ffmpeg
```

輸出分段與逐段原始／清理後辨識結果。這是小型選參集，不是獨立驗收集；不代表正式 Breeze 準確率、瀏覽器延遲或 500 人容量。評分程序完成即退出、不開常駐服務。確認程序已結束後，只清理本次專用環境、權重、快取及產出，保留結果摘要即可。

## 保留與忽略規則

- 提交：整理後 Markdown 結果、重現指南、測試與評測腳本、正式鎖檔。
- 忽略：`experiment/`（根 README 除外）、`docs/reports/evidence/`、音訊／權重、private token、臨時環境與撤回的切段實驗。
- 原始結果放 `/tmp` 或上述忽略目錄。版本控制不含當時原始證據，重跑會產生新數字；最新漏洞檢查亦須重跑，不能沿用歷史「0 已知 CVE」。
