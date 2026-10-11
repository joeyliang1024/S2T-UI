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

> **實作狀態（2026-10-11）**：依決策「Diarization 先不做」，Phase 2／3 暫緩；Phase 1 已在分支 `feature/silero-vad-chunking` 開工，以 WER（中文以 CER 呈現）＋延遲雙指標對比驗收。實作紀錄見文末。

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

## 實作紀錄（2026-10-11，分支 `feature/silero-vad-chunking`）

Phase 1 已實作並通過 `typecheck`／`vad:smoke`／`model-adapter:smoke`：

- **產品碼接縫（最小改動）**：`vad.ts` 新增 `BoundaryVad` 介面（`process(samples): VadFrame` 同步契約），`EnergyVad` 實作之；`OpenAiChunkedModelAdapter` profile 新增可選 `vadFactory`，未注入時行為與現況完全一致。
- **`silero-vad.ts`（renderer 安全）**：`SileroBoundaryVad` 不含任何 ONNX import——機率以 Float32Array 注入（每 512 樣本@16 kHz 一個視窗，與上游 wrapper 同窗格）。遲滯契約與 EnergyVad 相同（`minSpeechMs` 起音、`minSilenceMs` 停頓），三速預設值可直接沿用，對比時唯一變數就是偵測器。設計要點：**視窗只在被推入樣本完整覆蓋時計分**（128@48 kHz 批次不對齊 16k 窗界，跨窗重複計分會讓起音提前）；最後不足一窗的尾巴不計分，由 `flush()` 顯式收尾。
- **評測**：`caption-latency-eval.cjs` 新增 `newSilero`／`fastSilero` preset（config 與 EnergyVad 對照組 `new`／`fastv2` 完全相同）；機率由 `scripts/evaluation/silero-probabilities.cjs` 預先整段算妥，餵法契約（576＝64 context＋512、state 延續）與 `server/silero-vad.cjs` 逐行一致。
- **已知限制**：評測的機率是預先計算的；產品化後機率會晚約 32 ms 到達（切點為 sample 索引、位置不受影響，但 Electron main IPC／wasm 的實際接線與共用 CPU 成本尚未做）。指標以 CER 呈現（中文素材，評測正規化後去空白，與 WER 同為字元級編辑距離）。

### 評測結果（2026-10-12，各素材前 300 秒，Breeze-ASR-25）

對照設計：`new` vs `newSilero`、`fastv2` vs `fastSilero`（config 完全相同，唯一變數是切點偵測器）。延遲＝句子起話 → 上屏。

**對話素材（含 BGM，32 句）——Silero 明確劣化：**

| preset | 延遲 p50 | p95 | ≤2500ms | 逐句CER | 語料CER | VAD句界/強制 | 空chunk | 字幕行 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| new（EnergyVad） | 1112 ms | 1789 ms | 100% | 38.63% | 35.01% | 0 / 200 | 4 | 30 |
| newSilero | 1225 ms | 1868 ms | 96.9% | 61.00% ❌ | 53.10% ❌ | 16 / 150 | 22 | 31 |
| fastv2（EnergyVad） | 782 ms | 1592 ms | 96.9% | 37.44% | 35.16% | 0 / 250 | 17 | 32 |
| fastSilero | 981 ms | 1477 ms | 96.9% | 42.98% ❌ | 41.43% ❌ | 85 / 181 | 22 | 45 |

Silero 找到了 EnergyVad 在 BGM 下找不到的句界（0 → 66～85 個），但這些句界**傷害了 CER**：BGM 中人聲暫停的機率低點不等於句子邊界，切出的短 chunk 更常只含音樂，ASR 在純音樂段產生重複幻覺（例：標準「在睡覺」→ 字幕「你該睡覺你該睡覺」；一例整段「滴滴滴…」迴圈，CER 250%），空 chunk 也從 4 個升到 22 個。

**旁白素材（無 BGM，18 句）——CER 微幅改善但延遲劣化：**

| preset | 延遲 p50 | p95 | ≤2500ms | 逐句CER | 語料CER | VAD句界/強制 |
| --- | --- | --- | --- | --- | --- | --- |
| new（EnergyVad） | 1264 ms | 1904 ms | 100% | 17.14% | 11.76% | 3 / 198 |
| newSilero | 1600 ms ❌ | 2598 ms ❌ | 88.9% ❌ | 14.54% ✓ | 11.08% ✓ | 11 / 193 |

逐句配對（n=18）：CER 中位變化 −0.8 pp（10 句改善／8 句劣化）；延遲中位 **+200 ms**（13 句變慢）。CER 的小幅優勢來自更完整的句尾覆蓋，但**沒有達到可接受的延遲**。

### 結論

- **BGM 素材：CER 與延遲雙輸** → 不可用。
- **乾淨素材：CER 小贏（語料 −0.68 pp）但延遲輸（p50 +200 ms、≤2500ms 100%→89%）** → 依「WER 與延遲都要考量」的驗收標準，不通過。
- **Phase 1（Silero 決定切點）判定為負面結果，不產品化**。維持 EnergyVad 切段；Silero 只保留既有的「無語音否決閘門」用途。
- 後續可再試的調參方向（未驗證，另開實驗）：把 `minSilenceMs` 拉長（400–600 ms）過濾 BGM 短暫低點；或句界需同時滿足機率低＋能量低（雙訊號）；或用 server 端 Silero 否決閘門先行剔除純音樂 chunk 再評 CER。

## 失效模式與業界解法（2026-10-12 查證）

針對評測暴露的三類錯誤，逐一查證業界做法（來源均已抓原文驗證）：

### 失效一：純音樂 chunk → ASR 幻覺（CER 爆炸的主因）

實測證據：從對話素材取 5 秒純 BGM 送現有 ASR 端點，回 `{"text": "Let's play."}`——幻覺，且**回應只有 `text`，沒有 `no_speech_prob`／`avg_logprob`／`compression_ratio`**。這代表 Whisper 家族的原生幻覺過濾（`openai/whisper` transcribe.py 預設 `compression_ratio_threshold=2.4`、`logprob_threshold=-1.0`、`no_speech_threshold=0.6`，重複迴圈時升溫重解碼）在我們的端點上**拿不到原料**。

業界的通用解法依序是：

1. **送 ASR 前先用 VAD 剔除非語音**（WhisperX README：「VAD preprocessing, reduces hallucination & batching with no WER degradation」；faster-whisper `vad_filter` 同理）。**這正是我們已存在的 server 端 Silero 否決閘門**（`model-adapter.ts` `sileroVadEnabled` → `/api/audio-processing/silero-vad`，threshold 0.5／minSilence 300ms）——評測時沒開，產品預設也不是 BGM 場景。上表的幻覺本來就可以被它擋掉。
2. **ASR 端信心度過濾**（whisper 的 no_speech／logprob 三閾值）→ 我們端點無此欄位，改為**客戶端文字層幻覺偵測**：zlib 壓縮比 >2.4（whisper 同款啟發式，等價偵測「滴滴滴…」迴圈）或 n-gram 重複 ≥3 次即丟棄，純 JS 幾行可做。
3. **切斷幻覺的自我延續**：WhisperX 把 `condition_on_previous_text` 預設為 `False`（README：reduces hallucination）；whisper 官方文件也警告前段文字餵回 prompt 會「get stuck in a failure loop, such as repetition looping」。我們的 rolling prompt 正是此機制——**被否決或疑似幻覺的 chunk 不應進入 rolling context**。

### 失效二：BGM 低點被當句界（切太碎、切在不該切的地方）

faster-whisper 的 `vad.py`（擷自 Silero 官方 wrapper）給了業界預設值，與我們的評測設定對比：

| 參數 | faster-whisper 預設 | 我們評測值 | 差距 |
| --- | --- | --- | --- |
| `min_silence_duration_ms` | **2000** | 150–250 | 業界保守 8–13 倍 |
| `neg_threshold`（結束閾值） | threshold−0.15（起 0.5／止 ≤0.35 雙閾值遲滯） | 單一閾值 0.5 | 無結束遲滞，易在低點抖動 |
| `speech_pad_ms` | 400（兩側補償） | 0 | 語音尾巴易被切掉 |
| `min_silence_at_max_speech` | 98ms＋超長時切在「最長的真實靜音處」而非盲切 | 超長即強制切 | 切點品質 |

即**業界對 Silero 機率的用法是「保守靜音＋雙閾值遲滯＋補償」，我們評測時用的是最激進的設定**。修正方向：結束閾值降 0.15、minSilence 拉到 400–600ms（串流場景比離線 2000ms 短但仍遠高於 150）、兩側 pad 200–400ms。smart-turn（pipecat）則代表更進一步的思路：VAD 停頓後再跑一個內容感知模型確認「句子真的講完了」（Silero 停頓期才執行，CPU 版 8MB、~10–100ms 推論），等價於把句界判定從「聲學低點」升級為「語意完成」——屬 Phase 3 級投入。

### 失效三：乾淨素材延遲 +200ms（切點網格相位改變）

whisper_streaming（IJCNLP 2023 demo）的核心是 **LocalAgreement-n**：文字在連續 n 次更新達成一致前綴時才提交上屏，**延遲與切點位置解耦**——切在哪裡不再直接決定上屏時間，延遲自適應語音複雜度（論文實測 3.3 秒）。我們目前「每 chunk 一次定稿」的架構讓切點網格直接決定延遲，這是 +200ms 的結構性來源。這是較大的架構改動（另一條產品線等級），記錄為後續方向；同作者 2025 年的後繼專案 SimulStreaming 可一併追蹤。

### 對應到我們的修正優先序

1. **開 Silero 否決閘門**（已存在，零新碼）——直接對應失效一，業界驗證過的最大項。
2. **客戶端幻覺偵測**（壓縮比／n-gram 迴圈，數行 JS）——補端點無信心度欄位的缺口。
3. **句界參數向業界預設看齊**（neg_threshold 遲滯＋minSilence 400–600ms＋pad）——對應失效二，config 級改動。
4. rolling context 衛生化（被否決 chunk 不進 context）——斬斷幻覺延續。
5. （另案）LocalAgreement 增量提交——對應失效三的結構性解法。

## 參考來源

- 本專案：`docs/reports/CAPTION_LATENCY.zh-TW.md`、`experiment/diarization/comparison-2026-10-04/研究與實驗報告.md`、`docs/guide/SILERO_VAD.zh-TW.md`、`docs/reference/DIARIZATION_API.zh-TW.md`
- 論文：WhisperX（arXiv 2303.00747）、Whisper-Streaming（arXiv 2307.14743／IJCNLP 2023 demo）、Turn-to-Diarize（arXiv 2109.11641）、DIART（arXiv 2109.06483）、線上 diarization 延遲評估（arXiv 2407.04293）、Streaming Sortformer（arXiv 2507.18446）
- Repo：ufal/whisper_streaming（含 LocalAgreement／VAC，後繼 SimulStreaming）、QuentinFuxa/WhisperLiveKit、bhargavchippada/faster-whisper-dictation、pipecat-ai/smart-turn、SYSTRAN/faster-whisper（`vad.py` 閾值實作）、openai/whisper（`transcribe.py` 幻覺過濾三閾值）、m-bain/whisperX（VAD 前處理減幻覺、`condition_on_previous_text=False`）
- 官方文件：NVIDIA Nemotron 3 Diarization（Hugging Face blog 2026-09，含延遲參數表）、pyannote streaming 架構文（2026-10）、LiveKit turn detection 文件
