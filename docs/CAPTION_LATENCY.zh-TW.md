# 即時字幕延遲調校報告（P95 ≤ 2.5 秒）

本文件記錄端到端「開始說話 → 首筆字幕上屏」延遲的調校過程：評測方法、素材、完整數據、最終寫入產品碼的設定與理由，以及已知限制。翻譯不在本次目標內。

## 目標與約束

- **延遲**：說話開始到字幕上屏，端到端 P95 ≤ 2500 ms（不含翻譯）。
- **準度不降、不加劇碎片化**：CER 與「每句被切成幾段」不得劣於基線。
- **API 固定**：ASR 為 request/response（每段音訊獨立請求），不改模型架構、不加流式介面。

## 評測方法

評測腳本 `scripts/caption-latency-eval.cjs`（`npm run caption:eval`）：

1. 用 esbuild 把**真實的 renderer 模組**（`EnergyVad` + `OpenAiChunkedModelAdapter`）打包進 Node，跑的與 App 同一份切段、排隊、合併程式碼。
2. 音訊以 20 ms 批次**依真實收音節奏**推送（不加速，排隊行為才與生產一致）。
3. chunk 真的送 ASR（`.env` 的 Breeze-ASR-25 端點）；顯示中的字幕用 `translation-policy.canMergeHttpCaption` 合併規則重建。
4. 指標：
   - **延遲**：句級標準答案的 start → 該句首筆字幕的**實際上屏 wall time**，P50/P95 與 ≤2500 ms 比例。
   - **準度**：語料級 CER（整段文字對整段參考）＋ 逐句 CER（以原始 chunk 事件對齊句子區間，避免合併字幕污染）。
   - **碎片化**：字幕總行數、每句被切成幾段、被切開句數、合併次數。

### 標準答案

| 素材 | 標準答案來源 | 規模 |
| --- | --- | --- |
| 歌曲《梁山伯與茱麗葉》 | 人工句級 TSV | 40 句 |
| 對話影片（what'sub） | `scripts/build-reference-tsv.cjs` 自動產生 | 61 段 |

自動產生方式（`npm run caption:reference`）：**Silero VAD**（`models/silero-vad/`，與被評測的 EnergyVad 是不同模型、互相獨立）偵測語音區間得到句級起訖，再把每個區間**整段**送 ASR（完整上下文、不經切段）取得參考文字。

> ⚠️ 方法學限制：端點不支援 `verbose_json`（僅 `text`/`json`，無法自帶時間戳），參考文字由**同一模型**的整段解碼產生，且區間由 Silero 切分。因此 CER 數字只代表**跨 preset 的相對比較**，不是人工逐字稿的絕對準度。

### 測試素材特性

| 素材 | 長度 | 特性 |
| --- | --- | --- |
| 歌曲 | 238 s | 人聲+音樂混合，EnergyVad 句界極少（99 段中僅 2 個 VAD 句界） |
| 對話影片 | 827 s（評測取前 300 s） | **有背景音樂**：全 200 段皆強制切段（VAD 句界 0），BGM 讓 EnergyVad 全程誤判「說話中」 |

對話影片是本次主要調校依據（指定素材）；兩者皆為 BGM 在場的極端條件。

## 測得數據

### 歌曲（2026-09-30，滑動 prompt 產品化之前）

| preset | chunks | ASR p95 | 延遲 p50 | 延遲 p95 | ≤2500ms | 語料CER |
| --- | --- | --- | --- | --- | --- | --- |
| old（1000/2400/500） | 99 | 619 ms | 1781 ms | **2833 ms ❌** | 72.5% | 73.94% |
| new（700/1500/250） | 160 | 581 ms | 1007 ms | 2574 ms △ | 92.5% | 91.78% |

（此二跑早於 `sanitizeAsrText` 與滑動 prompt，CER 含 `<|…|>` token 洩漏的污染，僅供延遲面參考。）

### 對話影片前 300 秒（wave1，32 句參考，2026-10-01）

| preset | ASR p95 | 延遲 p50 | 延遲 p95 | ≤2500ms | 逐句CER | 語料CER | 字幕行 | 被切句 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| old（1000/2400/500） | 695 ms | 1485 ms | **2706 ms ❌** | 84.4% | 39.07% | 34.64% | 32 | 17 |
| new（700/1500/250） | 491 ms | 1033 ms | 1669 ms ✅ | 96.9% | 41.14% | 39.07% | 31 | 16 |
| **newctx（＋滑動 prompt）** | 472 ms | 1029 ms | **1701 ms ✅** | **100%** | **38.63%** | **35.01%** | **30** | **14** |
| newov（＋600ms 重疊） | 648 ms | 983 ms | 1735 ms ✅ | 96.9% | 44.98% ❌ | 42.54% ❌ | 30 | 17 |
| new16k（16kHz 上傳） | 504 ms | 1002 ms | 1860 ms ✅ | 96.9% | 40.84% | 38.85% | 31 | 16 |

（newctx 的 prompt 在該輪由評測層模擬，參數與後來產品碼一致：取上一段清洗後文字的尾 60 字。）

## 判讀

1. **`chunkMax` 2400→1500 是延遲最大槓桿**：強制切段等待時間減半，對話素材 p95 2706→1669 ms；舊設定在兩種素材上都不達標。
2. **滑動 prompt 是唯一有效且零延遲成本的準度補償**：切段變短損失的跨段上下文，用上一段字幕當 prompt 補回——逐句 CER 41.14%→38.63%（追平舊設定的 39.07%）、空字幕 chunk 7→4、32/32 句全上屏、碎片化也最好（30 行、被切開 14 句）。與 Whisper 官方 long-form 解碼的 `<|startofprev|>` 實務作法一致。
3. **重疊 anchor 判定有害，不採用**：+600 ms payload 使 ASR p95 +157 ms，CER 反而 +3.5 pp（42.54%），前綴去重也補不回來。
4. **16 kHz 上傳無實測效益，不採用**：延遲與準度都與 48k 無差異（p95 反而略差，屬噪音），維持 48k 避免端點相容風險。
5. **BGM 素材下 `chunkMin`/`minSilence` 不參與運算**：VAD 句界恆為 0（old 設 500 ms 也是 0），所有差異全來自 `chunkMax` 與 prompt。原候選 `balanced`（1000/300）在此素材與 `newctx` 數學上等價，故未重跑；**無 BGM 的純語音素材**上它們才會生效，屬未驗證項（見限制）。

## 最終設定（已寫入產品碼）

### VAD／切段 — `src/renderer/src/features/capture/vad.ts` `defaultVadConfig`

| 參數 | 舊值 | **新值** | 理由 |
| --- | --- | --- | --- |
| `minSpeechMs` | 120 | 120 | 不變（起音判定） |
| `minSilenceMs` | 500 | **250** | 句尾停頓判定縮短；BGM 素材上不影響，純語音上降延遲 |
| `preRollMs` | 300 | 300 | 不變（句前 room tone） |
| `noiseFloorOffsetDb` | 12 | 12 | 不變 |
| `chunkMinMs` | 1000 | **700** | 天然句界可更早送出；實測未加劇碎片化 |
| `chunkMaxMs` | 2400 | **1500** | **最大延遲槓桿**：強制切段上限減半 |

`src/main/index.ts` 的 Electron 設定驗證 fallback 已同步。

### 模型適配器 — `src/renderer/src/features/models/model-adapter.ts`

- **滑動上下文 prompt**（`rollingPrompt()`）：把**上一段成功字幕（清洗後）的尾 60 字**併入 API `prompt`，與使用者術語 prompt 以換行合併。
  - 僅在語言明確時啟用，自動語言模式不送，避免污染偵測。
  - Electron 走 `prompt` 欄位；Web 走 `x-s2t-prompt` header（`server/index.cjs` gateway 已支援）。
  - 每次成功辨識後更新，`start()` 時重置。
- **輸出清洗**（`sanitizeAsrText`）：Breeze-ASR-25 會洩漏 `<|8.59|>` 時間戳 token 與 `||` 分隔符，於 HTTP 與 WebSocket 兩路徑統一清掉（產品 bug 修正，也避免髒字回灌 prompt）。

### 明確不採用

- 重疊 anchor（+600 ms 前段音訊）：實測準度與延遲皆劣化。
- 16 kHz 上傳：無實測效益。

### 使用注意

已儲存的使用者設定會**覆蓋**新預設值；既有使用者需在設定頁 VAD 卡片按「恢復預設值」才會套用 700/1500/250。

## 驗證紀錄

| 項目 | 結果 | 證據 |
| --- | --- | --- |
| TypeScript 型別 | 通過 | `npm run typecheck` |
| 模型適配器合約（含滑動 prompt 斷言：首段無 context、次段帶上一段文字、Web header 同步） | 通過 | `npm run model-adapter:smoke` |
| 翻譯排程策略 | 通過 | `npm run translation-policy:smoke` |
| VAD | 通過 | `npm run vad:smoke` |
| 新路徑（重疊 WAV／16k）可執行性 | 通過 | 60 s 煙霧跑（準度數字僅供路徑驗證） |
| 最終配置端到端確認跑（產品碼滾動 prompt 路徑，對話前 300 s） | 見 `eval-reports/caption-latency-new-300s.json` | `npm run caption:eval -- --preset new --max-seconds 300` |

## 已知限制與後續

1. **參考非人工逐字稿**：對話素材 CER 只能跨 preset 相對比較；若要絕對準度需人工校對 TSV。
2. **素材皆含 BGM**：EnergyVad 在 BGM 下全部強制切段，`minSilence/chunkMin` 的行為尚未在**無 BGM 純語音**素材上驗證（建議補一筆對話式錄音再跑一次 `old/new/newctx`）。
3. **P95 上限來自 request/response 架構**：切段等待（≤ chunkMax）＋ ASR 推論（p95 約 470–700 ms，偶發尖峰 >1 s）。新設定下對話素材 P95 1701 ms、餘裕約 800 ms；若日後要逼近更低延遲或降低尾部尖峰，需 partial/增量架構，屬「改 API」範疇，本次不動。
4. 歌曲素材的 CER 為清洗與 prompt 產品化之前的舊跑，數字不可跨輪比較。

## 重現指令

```bash
# 產生標準答案 TSV（Silero VAD 區間 + 逐段 ASR 文字）
npm run caption:reference -- --audio "music/xxx.mp3" [--max-seconds 300]

# 跑評測（presets: old/new/newov/new16k；滾動 prompt 與清洗由產品碼自動生效）
npm run caption:eval -- --audio "music/xxx.mp3" --tsv "music/xxx_句級Speaker時間軸.tsv" \
  --max-seconds 300 --preset old,new
```

報告 JSON 存於 `eval-reports/`。
