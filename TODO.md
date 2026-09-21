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

- [ ] **跨重啟後無法讀取已保存音檔**
  - 問題：`src/main/index.ts` 的 `availableAudioPaths` 是記憶體 `Set`；Electron 重啟後，歷史頁不能經 IPC 讀取先前保存的 WAV。
  - 修正：`session.json` 保存 schema version 和相對音檔名；新增 `session:read-audio` IPC，只允許讀取使用者選取 session 資料夾的 `audio.wav`。使用 `realpath` 驗證路徑在 session root 內，避免目錄跳脫。
  - 相關檔案：`src/main/index.ts`、`src/preload/index.ts`、`src/preload/index.d.ts`、`src/renderer/src/vite-env.d.ts`、`src/renderer/src/App.tsx`。
  - 驗收：重啟後可開啟 session、播放及重新匯出；不能讀到 session 資料夾外的任意檔案。

- [ ] **未保存錄音在強制關閉後不能復原**
  - 問題：完成但尚未「保存工作階段」的暫存 WAV 沒有永久 manifest。
  - 修正：在 userData 建立 `recording-manifest.json`，記錄 active/finished 暫存 WAV 與 metadata；保存後清除；下次啟動顯示可復原項目或安全刪除。
  - 相關檔案：`src/main/index.ts`、`src/renderer/src/App.tsx`。
  - 驗收：收音中或停止後強制結束，重開仍可復原可播放 WAV，或可明確清理。

- [ ] **ScriptProcessorNode 已過時且在 callback 做太多工作**
  - 問題：目前 `App.tsx` 用 `createScriptProcessor(4096)`；音訊 callback 同時 PCM 轉換、IPC、Adapter 佇列，長時間時可能造成 renderer 壓力。
  - 修正：新增 `src/renderer/src/audio-capture.worklet.ts`，以 AudioWorklet 處理 128-sample frame；主執行緒只收 MessagePort frame 並處理寫檔／模型。保留 analyser 和系統音訊混音。
  - 驗收：收音、暫停、切換裝置、混音、音量表、字幕時間戳均正常；不在 Worklet 內做 React state 或網路請求。

- [x] **HTTP 音訊累積改為 chunk queue**
  - 已實作：`OpenAiChunkedModelAdapter` 用 `Float32Array[]` 與 sample 計數保存待送音訊，僅在 flush 成 WAV 時建立固定大小 array；避免每個 audio callback 複製全部 pending 音訊。
  - 待實機驗收：60 分鐘收音 renderer 記憶體不隨時間線性升高，字幕 start/end timestamp 仍正確。

- [ ] **校正 app-side VAD 閾值與 edge cases**
  - 現況：已新增 `src/renderer/src/vad.ts`，但尚未收集真實麥克風環境的 noise floor 與門檻資料。
  - 待做：將 start/stop threshold、120 ms onset、500 ms silence、300 ms pre-roll 設為模型／使用者可調的設定；判斷長靜音後 stop 是否需要送出尾音，並避免很小的音量被誤判成非語音。
  - 驗收：安靜、鍵盤聲、長停頓、快速對談中不送長靜音、不切句首、不過度斷句。

- [ ] **依 faster-whisper 的 VAD 與 timestamps 經驗校正切段**
  - 參考：[faster-whisper README](https://github.com/SYSTRAN/faster-whisper#vad-filter) 提供 Silero VAD，並示範 `min_silence_duration_ms=500`；其 word timestamps 代表應讓模型／gateway 可選擇回傳更細時間資訊。
  - 整合：`src/renderer/src/vad.ts` 的初版改以 500 ms silence 為可調起點，並把 VAD 結果和 `startSample`／`endSample` 寫入事件。Breeze HTTP 回應若只有文字，App 仍使用音訊切段邊界作 segment timestamps，不假裝是 word timestamps。
  - 驗收：設定可調整 min silence，匯出 JSON 明確標示 timestamp 的來源是 App chunk 邊界或模型回傳。

- [ ] **依 sherpa-onnx 的 streaming/non-streaming 分層設計模型能力**
  - 參考：[sherpa-onnx README](https://github.com/k2-fsa/sherpa-onnx) 明確分開 streaming ASR、non-streaming ASR、VAD、speaker diarization；同時展示 VAD + non-streaming ASR 的組合。
  - 整合：設定檔未來增加 capability，而非只用 endpoint 推測：`transport: http-chunked | websocket`、`asrMode: non-streaming | streaming`、`vad: app | server`、`timestamps: chunk | segment | word`。Breeze-ASR-25 先登錄為 `http-chunked/non-streaming/app/chunk`；自建 WebSocket gateway 才登錄為 streaming。
  - 相關檔案：`src/renderer/src/App.tsx` 的模型表單與 `src/main/index.ts` 的 `sanitizeModelConfig()`；正式 schema 寫到 `docs/MODEL_ADAPTER.md`。
  - 驗收：UI 顯示選擇的傳輸能力；對不支援 partial 的模型不顯示「原生即時 partial」承諾。

- [ ] **HTTP 失敗與背壓缺口尚未寫入逐字稿事件**
  - 問題：現況只在狀態列提示略過音訊，匯出檔無法辨認遺失區間。
  - 修正：在 `TranscriptEvent` 或獨立事件流加入 `gap`，包含 sequence、start/end sample、原因。單次網路失敗採 250/750/1750 ms 指數退避，最多 3 次；最終失敗寫 gap。
  - 相關檔案：`src/renderer/src/model-adapter.ts`、`src/renderer/src/App.tsx`、匯出函式。
  - 驗收：斷網後重連，後續字幕持續；JSONL 可識別未轉錄時間，不能把缺口偽裝成靜音。

- [ ] **修復 Electron「混入系統音訊」無法使用**
  - 現象：使用者勾選後，Electron 的系統分享視窗無法提供可混入的音軌，或 `getDisplayMedia()` 回傳的 stream 沒有 audio track。
  - 優先調查：macOS 的 Screen Recording／系統音訊權限、Electron 44 的 `session.setDisplayMediaRequestHandler()`、`DesktopCapturerSource` 選擇、`audio: 'loopback'` 是否為該平台支援的 handler 設定；不可只依 Renderer 的 `getDisplayMedia({ audio: true, video: true })` 假設有系統音訊。
  - 修正位置：`src/main/index.ts` 設定顯示媒體請求 handler 與明確錯誤回傳；`src/preload/index.ts` 暴露受限的 source picker IPC；`src/renderer/src/App.tsx` 顯示 source picker、權限步驟與「此平台不支援」狀態。
  - 驗收：macOS 實機選擇可播音的 App／螢幕後，混音波形與 dBFS 在播音時變化；錄下的 WAV 同時含麥克風與系統聲；使用者取消或未勾選分享音訊時，麥克風收音仍可繼續。

## P0：模型服務驗證（需 vLLM／模型端資料）

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

- [ ] **翻譯可靠性與重新翻譯**
  - 檔案：`src/renderer/src/App.tsx`、`src/main/index.ts`。
  - 補上翻譯 queue 上限、retry/backoff、失敗標記；人工修改原文後提供「重新翻譯」。原文與譯文必須維持同一 `TranscriptEvent.id`。
  - 驗收：翻譯 API 壞掉不影響 ASR；同段不重複翻譯；術語表隨 prompt 傳送可驗證。

- [ ] **大檔批次切分、重疊與合併**
  - 檔案：`src/renderer/src/App.tsx`、`src/main/index.ts`。
  - 現況：100 MB 以下直接上傳。待做：依服務上限切 WAV/影片解音訊、重疊去重、timestamp 合併、進度與取消。
  - 前提：模型端提供最大檔案、容器格式與非同步 job API（如有）。

- [ ] **說話者分離與會議紀錄**
  - 檔案：`src/renderer/src/App.tsx`、必要時 `src/main/index.ts`。
  - 現況：人工講者標記、術語提示、摘要 Chat Completions 已有；自動 diarization 未實作。
  - 需要 API：speaker/timestamp schema；摘要 JSON schema（summary、decisions、action_items）。

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
