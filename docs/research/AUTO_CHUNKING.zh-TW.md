# 1011：Chunking 自動切分可行性（VAD + Diarization）

研究性文件：回答「能否讓 VAD + Diarization 自動決定怎麼切 chunk」。結合本專案既有量測、codebase 現況與外部論文／成熟 repo 做法，給出結論與分階段建議。本檔為歷史設計背景，不代表任何功能已完成或已驗收；需要追蹤的缺口以 [Enhancement.md](../Enhancement.md) 的 U02 為準。

## 一句話結論

- **VAD 自動決定切點**：可行且已是業界標準（WhisperX 的 VAD Cut & Merge），本專案只差把句界偵測器從 EnergyVad（RMS）換成 Silero（ML）。收益明確：修掉 BGM 素材上「句界恆為 0、全強制切段」的已量測失效模式。
- **Diarization 參與決定切點**：可行，且本專案的 request/response 架構反而是它合理存在的前提（串流 STT 不需要切段，所以 pyannote 走並行＋時間戳對帳；必須切段送的系統才有理由讓講者資訊參與切點）。有 Turn-to-Diarize（Google, ICASSP 2022）與 Argmax pre-diarized transcription 兩個先例，但需先補離線模擬（Phase 0）證明收益，不宜直接進產品碼。

## 現況盤點：目前有四套切段機制

| 機制 | 位置 | 規則 |
| --- | --- | --- |
| 即時字幕切段 | `src/renderer/src/features/capture/vad.ts`、`src/renderer/src/features/models/model-adapter.ts` | EnergyVad（RMS 音量）產生天然句界（`minSilenceMs`），`flushPending` 在「句界或 `chunkMaxMs`」擇先觸發時切段；三速預設 快 700/1200/150、正常 700/1500/250、慢 1000/2400/800 |
| 伺服器端 Silero 關卡 | `server/silero-vad.cjs`、`model-adapter.ts` | 每個待送 ASR 的短 WAV 先判有無語音，無語音不發請求（可選、預設關） |
| 檔案匯入固定切 | `src/renderer/src/features/transcript/wav-batch.ts` | 固定 45 秒段＋1.5 秒重疊，`joinOverlappedText` 去重；gap 補跑用 30 秒無重疊 |
| 講者分離切塊 | `server/sherpa-diarization.cjs`、即時預覽 45 秒 rolling buffer | 與字幕切段完全解耦：預覽 30 秒 tick，結果以時間戳重疊歸屬到既有字幕 |

關鍵架構事實：`OpenAiChunkedModelAdapter` 的 `pendingBoundaries` 以 sample index 記錄、pending buffer 上限 30 秒、最多 4 個在途請求——**一個「晚到的邊界」可以直接插進 `pendingBoundaries`，不需要改資料流**。這是後續所有方案的立足點。

## 內部量測證據

### VAD 面（`docs/reports/CAPTION_LATENCY.zh-TW.md`）

- BGM 素材（對話影片）上 EnergyVad 句界恆為 0，實測 200/200 段全數強制切段；三速的 `minSilenceMs`／`chunkMinMs` 在此類素材不參與運算。
- 無 BGM 素材上，`minSilenceMs` 是天然句界的總開關（150 ms 觸發 8–13 個、250/350/800 為 0）；切段變短的準度補償只有滑動 prompt（上一段尾 60 字）有效且零延遲成本。
- 「無 BGM＋較長停頓（250–800 ms）」素材（如會議錄音）尚未量測，屬已知驗證缺口。

### Diarization 面（`experiment/diarization/comparison-2026-10-04/`）

- sherpa live preview（45 秒視窗、30 秒 tick）在 17 分鐘三人素材：DER 76.78%、3 人切成 53 群 → **此路徑的標籤穩定度不足以驅動任何切點決策**。
- Nemotron v3 streaming 以 20 ms 真實節奏餵 60 秒：已標註音訊落後牆鐘 P50 253.6 ms／P95 268.7 ms、push 呼叫 P95 0.82 ms、首筆非空結果 1164.8 ms、總牆鐘 60.17 s → **持續狀態的 streaming diarization 在本機大致跑得動**。但未與 ASR 同跑量測，共用 CPU 的影響未知（本專案 ASR 在遠端 HTTP，本地餘裕較大，惟仍需自測）。
- 該 paced 測試使用 native v0.2.0、chunk=13＋right context=1（≈1.12 s），貼近 Nemotron 官方「低延遲」檔。

## 外部做法與論文證據（2026-10 查證）

### VAD 決定切點：業界標準

| 系統 | 做法 | 對本專案的意義 |
| --- | --- | --- |
| **WhisperX**（Bain et al., arXiv 2303.00747，引用 ~1000） | `VAD Cut & Merge`：VAD 切段→合併到接近 30 秒→送 Whisper；論文實證比固定視窗降 WER | 「VAD 自動決定怎麼切」是這類系統的事實標準，Phase 1 不是實驗性做法 |
| **WhisperLiveKit／faster-whisper-dictation** | 本地 Silero VAD 偵測完整 utterance，一個 utterance 送一次請求 | 與本專案 request/response 架構同型，可直接參考切段參數 |
| **whisper_streaming**（ufal, 3.7k stars, IJCNLP 2023） | 不切獨立段：滾動 buffer＋重解碼，LocalAgreement-n（連續 n 次更新前綴一致才 commit）；VAD 僅做 buffer trimming 與解碼排程 | 不適用本專案——重解碼意味 API 重複計費；但「VAD 決定何時值得花錢解碼」與現有 `hasSileroSpeech` 否決閘門同理 |

### Diarization 參與切點：兩條分岐路線

- **路線 A（支持本方案）：turn 級切分驅動標記**。Turn-to-Diarize（Google, ICASSP 2022, arXiv 2109.11641，用於 Google Recorder）：Transformer Transducer 線上偵測說話回合，每個 turn 切一段、抽一個 embedding、再聚類——**切點由便宜的線上 turn 偵測決定，重的 diarization 被動標記**。Argmax Pro SDK 3（NVIDIA 合作夥伴, 2026-09）推出 pre-diarized transcription API：先分離講者再送 ASR，明言為改善重疊語音的轉錄品質。
- **路線 B（對照）：並行跑、時間戳對帳**。pyannote 串流產品（2026-10 官方部落格）：100 ms chunk、總延遲目標 300 ms；生產模式是同一份麥克風音訊同時餵 diarization（who）與**串流 STT**（what），事後以時間戳重疊歸屬，不用 diarization 切 ASR。**前提是配對的 STT 是串流、有 partial、本來就不需要切**。本專案 ASR 為 request/response、每段獨立請求，切段不可避免 → diarization 參與切段在此架構下是正當的。
- 學術側延遲常數（arXiv 2407.04293）：DIART 與 FS-EEND 每 chunk 計算延遲約 57–64 ms 且不隨錄音長度增長；UIS-RNN 聚類 O(t²) 不可用於長錄音。**計算不是瓶頸，演算法緩衝延遲（right context）才是，而那是可調參數。**

### 本機 Nemotron 的官方可調延遲（HF blog, 2026-09）

官方參數表（單位 80 ms encoder frame）：

| 預設 | 輸入緩衝延遲 | spkcache | FIFO | chunk | right context |
| --- | --- | --- | --- | --- | --- |
| 離線式 | 30.4 s | 264 | 40 | 340 | 40 |
| 低延遲 | 1.04 s | 264 | 264 | 9 | 4 |
| 極低延遲 | 0.64 s | 264 | 264 | 6 | 2 |
| 超低延遲 | 0.32 s | 264 | 264 | 3 | 1 |

- 實驗所用 chunk=13＋right=1（≈1.12 s）≈ 官方「低延遲」檔；**可切到 0.32 s 檔再砍緩衝延遲**（DER 有些微代價，但官方數據在 0.32 s 每個資料集仍優於前代 Sortformer）。
- 這些是 GPU/BF16 數據；本專案為 macOS CPU＋GGUF Q8_0，切檔前必須自跑 paced 實驗重測 lag 與 RTF。
- Sortformer 的 arrival-order channel 排序讓串流標籤天生穩定，不必每 chunk 解 permutation——部分解掉「標籤穩定度」的顧慮。

### 第三訊號（與切段解耦，另案追蹤）：Semantic VAD

LiveKit turn-detector、pipecat smart-turn、AssemblyAI endpointing 等，在 VAD 之上加一層小模型看**已轉出的文字**判斷句子是否結束。它服務翻譯的整句策略（Enhancement Q02），不服務字幕切段：需要 partial 文字，而本專案 HTTP ASR 沒有 partial。可行的變形是「caption commit 後再判斷是否觸發翻譯」，屬翻譯排程議題。

## 方案比較

| 方案 | 切點來源 | 延遲影響 | 準度影響 | 風險 |
| --- | --- | --- | --- | --- |
| 現況（EnergyVad＋三速） | RMS 靜音＋chunkMax | 基線 | BGM 素材 100% 強制切段 | 已量測的失效模式 |
| A：Silero 句界 | ML VAD 靜音＋chunkMax | 中性（句界偵測快於 RMS，但 minSilence 確認仍在） | 預期 BGM 素材首次出現天然句界 | 低；EnergyVad 保留為 fallback |
| B：＋換人點切段 | A ∪ 換人確認（含遲滯） | 中性偏改善（換人常早於 chunkMax；吃 diarization lag ~0.3–0.5 s） | 單講者 chunk 純度↑（未驗證）；換人處 prompt 需重置 | 中；overlap 切詞尾、標籤錯配 |
| C：pre-diarize 再切 | 先分離講者、再以講者段餵 ASR | 不適用即時（離線管線） | 重疊語音品質↑（Argmax 主張） | 僅適用檔案匯入／停止後重轉錄 |

## 建議路線

### Phase 0：離線模擬（零產品碼，先行）

目的：不改一行產品碼，先知道方案 B 的收益上限。素材與工具都已存在：

1. 取 `experiment/diarization/comparison-2026-10-04/` 的現成 RTTM（VoxConverse 十份）＋ Silero 區間（`npm run caption:reference` 產物或 `server/silero-vad.cjs` 重算）。
2. 參考 `scripts/evaluation/caption-latency-eval.cjs` 的 esbuild 打包法，把「換人點＋遲滯（確認換人、前後 N ms 無重疊、距上一 chunk ≥ 下限）」策略套到現有 chunk 流邏輯上重放。
3. 統計：切點分布、`chunkMax` 強制觸發率、平均 chunk 長、chunk 講者純度、每句被切成幾段。
4. 判讀：若換人切點相對現況分布無變化（例如對話素材句界率已近 0、換人點又落在重疊區），方案 B 直接放棄，只做 Phase 1。

### Phase 1：Silero 進切點路徑

- Electron：renderer 流式 IPC 到 main（已有 `onnxruntime-node`），每 32 ms 一個 window，邊界回傳；Web：gateway 每 200–500 ms 批次 PCM 查既有 `/api/audio-processing/silero-vad`，或 renderer wasm worker。
- EnergyVad 保留為 fallback；`chunkMin/Max` 三速維持為硬邊界，只換句界偵測器。
- 驗收：`npm run caption:eval` 在 BGM＋無 BGM 素材回歸——p95 與 CER 不得劣於基線，且 BGM 素材首次出現天然句界（現為 0）。另需補「無 BGM＋較長停頓（會議型）」素材，填補 CAPTION_LATENCY 已知缺口。

### Phase 2：換人點切段（feature-flag）

- 切點決策 = VAD 靜音（主）∪ 換人確認（次，含遲滯與重疊閘）∪ chunkMax（硬上限）；以「晚到邊界」形式插入 `pendingBoundaries`（架構已支援）。
- 換人處重置滾動 prompt（避免上一位講者的文字污染下一段解碼）——此單點改動獨立於其他部分、本身即有價值。
- Diarization 後端：先用 Nemotron 0.32 s 檔重跑 paced 實驗確認 macOS CPU 的 lag；sherpa live preview 路徑不得作為切點來源（DER 76.78%、3→53 群）。
- 驗收：`caption:eval` 擴充「chunk 講者純度」指標；p95 ≤ 2.5 s 不得回歸。

### Phase 3：檔案匯入改 VAD／講者引導切點

- `wav-batch.ts` 的固定 45 秒＋1.5 秒重疊，改為「VAD 句界＋換人點決定切點、45 秒只是上限」；離線無延遲預算，是三案中最安全、收益最直接的一刀（減少句中切斷與重疊去重的誤差）。
- 可選：停止後重轉錄走方案 C（pre-diarize 再切）對照，驗證 Argmax 主張的重疊語音品質收益。

### 不在本次範圍

- Semantic VAD／回合偵測：屬翻譯整句策略（Q02），另案。
- 流式 ASR（WebSocket adapter 已有暫定協定）：改 API 範疇，本研究不觸及。
- 超過 8 人或不限人數的 streaming diarization：Nemotron 上限 8 人，超出需求需另選方案（如 Community-1／VBx，未取得權重、未比較）。

## 主要風險與未決問題

1. 「單講者 chunk 對 Whisper 類模型 CER 更好」在本專案從未量過，是 Phase 0 要先證實的前提。
2. 換人點常伴隨 backchannel／插話／重疊；遲滯參數需以真實中文多人會議驗收（Enhancement 的驗收清單同款要求），不能只用 VoxConverse。
3. 與 ASR 共用 CPU 的實測不存在（外部與內部皆未測）；Web 瀏覽器／低階裝置的 wasm 或 gateway round-trip 成本未知。
4. Nemotron 0.32 s 檔在 macOS CPU＋GGUF 的實際 lag／DER 未測。
5. 檔案匯入改切法會影響既有的 import-checkpoint 續跑條件（chunk 邊界變了，checkpoint 匹配邏輯需一併考慮）。

## 參考來源

- 本專案：`docs/reports/CAPTION_LATENCY.zh-TW.md`、`experiment/diarization/comparison-2026-10-04/研究與實驗報告.md`、`docs/guide/SILERO_VAD.zh-TW.md`、`docs/reference/DIARIZATION_API.zh-TW.md`
- 論文：WhisperX（arXiv 2303.00747）、Whisper-Streaming（arXiv 2307.14743／IJCNLP 2023 demo）、Turn-to-Diarize（arXiv 2109.11641）、DIART（arXiv 2109.06483）、線上 diarization 延遲評估（arXiv 2407.04293）、Streaming Sortformer（arXiv 2507.18446）
- Repo：ufal/whisper_streaming、QuentinFuxa/WhisperLiveKit、bhargavchippada/faster-whisper-dictation、pipecat-ai/smart-turn
- 官方文件：NVIDIA Nemotron 3 Diarization（Hugging Face blog 2026-09，含延遲參數表）、pyannote streaming 架構文（2026-10）、LiveKit turn detection 文件
