# S2T UI 驗收手冊

本手冊區分可自動驗證的建置結果、已驗證的 ASR API 路徑，以及必須由真人在目標裝置操作的功能。請不要把 API 回傳成功當成麥克風、權限或系統音訊已驗收。

## 已完成的基線驗證

| 項目 | 結果 | 證據／指令 |
| --- | --- | --- |
| TypeScript 型別 | 通過 | `npm run typecheck` |
| Production bundle | 通過 | `npm run build` |
| Diff 格式 | 通過 | `git diff --check` |
| 本機儲存與帳號隔離 | 通過 | `npm run storage:smoke` |
| 音訊重取樣 | 通過 | `npm run resample:smoke`（48k→16k、44.1k→16k、原率直通、分塊一致性與停止時尾段 flush） |
| 術語 JSON 解析 | 通過 | `npm run glossary:smoke`（物件／陣列、無效內容、重複與空資料） |
| 免 key ASR adapter | 通過 | `npm run model-adapter:smoke`（免 key 模型不查 key；需 key 模型會被阻擋） |
| 翻譯排程策略 | 通過 | `npm run translation-policy:smoke`（HTTP final 合併、逐句上限與失敗不自動重送） |
| 摘要分段規劃 | 通過 | `npm run summary-plan:smoke`（完整重組、分層批次與內容簽章） |
| 摘要模板規則 | 通過 | `npm run summary-templates:smoke`（即時選取、預設格式與至少保留一個模板） |
| 五語系字典完整性 | 通過 | `npm run i18n:smoke`（所有已登錄 key 均有繁中、簡中、英文、日文、德文） |
| Gateway 授權與聲紋同意 | 通過 | `npm run gateway:auth-smoke`（本機 loopback，拒絕未授權與未同意的共享聲紋請求） |
| Breeze HTTP ASR | 通過 | 本機中文 WAV → `/v1/audio/transcriptions` → 非空白文字 |
| Web 模型載入 | 通過 | `GET /api/config` 回傳 `Breeze-ASR-25`；Web 下拉選單已選取該模型 |
| Web BFF 轉錄 | 通過 | Web → Vite `/api` proxy → BFF → ASR → 非空白文字 |

API key 僅存在忽略的 `.env`，不應寫入本文件、截圖、前端 bundle 或 Git。

## 啟動測試環境

```bash
# 終端機 A：Web BFF，持有 .env 的模型 key
npm run web:serve

# 終端機 B：Electron 與 Vite 開發伺服器
npm run dev
```

- Web：開啟 `http://127.0.0.1:5173/`，確認 ASR 模型是 `Breeze-ASR-25`。
- Electron：由 `npm run dev` 開啟的 S2T UI 視窗測試原生保存、safeStorage、浮動字幕與系統音訊。
- Production Web：先執行 `npm run build`，再以 `npm run web:serve` 開啟 `http://127.0.0.1:8787/`。

## P0：近即時字幕驗收

### Web 與 Electron 共用步驟

1. 在「即時轉錄」確認音源正確，ASR 模型已選取 `Breeze-ASR-25`。
2. 按「開始收音」，允許麥克風權限。
3. 以一般音量連續說 30 秒繁體中文，包含短停頓、人名、數字與一段中英混說。
4. 觀察彩色音量條，確認說話時立即變動，靜音時回到接近 `-60 dBFS`。
5. 確認字幕以連續段落出現，而不是每個字換行；HTTP 模式的結果是 final 字幕，沒有原生 partial 字元。
6. 按「結束收音」，確認最後不足一段的尾音仍會送至 ASR，再到「記錄」保存工作階段。

### 記錄表

| 測試日 | 平台 | 首段延遲 | 平均延遲 | 漏字／重複 | 尾段保留 | WAV 保存 | 結論 |
| --- | --- | ---: | ---: | --- | --- | --- | --- |
|  | Web / Electron |  |  |  | 是／否 | 是／否 |  |

## 音訊與 VAD 驗收

| 場景 | 預期結果 |
| --- | --- |
| 靜音 10 秒 | 音量條接近 -60 dBFS；不應持續產生空白 ASR 請求或字幕。 |
| 一般說話 | 音量條立即反映；約 0.8–1.5 秒分段送 ASR，連續結果合併為最長約 10 秒字幕段。 |
| 500 ms 內短停頓 | 不應過度切碎字幕。 |
| 500 ms 以上停頓 | VAD 可完成一段；後續語句應保留約 300 ms pre-roll。 |
| 鍵盤聲／背景噪音 | 不應單靠短雜訊不斷送出空白片段。 |
| 切換音源 | 音量條、WAV 與字幕都應跟隨新裝置；失敗時保留舊裝置或顯示錯誤。 |
| 48 kHz → 16 kHz ASR | 保存的 WAV 仍為 48 kHz；送至 ASR 的 `start.sampleRate` 為 16 kHz，字幕時間、清除字幕邊界與實際錄音時長一致。 |
| 44.1 kHz → 16 kHz ASR | 以不同裝置或測試音訊重複上列檢查；長時間收音不可在區塊交界出現累積時間漂移。 |
| Electron 即時講者預覽 | 開啟講者分離後，桌面版每次只送最近 45 秒的 PCM WAV；回傳講者時間需對應整段錄音的絕對時間，且不增加無界 PCM 記憶體。 |

## Electron 專屬驗收

| 項目 | 現況 | 驗收條件 |
| --- | --- | --- |
| PCM16 WAV 持續寫入 | 已實作 | 錄製、停止、保存後可播放 WAV；TXT/SRT/JSON 可下載。 |
| API key safeStorage | 已實作 | 在完整設定保存 key 後可收音；key 不顯示於設定檔。 |
| 浮動字幕 | 已實作 | 開啟後顯示最新字幕；關閉可回到主視窗。 |
| 系統音訊混入 | 已實作平台分流 | Windows 使用 Electron loopback；macOS 15+ 使用 system picker。若取消或無 audio track，麥克風 session 必須持續；實際 audio track 仍需逐平台驗收。 |
| 跨重啟 session | 已實作 | 在「記錄」按「開啟已保存工作階段」，選擇含 `session.json` 的資料夾後可播放或再次匯出 WAV。 |
| 強制關閉錄音復原 | 已實作 | 強制關閉後重開，復原 WAV 應出現在「記錄」；先播放確認，再保存或下載。 |

## Web 專屬驗收

| 項目 | 驗收條件 |
| --- | --- |
| 模型載入 | `Breeze-ASR-25` 自動出現在並選取於快速設定 ASR 下拉選單。 |
| 模型 key | 瀏覽器 DevTools、localStorage、Vite bundle 與 `/api/config` 均不能看到 key。 |
| BFF 限制 | `/api/transcriptions` 僅接受受允許 origin、每個分段最大 12 MB、每 IP 每分鐘最多 60 次。 |
| 保存 | Web 使用瀏覽器下載與 IndexedDB 後備，沒有 Electron 原生資料夾保存功能。 |
| 系統音訊 | 依瀏覽器的 tab/screen share 支援情況；不等同 Electron loopback。 |

## 批次 WAV 轉錄驗收

1. 在「匯入檔案」選擇超過 100 MB 的 PCM16 WAV。
2. 按「開始批次轉錄」，確認顯示 `第 N / M 段` 進度；每段為 45 秒，與下一段保留 1.5 秒重疊。
3. 完成後確認字幕時間軸連續、交界處沒有文字重複。
4. 重新測試並按「取消批次轉錄」；目前請求可完成，但不得繼續送出下一段，已完成內容不得被覆蓋。
5. MP3、M4A、影片等非 WAV 檔仍應在 100 MB 以下走單次請求；大檔需先轉為 PCM16 WAV。

## 尚不可簽核的項目

- Realtime WebSocket partial 字幕：等待自建 gateway 協定、認證與重連語義。
- 翻譯可靠性：今天 ASR 驗收不設定翻譯 endpoint；翻譯錯誤不得阻擋原文字幕。
- 60 分鐘穩定性、睡眠喚醒、低磁碟。
- 自動說話者分離、批次大檔、MP3/M4A、打包簽署與 Windows 實機。

未完成事項與驗收優先順序請見 [新版需求單](../新版需求單.md)；早期工程筆記見 [TODO](../TODO.md)，模型傳輸協定見 [MODEL_ADAPTER.md](MODEL_ADAPTER.md)。
