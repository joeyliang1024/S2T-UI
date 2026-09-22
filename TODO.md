# S2T UI 工程待辦與介面契約

本文件是後續開發的唯一待辦來源。目標是 Electron 桌面 S2T：錄製麥克風與選用的系統音訊、產生逐字稿與翻譯、保存可重開的工作階段。模型由團隊以 vLLM 或其他服務部署；本專案只負責安全保存設定、送出音訊、接收字幕與保存結果，不內嵌 Python、模型權重或推論服務。

## 今日交付目標：Breeze-ASR-25 近即時字幕

- [x] 以 `.env` 中的 endpoint、model、key 對實際服務送出本機生成的中文 WAV；得到非空白轉錄結果。金鑰未寫入程式、git 或文件。
- [ ] 在 Electron 選取「使用內建分段轉錄」的 Breeze-ASR-25 模型，說話時每段約 1 秒至 3 秒出現在字幕區。
- [ ] 驗收：說 30 秒中文，至少三段字幕依序出現；按「結束收音」時最後一段仍出現；完整 WAV 可在「記錄」頁保存。
- [ ] 今天不啟用翻譯：保持翻譯 endpoint/model 空白即可，ASR 字幕不得因翻譯未設定而延遲。

## 已定案的第一版

| 能力 | 做法 | 限制／前提 |
| --- | --- | --- |
| 接近即時字幕 | 將約 0.8–1.5 秒 PCM16 WAV 分段送 `POST /v1/audio/transcriptions`；每個 HTTP 回應是一筆 final 字幕。 | HTTP 請求不是持續輸入串流，沒有 partial 字元。 |
| 即時翻譯 | ASR final 到達後，以另一個 OpenAI 相容 `POST /v1/chat/completions` 翻譯同一段，更新 `translatedText`。 | 不對 partial 重複翻譯。 |
| 真正 partial 字幕 | 只在模型服務提供已驗證的 WebSocket／Realtime 規格後實作。 | 不假設 vLLM OpenAI 相容 HTTP 必定有 `/v1/realtime` 或 Chat Completions 音訊輸入。 |
| 模型設定 | 使用者輸入 endpoint、model name、API key；key 以 Electron `safeStorage` 保存。 | Vite 瀏覽器預覽不能安全保存或使用私密 API key。 |
| 保存 | Main process 連續寫入 PCM16 暫存 WAV，停止時回填 WAV header；於「記錄」頁手動選擇保存位置。 | 停止收音不直接跳出存檔。 |

## 已完成（回歸檢查項）

- [x] Electron 安全分層：Renderer 僅透過 `window.s2t`，API key 只在 Main process 讀取。檔案：`src/preload/index.ts`、`src/main/index.ts`。
- [x] 長時間 WAV 寫入：`recording:start/append/finish` 寫入 `.wav.part` 並回填 44-byte PCM16 WAV header。檔案：`src/main/index.ts`。
- [x] 麥克風與系統分享音訊混音，同時送入 analyser、WAV writer、模型 Adapter。檔案：`src/renderer/src/App.tsx`。
- [x] 音量表：AnaylserNode RMS 換算 `-60..0 dBFS` 彩色條，靜音起點 `-60 dBFS`。檔案：`src/renderer/src/App.tsx`、`src/renderer/src/App.css`。
- [x] OpenAI 相容 HTTP ASR Adapter，已把 WAV 分段、字幕時間戳和 final event 封裝於 `src/renderer/src/model-adapter.ts`。
- [x] ASR、翻譯、摘要模型設定與 API key 分離保存；Main process 會清理設定欄位再寫入 `models.json`。檔案：`src/main/index.ts`、`src/renderer/src/App.tsx`。
- [x] HTTP ASR 錯誤不再使後續佇列失效；最多排 4 段，超載會提示字幕缺口但保留完整 WAV。檔案：`src/renderer/src/model-adapter.ts`。
- [x] HTTP 分段顯示連續化：需累積 500 ms 靜音才以自然停頓切段；連續 HTTP final 合併成最多約 10 秒的一段字幕。檔案：`src/renderer/src/model-adapter.ts`、`src/renderer/src/App.tsx`。
- [x] app-side VAD：`src/renderer/src/vad.ts` 使用 RMS dBFS、動態 noise floor、120 ms voice onset、500 ms silence end 和 300 ms pre-roll；純靜音不送 HTTP ASR，但完整 WAV 照常保存。
- [x] 工作階段、TXT/SRT/JSON/WAV 匯出與浮動字幕窗。檔案：`src/main/index.ts`、`src/renderer/src/App.tsx`。

## P0：已知缺陷與修正項

- [x] **跨重啟後可讀取已保存音檔**
  - 問題：`src/main/index.ts` 的 `availableAudioPaths` 是記憶體 `Set`；Electron 重啟後，歷史頁不能經 IPC 讀取先前保存的 WAV。
  - 已修正：`session.json` 保存 schema version 和相對音檔名；「記錄」新增「開啟已保存工作階段」，以 `realpath` 驗證音檔在使用者選取的 session root 內，避免目錄跳脫。
  - 相關檔案：`src/main/index.ts`、`src/preload/index.ts`、`src/preload/index.d.ts`、`src/renderer/src/vite-env.d.ts`、`src/renderer/src/App.tsx`。
  - 驗收：重啟後可開啟 session、播放及重新匯出；不能讀到 session 資料夾外的任意檔案。

- [x] **未保存錄音在強制關閉後可復原**
  - 問題：完成但尚未「保存工作階段」的暫存 WAV 沒有永久 manifest。
  - 已修正：在 userData 建立 `recording-manifest.json`，記錄 active/finished 暫存 WAV 與 metadata；啟動時依實際檔案大小回填 WAV header，將可復原錄音加入「記錄」。保存工作階段後清除 manifest 項目。
  - 相關檔案：`src/main/index.ts`、`src/renderer/src/App.tsx`。
  - 驗收：收音中或停止後強制結束，重開仍可復原可播放 WAV，或可明確清理。

- [x] **以 AudioWorklet 取代 ScriptProcessorNode**
  - 問題：目前 `App.tsx` 用 `createScriptProcessor(4096)`；音訊 callback 同時 PCM 轉換、IPC、Adapter 佇列，長時間時可能造成 renderer 壓力。
  - 已修正：`src/renderer/src/audio-capture.worklet.js` 以 AudioWorklet 處理 128-sample frame；主執行緒只收 MessagePort frame 並處理寫檔／模型。保留 analyser 和系統音訊混音。
  - 驗收：收音、暫停、切換裝置、混音、音量表、字幕時間戳均正常；不在 Worklet 內做 React state 或網路請求。

- [x] **HTTP 音訊累積改為 chunk queue**
  - 已實作：`OpenAiChunkedModelAdapter` 用 `Float32Array[]` 與 sample 計數保存待送音訊，僅在 flush 成 WAV 時建立固定大小 array；避免每個 audio callback 複製全部 pending 音訊。
  - 待實機驗收：60 分鐘收音 renderer 記憶體不隨時間線性升高，字幕 start/end timestamp 仍正確。

- [x] **App-side VAD 基礎門檻可調整**
  - 現況：已新增 `src/renderer/src/vad.ts`，但尚未收集真實麥克風環境的 noise floor 與門檻資料。
  - 已修正：將 120 ms onset、500 ms silence、300 ms pre-roll 與 noise floor offset 放進設定並保存；停止時仍送出含語音的不足一段尾音。真人噪音環境參數仍需依驗收表校正。
  - 驗收：安靜、鍵盤聲、長停頓、快速對談中不送長靜音、不切句首、不過度斷句。

- [x] **依 faster-whisper 的 VAD 與 timestamps 原則完成第一版**
  - 參考：[faster-whisper README](https://github.com/SYSTRAN/faster-whisper#vad-filter) 提供 Silero VAD，並示範 `min_silence_duration_ms=500`；其 word timestamps 代表應讓模型／gateway 可選擇回傳更細時間資訊。
  - 已整合：`src/renderer/src/vad.ts` 以 500 ms silence 為可調起點；模型能力欄位明確標記 timestamp precision。Breeze HTTP 回應若只有文字，App 使用音訊切段邊界，不假裝是 word timestamps。
  - 驗收：設定可調整 min silence，匯出 JSON 明確標示 timestamp 的來源是 App chunk 邊界或模型回傳。

- [x] **依 sherpa-onnx 的 streaming/non-streaming 分層建立模型能力欄位**
  - 參考：[sherpa-onnx README](https://github.com/k2-fsa/sherpa-onnx) 明確分開 streaming ASR、non-streaming ASR、VAD、speaker diarization；同時展示 VAD + non-streaming ASR 的組合。
  - 已整合：設定檔加入 `asrMode: non-streaming | streaming`、`vadSource: app | server`、`timestampPrecision: chunk | segment | word`。Breeze-ASR-25 預設為 `non-streaming/app/chunk`；自建 WebSocket gateway 預設為 `streaming/server/segment`。
  - 相關檔案：`src/renderer/src/App.tsx` 的模型表單與 `src/main/index.ts` 的 `sanitizeModelConfig()`；正式 schema 寫到 `docs/MODEL_ADAPTER.md`。
  - 驗收：UI 顯示選擇的傳輸能力；對不支援 partial 的模型不顯示「原生即時 partial」承諾。

- [x] **HTTP 失敗與背壓缺口寫入逐字稿事件**
  - 問題：現況只在狀態列提示略過音訊，匯出檔無法辨認遺失區間。
  - 已修正：`TranscriptEvent` 加入 `gap`，包含 sequence-derived id、start/end timestamp、`queue-overflow` 或 `request-failed` 原因；請求採 250/750/1750 ms 退避後才寫 gap，JSON 匯出保留事件。
  - 相關檔案：`src/renderer/src/model-adapter.ts`、`src/renderer/src/App.tsx`、匯出函式。
  - 驗收：斷網後重連，後續字幕持續；JSONL 可識別未轉錄時間，不能把缺口偽裝成靜音。

- [x] **Electron 系統音訊流程與權限修正（平台能力分流）**
  - 現象：使用者勾選後，Electron 的系統分享視窗無法提供可混入的音軌，或 `getDisplayMedia()` 回傳的 stream 沒有 audio track。
  - 優先調查：macOS 的 Screen Recording／系統音訊權限、Electron 44 的 `session.setDisplayMediaRequestHandler()`、`DesktopCapturerSource` 選擇、`audio: 'loopback'` 是否為該平台支援的 handler 設定；不可只依 Renderer 的 `getDisplayMedia({ audio: true, video: true })` 假設有系統音訊。
  - 已修正：`src/main/index.ts` 放行 `display-capture` 並配置 `setDisplayMediaRequestHandler()`；Windows 使用 Electron `audio: 'loopback'`。macOS 15+ 改走系統 picker，較舊 macOS 不宣稱全系統 loopback 支援；若使用者取消或分享 stream 沒有 audio track，Renderer 持續麥克風收音而不終止整個 session。
  - 待實機驗收：Windows loopback WAV、macOS system picker／虛擬音訊裝置的實際音軌行為仍需依 [驗收手冊](docs/VALIDATION.zh-TW.md) 測試。

## P0：模型服務驗證（需 vLLM／模型端資料）

### 今日 P0：Web 即時字幕翻譯

- [x] **HY-MT1.5-1.8B 即時翻譯接入（Web gateway）**
  - 已知契約：使用 OpenAI 相容 `POST /v1/chat/completions`；Web gateway 的 endpoint、model、key 只讀 `.env` 的 `S2T_WEB_TRANSLATION_*`，不得進入 `VITE_*`、renderer、localStorage、文件或 Git。
  - 檔案：`server/index.cjs` 新增 `POST /api/translations`，固定模型端設定、只接受 ASR final text/目標語言/術語；`src/renderer/src/App.tsx` 在 Web 模式以此 BFF 呼叫，Electron 保持 Main process safeStorage 路徑。
  - 延遲策略：ASR final 到達後立即非阻塞翻譯同一 `TranscriptEvent.id`；250/750 ms 僅在暫時失敗時重試；不得等下一筆 ASR 或阻塞錄音、VAD、WAV 寫入。翻譯回來時 revision 更新同段，避免產生第二段字幕。
  - 已驗證：以實際 endpoint 發送「你好，這是一個即時字幕翻譯測試。」得到正確英文；經 `127.0.0.1:5173/api/translations` Vite proxy 再驗證，`/api/config` 也正確公布 `HY-MT1.5-1.8B` 的公開模型資訊，未包含 key。
  - 待真人驗收：Web 說 30 秒繁中，原文段落後出現英文譯文，譯文語意大致正確；ASR 仍可在翻譯服務超時時繼續。

- [x] **逐字稿 CSV 匯出**
  - 檔案：`src/renderer/src/App.tsx`。
  - schema：UTF-8 BOM CSV，欄位 `start_ms,end_ms,start_time,end_time,speaker,source_text,translated_text,status,gap_reason`；以 RFC 4180 雙引號逸出逗號、換行與引號。
  - 已實作：即時字幕匯出列與記錄頁都提供 CSV；會連同原文、譯文、講者、時間軸與缺口原因匯出。
  - 待真人驗收：含中文、英文、逗號、換行的原文與譯文能以 Numbers/Excel 開啟。

- [x] **修正 HY-MT 目標語言與字幕碎片化**
  - 翻譯：依 [Tencent HY-MT 官方 prompt](https://github.com/Tencent-Hunyuan/Hy-MT#prompts) 改為單一 user message；中文互譯使用「将以下文本翻译为{目標語言}…」，其他語言組合使用英文模板。實測繁中→日文回傳 `こんにちは、今日のご協力に感謝します。`，繁中→英文回傳正確英文。`server/index.cjs` 保留完整目標語言名稱而非只傳 `ja`/`en`。
  - 字幕：`OpenAiChunkedModelAdapter` 將 ASR chunk 範圍從 0.8–1.5 秒調整為 1.0–2.4 秒，仍優先遵從 VAD 的自然停頓；UI 不會因前一段已有譯文就停止合併。合併後會建立新 id 並重新翻譯完整句，防止舊短句翻譯覆蓋。
  - 參考：faster-whisper 的 VAD 說明以 500 ms 作為可調整的 silence duration 範例；目前維持該自然停頓基準，待真人錄音量測後再調整。
  - 待真人驗收：連續說 30 秒，首段延遲維持可接受範圍且字幕段落顯著少於原先 1.5 秒固定切段；長停頓仍要分句。

- [x] **UI 字幕段落以自然停頓封存**
  - 問題：HTTP ASR 為維持延遲而分段送出，若 UI 把每個回應當成新時間區間，連續說話會顯得破碎。
  - 已實作：`src/renderer/src/model-adapter.ts` 在每個 final event 帶入 `isSentenceBoundary`；只有 App-side VAD 看到自然停頓才設為 true。`App.tsx` 會持續將 speech 中的 HTTP 回應合併成同一個字幕列，更新文字與 end time；下一個 event 僅在前一列已有自然停頓、發生 ASR gap 或達 12 秒閱讀上限時才開新列。
  - 驗收：連續說話時同一列字幕持續延長；約 500 ms 停頓後下一句才有新的時間區間；模型請求頻率不變，因此不增加 ASR 首段延遲。

## P0：收音與字幕操作體驗

- [x] **模型分類色塊與篩選、雙音源音量表、錄音摘要**
  - 已實作：模型列表加入全部／ASR／翻譯／摘要／講者分離篩選，並依類別使用不同 block 底色。講者麥克風與系統音訊各自使用相同格式的 RMS dBFS 彩色跑條；系統未連接時明確顯示。
  - 摘要：錄音完成後，若 Electron 已設定摘要 Chat Completions endpoint、model、key，會在背景產生不超過 60 字的一句繁中摘要並顯示於記錄卡片。沒有設定摘要模型時只保存記錄，不使用翻譯模型冒充摘要。
  - UI：meter 改為可縮小的雙列 grid，窄螢幕時 capture panel 會依序堆疊 source、meters、timer；模型 endpoint 採 `overflow-wrap:anywhere`，避免畫出框外。

- [x] **收音期間的低頻率講者辨識 preview（Web 實驗）**
  - 現況：sherpa-onnx 的 `OfflineSpeakerDiarization` 要處理完整 PCM buffer，適合錄音完成後精準回填，沒有原生逐 frame speaker event。
  - 已實作：Web 版收音時每 15 秒在背景對目前 PCM WAV 呼叫 `/api/diarizations`，只回填已 final 的字幕。此 request 與 ASR、翻譯、WAV 寫入分離，失敗時不改變收音狀態。
  - 待改善：目前每輪分群的 `SPEAKER_nn` 仍可能重編號；需以 speaker embedding／重疊窗口對齊前次 label。Electron 要從暫存 WAV 讀 snapshot，不能讓 renderer 長時間保留全錄音副本。
  - 風險與驗收：CPU 高、短窗口分群不穩，必須可關閉；ASR/翻譯、WAV 寫入與音量表不能被阻塞。先以兩人交替中文測試，speaker label 僅為 provisional，停止後仍用完整 WAV 做最終識別。

- [ ] **分離麥克風與系統音訊的即時音量表**
  - 目的：混音後的總 dBFS 無法判斷是講者太小聲、系統音訊太小聲，或只有其中一個音源沒有接上；保留獨立音量表才有明確的使用者診斷價值。
  - 檔案：`src/renderer/src/App.tsx`、`src/renderer/src/styles.css`。
  - 實作：新增 `microphoneAnalyserRef` 與 `systemAnalyserRef`，各自接在 source node 後、混音 bus 前；各自以 `requestAnimationFrame` 讀 RMS、換算 `-60..0 dBFS`。既有混音 source 繼續送入 AudioWorklet、WAV writer 與 ASR，**不得**用顯示用 analyser 的值改變後端音訊資料。
  - UI：顯示「講者音量」與「系統音訊」兩條彩色表；沒有系統 track 時顯示「未連接」，不可偽裝為靜音。保留目前不帶白色游標的彩色填滿樣式。
  - 驗收：只講話時只有講者表移動；只播放系統聲時只有系統表移動；兩者同時輸入時兩條都移動，錄下的 WAV 與 ASR 仍是混音結果。

- [ ] **收音中途啟用／停用系統音訊**
  - 現況：`src/renderer/src/App.tsx` 的 checkbox 在 active capture 時被 disabled，只能在開始收音前選擇。
  - 實作：把 `getDisplayMedia()` 與 `AudioContext.createMediaStreamSource()` 抽成 `attachSystemAudio()`；收音期間打開時顯示原生分享選擇器，取得 audio track 後連到既有 mix bus 與獨立 system analyser。取消分享、沒有 audio track 或權限失敗時，繼續麥克風與字幕，不終止工作階段。關閉時只 disconnect／stop 系統 track，麥克風、計時、Worklet、WAV 寫入及 Adapter 佇列持續運作。
  - 平台限制：瀏覽器與 Electron 都必須由使用者每次在分享視窗明確授權音訊；macOS 是否提供全系統 loopback 仍取決於系統 picker／虛擬音訊裝置。不能繞過系統權限或在背景靜默開啟系統音訊。
  - 驗收：收音 10 秒後啟用系統音訊，再關閉；session 不重置、字幕 id/timestamp 單調遞增、WAV 前段只有麥克風／中段混音／後段只有麥克風。

- [ ] **字幕預設跟隨最新進度**
  - 檔案：`src/renderer/src/App.tsx`、`src/renderer/src/styles.css`。
  - 實作：以 transcript scroll container ref 判斷使用者是否在底部 48 px；預設 pinned，新增 final/partial 字幕後 `scrollTo({ top: scrollHeight, behavior: 'smooth' })`。使用者向上捲動後取消 pinned，不強制拉回閱讀位置；在底部顯示「回到最新字幕」按鈕與未讀段數，按下後重啟 pinned 並清零。
  - 驗收：持續收音時自動停在最新字幕；閱讀舊字幕時不跳動；按回到最新後恢復自動跟隨；搜尋／編輯字幕不造成焦點被捲走。

- [ ] **模型列表依使用類別分頁**
  - 檔案：`src/renderer/src/App.tsx`、`src/main/index.ts`、`src/preload/index.d.ts`、`TODO.md`。
  - 現況：模型列表把 ASR、翻譯與講者分離依序列出，但沒有使用類別切換；ASR profile 的 `kind` 是 HTTP/WebSocket 傳輸方式，不能當作模型用途。
  - 資料模型：保存 model registry item 的 `category: 'asr' | 'translation' | 'summary' | 'diarization'`、`name`、`endpoint`、`model`、`transport`、`capabilities`；API key 只維持 Electron safeStorage 參照，不存入 renderer config 或清單 UI。
  - UI：在「模型列表」內加入 `全部 / ASR / 翻譯 / 摘要 / 講者分離` 分頁，顯示各類數量、endpoint、model ID 與適用傳輸模式；使用者從完整設定新增或刪除模型後即時更新。舊版 `translationProfiles` 與現有單一 diarization 設定需在 `normalizeSettings()`／`sanitizeModelConfig()` 自動遷移，不遺失既有設定。
  - 驗收：每個類別只顯示對應模型；重新整理及 Electron 重啟後分類不變；API key 永不出現在 DOM、localStorage 或匯出資料。

- [ ] **真人語音端到端驗收目前 ASR endpoint**
  - 無需先改程式；測試結果記到新增的 `docs/VALIDATION.zh-TW.md`。
  - 設定：Electron「完整設定」填 `/v1/audio/transcriptions` endpoint、model、API key；不可把 key 寫入 git 或 `VITE_*`。
  - 測試：30 秒繁中，含停頓、人名、術語；確認最後不足最短長度的片段在停止時仍送出。
  - 紀錄：首段延遲、平均延遲、漏字、重複字、HTTP status、錯誤復原。
  - 現有證據：已對 Breeze-ASR-25 設定 endpoint 送出空白 WAV 並取得 HTTP 200；不代表真人語音品質已驗證。

- [ ] **固定 vLLM ASR 契約**
  - 模型端提供：實際成功 curl、vLLM 版本、完整 URL、認證方式、model name、接受格式、最大檔案、是否接受 `language`／`prompt`、最小回應 `{ "text": "..." }`、timeout/rate limit。
  - App 位置：若符合 `/v1/audio/transcriptions`，設定模型即可。若 URL 結構不同，調整 `src/main/index.ts` 的 `openAiBaseUrl()`／`model:transcribe`，並補測試。
  - 不採用的假設：`chat.completions.create({ stream: true })` 不能自動變 ASR；是否接受 `input_audio` 必須由該 vLLM 版本與模型文件和實測確認。

## P1：Realtime WebSocket（只有明確服務端規格後才開始）

### 候選架構評估：vLLM + Node.js／npm

下列內容來自目前提出的方向，已列為待驗證方案，**不可直接視為 vLLM 的通用 OpenAI 相容保證**。

| 方案 | App 端做法 | 優點 | 必須先驗證 | 決策 |
| --- | --- | --- | --- | --- |
| A. HTTP 滾動切片 | Renderer 擷取 PCM；`src/renderer/src/model-adapter.ts` 每 0.8–1.5 秒建立 WAV；Preload → Main 使用 `openai` SDK 呼叫 `/v1/audio/transcriptions`。 | 穩定、目前已有實作、API key 留在 Electron Main。 | vLLM/模型是否支援 audio transcriptions、WAV、`language`、`prompt`、回傳 `{text}`。 | **第一版採用**；完成 P0 真人語音驗證。 |
| B. Chat Completions 串流 | 將音訊 base64 放入 Chat Completions content，`stream: true` 將文字 delta 回 UI。 | 若服務確實支援多模態音訊內容，可得到回應文字串流。 | 該 vLLM 版本、所選模型、content schema 是否接受 `input_audio`；音訊格式、大小、延遲及輸出 event schema。 | **不實作，直到實測 curl/SDK 成功**。`stream: true` 只表示輸出可串流。 |
| C. Realtime WebSocket | 以持久 WebSocket 傳送 PCM16 / G.711 frame，接 partial/final transcript event。 | 能做到最低延遲、真正 partial 字幕。 | vLLM 是否真的提供 WebSocket endpoint、認證、input/output event、VAD、ACK、reconnect 契約。 | **不實作，直到服務端規格確定**。 |

- [ ] **驗證方案 A：vLLM OpenAI-compatible audio transcriptions**
  - 模型端提供一個可重現的 `curl -F file=@speech.wav -F model=...` 範例；確認回傳 text、延遲與錯誤格式。
  - 若成功，僅需在設定頁新增 endpoint、model、key；程式走既有 `OpenAiChunkedModelAdapter` 和 `model:transcribe`。

- [ ] **驗證方案 B：Chat Completions 是否支援音訊內容**
  - 使用模型端提供的官方 vLLM 版本文件與最小 request 實測，不使用猜測的 `input_audio` schema。
  - 成功條件：同一段 WAV 可以得到符合預期的 delta/final，並說明是否真能降低端到端延遲；失敗或不支援時維持方案 A。
  - 若成功且值得採用：在 `src/main/index.ts` 新增一個明確的 `model:transcribe-chat` IPC，不把它塞進既有 `model:complete`（後者只接受文字）；並在 `src/renderer/src/model-adapter.ts` 新增獨立 Adapter，保留 HTTP ASR fallback。

- [ ] **驗證方案 C：vLLM Realtime WebSocket**
  - 模型端提供端點、認證和完整事件 sample。特別確認是否為 `ws(s)://host/v1/realtime`，不可由示例自行假設。
  - 若服務端事件採 `input_audio_buffer.append` / transcript delta，將其正式 schema 寫入 `docs/MODEL_ADAPTER.md`；Renderer 只傳 sample frames，API key 由 Main proxy 或短期 token 處理。
  - 成功條件：連續說話時 2 秒內能收到 partial，停頓後有 final；服務重連和 2 MB 背壓不造成無提示缺字。

- [ ] **取得 Realtime 協定與能力宣告**
  - 服務端必須提供：WebSocket URL、認證方法、握手/session event、音訊格式／sample rate／最大 frame、VAD ownership、partial/final/revision/timestamp schema、heartbeat、錯誤碼、重連與 ACK 語義。
  - 規格寫到 `docs/MODEL_ADAPTER.md`，實作於 `src/renderer/src/realtime-adapter.ts` 或 `model-adapter.ts`；設定檔增加 capabilities，而不是依 endpoint 名稱猜測。
  - input 範例（僅待確認草案）：
    ```json
    {"type":"input_audio_buffer.append","audio":"<base64 pcm16>","sequence":42,"start_sample":172032}
    ```
  - output 範例（僅待確認草案）：
    ```json
    {"type":"transcript","id":"segment-7","revision":2,"status":"partial","start_ms":3200,"end_ms":4880,"text":"正在說的句子"}
    ```
  - 驗收：partial 更新同一 id，final 不被舊 partial 覆蓋，revision 單調遞增；斷線不重複字幕或靜默遺失。

- [ ] **WebSocket 認證、背壓、重連與斷點重送**
  - 檔案：`src/renderer/src/model-adapter.ts`。
  - 不把 API key 放 query string；若 renderer WebSocket 無法帶 header，由 Main process 建受認證 proxy 或服務端發短期 token。2 MB bufferedAmount 僅為保護；需配合 sequence、server ACK、重送視窗。
  - 驗收：token 過期、網路切換、服務重啟有可理解狀態；錄音持續保存；重送行為符合服務端保證。

## P1：翻譯、批次與會議功能

- [x] **翻譯可靠性與重新翻譯（第一版）**
  - 檔案：`src/renderer/src/App.tsx`、`src/main/index.ts`。
  - 已實作：翻譯採 250/750 ms retry，失敗標記在同一段字幕並提供「重新翻譯」；人工修改原文會清除失敗狀態並可再次翻譯。原文與譯文維持同一 `TranscriptEvent.id`。
  - 待 API 驗收：翻譯服務壞掉不影響 ASR；同段不重複翻譯；術語表隨 prompt 傳送可驗證。

- [x] **大檔 PCM16 WAV 批次切分、重疊與合併（第一版）**
  - 檔案：`src/renderer/src/App.tsx`、`src/main/index.ts`。
  - 已實作：`src/renderer/src/wav-batch.ts` 解析 PCM16 RIFF/WAV，按 45 秒切分、保留 1.5 秒重疊，逐段最多重試三次，以文字 suffix/prefix 去除 overlap 重複內容；UI 顯示進度並可在目前 request 完成後取消後續段落。
  - 限制：MP3/M4A/影片仍只支援 100 MB 以下單次上傳。瀏覽器端不內嵌 FFmpeg；要支援這些大檔，模型端需提供檔案轉碼或非同步 job API。

- [x] **說話者分離 API 整合與會議紀錄**
  - 檔案：`src/renderer/src/App.tsx`、必要時 `src/main/index.ts`。
  - 已實作：人工講者標記、術語提示、摘要 Chat Completions，以及完整 WAV 後處理的自動 diarization。設定 endpoint、model、key 後，記錄頁可上傳 WAV 並按最大時間重疊回填講者。契約見 [DIARIZATION_API.zh-TW.md](docs/DIARIZATION_API.zh-TW.md)。
  - 待 API 驗收：確認服務回傳 `exclusive_diarization` / `segments` / `diarization` 的 speaker/timestamp schema；摘要 JSON schema（summary、decisions、action_items）仍可依服務端補強。

- [x] **sherpa-onnx 本機 CPU 講者分離（第一版）**
  - 檔案：`server/sherpa-diarization.cjs`、`server/index.cjs`、`src/main/index.ts`、`docs/SHERPA_ONNX.zh-TW.md`。
  - 已實作：採 `sherpa-onnx-node`，使用 pyannote segmentation 與 3D-Speaker embedding ONNX；將 PCM16 WAV 混為 mono、線性重取樣為 16 kHz `Float32Array`，再執行自動分群。`POST /api/diarizations` 回傳既有 UI 可讀的 `exclusive_diarization`。
  - Electron 設定：endpoint 填 `http://127.0.0.1:8787/api/diarizations`、model 填 `sherpa-onnx-speaker-diarization`，loopback 服務不需要 key。Web 可直接呼叫同源 `/api/diarizations`。
  - 已驗證：載入原生 Node addon、載入兩個 ONNX 模型、2 秒 PCM16 靜音 WAV 與 HTTP endpoint 都得到 HTTP 200 和有效空 segment 陣列。
  - 待真人驗收：使用至少兩人中文 WAV，確認 speaker 區段、ASR 回填重疊與 CPU 耗時；模型以自動分群標示而非姓名辨識。

- [x] **模型列表與記錄刪除**
  - 檔案：`src/renderer/src/App.tsx`、`src/renderer/src/styles.css`。
  - 已實作：頂端「模型列表」顯示保存的 ASR、翻譯與講者分離模型用途、傳輸方式、model ID、endpoint，不顯示 API key。記錄頁新增「刪除記錄」，同步刪除 IndexedDB 錄音；另存到使用者選定資料夾的 session 不會被 App 自動刪除。

## P2：發布與品質

- [x] **Web 版可使用的 S2T 模式（本機／同源部署）**
  - 已實作：`server/index.cjs` 提供 `GET /api/config` 與 `POST /api/transcriptions`；API key 只在 BFF `.env`，限制音訊分段至 12 MB、每 IP 每分鐘 60 次、限制跨來源呼叫。`electron.vite.config.ts` 在開發時代理 `/api`。
  - 已驗證：瀏覽器頁面選取 `Breeze-ASR-25`；Web → Vite proxy → BFF → ASR 的中文 WAV 得到非空白文字。
  - 相關檔案：`src/renderer/src/App.tsx`、`src/renderer/src/model-adapter.ts`、`server/index.cjs`、`README.md`。不可把 Main process IPC 直接搬到 browser。
  - 待部署驗收：HTTPS 網站真實麥克風收音、登入/session 或短期 token、正式 rate limit 與 audit log；瀏覽器系統音訊以 tab/screen share 支援為準。

- [ ] **Electron 打包與實機權限測試**
  - 檔案：`package.json`、electron-builder 設定與 CI workflow（新增時）。
  - 決定 macOS arm64/universal、Windows x64、icon、簽署/notarization；憑證不得進 repo。
  - 驗收：乾淨電腦可安裝；麥克風、系統分享音訊、浮動字幕、safeStorage、保存對話框都正常。

- [ ] **驗證基線與測試文件**
  - 檔案：新增 `docs/VALIDATION.zh-TW.md`；unit tests 覆蓋 WAV header、字幕 revision、config sanitize、VAD。
  - 每次必跑：`npm run typecheck`、`npm run build`、`git diff --check`。
  - 人工測試必須用 Electron，不用 Vite 預覽判斷 key、WAV 串流與原生保存功能，因預覽沒有 `window.s2t`。
