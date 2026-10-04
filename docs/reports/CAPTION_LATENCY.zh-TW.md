# 即時字幕延遲調校報告（P95 ≤ 2.5 秒）

本文件記錄端到端「開始說話 → 首筆字幕上屏」延遲的調校過程：評測方法、素材、完整數據、最終寫入產品碼的設定與理由，以及已知限制。翻譯不在本次目標內。

## 目標與約束

- **延遲**：說話開始到字幕上屏，端到端 P95 ≤ 2500 ms（不含翻譯）。
- **準度不降、不加劇碎片化**：CER 與「每句被切成幾段」不得劣於基線。
- **API 固定**：ASR 為 request/response（每段音訊獨立請求），不改模型架構、不加流式介面。

## 評測方法

評測腳本 `scripts/evaluation/caption-latency-eval.cjs`（`npm run caption:eval`）：

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
| 對話影片（what'sub） | `scripts/audio/build-reference-tsv.cjs` 自動產生 | 61 段 |
| 旁白影片（財富階梯，第二輪） | 同上（`--min-silence 250`） | 18 段 |

自動產生方式（`npm run caption:reference`）：**Silero VAD**（`models/silero-vad/`，與被評測的 EnergyVad 是不同模型、互相獨立）偵測語音區間得到句級起訖，再把每個區間**整段**送 ASR（完整上下文、不經切段）取得參考文字。

> ⚠️ 方法學限制：端點不支援 `verbose_json`（僅 `text`/`json`，無法自帶時間戳），參考文字由**同一模型**的整段解碼產生，且區間由 Silero 切分。因此 CER 數字只代表**跨 preset 的相對比較**，不是人工逐字稿的絕對準度。

### 測試素材特性

| 素材 | 長度 | 特性 |
| --- | --- | --- |
| 歌曲 | 238 s | 人聲+音樂混合，EnergyVad 句界極少（99 段中僅 2 個 VAD 句界） |
| 對話影片 | 827 s（評測取前 300 s） | **有背景音樂**：全 200 段皆強制切段（VAD 句界 0），BGM 讓 EnergyVad 全程誤判「說話中」 |
| 旁白影片 | 1356 s（評測取前 300 s） | **無 BGM**：停頓多在 150–250 ms；僅 `minSilence 150` 觸發 8–13 個 VAD 句界，250 以上為 0 |

對話影片是本次主要調校依據（指定素材）；歌曲與對話影片是 BGM 在場的極端條件，旁白影片補上無 BGM 的對照端（第二輪）。

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

### 第二輪調校矩陣 — 對話影片（2026-10-01，六組同場對照）

`fast1000,fast1100,fastv2,new,slow,slow3000` 同場跑，消除 ASR 伺服器跨日變異（各組 ASR p95 412–1101 ms，隨片段變長而升）：

| preset（minSilence／chunkMin-chunkMax） | ASR p95 | 延遲 p50 | 延遲 p95 | ≤2500ms | 逐句CER | 語料CER | 沒上屏 | 判定 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| fast1000（150／700-1000） | 427 ms | 707 ms | **1111 ms** | 87.5% | 41.14% | 39.81% | **4/32** | 延遲前緣，但漏句不可接受 |
| fast1100（150／700-1100） | 412 ms | 985 ms | 1394 ms | 96.9% | 38.26% | 37.74% | 1/32 | 只比 1200 省 81 ms、CER +2.6 pp → 淘汰 |
| **fastv2（150／700-1200）** | 478 ms | 751 ms | 1475 ms | 96.9% | 37.44% | 35.16% | 1/32 | ✅ 快檔不變 |
| **new（250／700-1500）** | 505 ms | 1062 ms | 1715 ms | 100% | 38.63% | 35.01% | 0/32 | ✅ 正常不變（跨三輪 p95 1669/1701/1715，離散 46 ms） |
| **slow（500／1000-2400）** | 690 ms | 1405 ms | 2798 ms | 84.4% | 35.82% | 28.88% | 0/32 | ✅ BGM 上語料 CER 最佳 |
| slow3000（500／1000-3000） | 1101 ms | 2313 ms | 3093 ms | 56.3% | 39.44% | 29.84% | 0/32 | CER 反彈、ASR 變慢 → 2400 是拐點 |

### 第二輪調校矩陣 — 無 BGM 旁白素材（2026-10-01，九組）

前 300 s、18 段 Silero 參考。這輪第一次量到 `minSilence`/`chunkMin` 的真實效果：

| preset（minSilence／chunkMin-chunkMax） | VAD句界 | ASR p95 | 延遲 p50 | 延遲 p95 | ≤2500ms | 語料CER | 判定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| fast1000（150／700-1000） | 8 | 430 ms | 647 ms | 2735 ms* | 94.4% | 18.56% | *首句 ASR 1974 ms 尖峰主導 p95 |
| fastMin500（150／500-1000） | 12 | 438 ms | 573 ms | 1322 ms | 100% | 19.00% | chunkMin 500 放行 4 個較短天然句界 |
| fastv2（150／700-1200） | 12 | 507 ms | 1164 ms | 1534 ms | 100% | 13.99% | ✅ 快檔 |
| fast500x（150／500-1200） | 13 | 684 ms | 1219 ms | 2460 ms* | 100% | 14.23% | 與 700 無可測差異 → chunkMin 維持 700 |
| new（250／700-1500） | 0 | 527 ms | 1000 ms | 1776 ms | 100% | 12.19% | ✅ 正常 |
| cn350（350／700-1500） | 0 | 619 ms | 1274 ms | 2310 ms | 100% | 12.19% | 與 new 的 chunk 流完全相同 → minSilence 維持 250 |
| slow（500／1000-2400） | 2 | 773 ms | 1703 ms | 2911 ms | 72.2% | 10.27% | 2 個過早句界切斷 |
| **cs800（800／1000-2400）** | 0 | 753 ms | 1655 ms | 2738 ms | 83.3% | **8.35%** | ✅ **採用**（另場重跑同值 8.35%＝135/1616） |

（＊18 段參考下 p95 ≈ 最大值，易被單次 ASR 尖峰主導；此素材以 p50、語料 CER、句界數為判讀依據。）

關鍵觀察：`minSilence` 是天然句界的開關——150 ms 觸發 8–13 個、500 ms 觸發 2 個、250/350/800 ms 為 0（旁白停頓多在 150–250 ms）；`chunkMin` 只影響哪些句界真的送段（700 擋掉短於 700 ms 的句界）。實務素材 90–100% 走強制切段，**三速中只有「快」保有主動句尾偵測**。

## 判讀

1. **`chunkMax` 2400→1500 是延遲最大槓桿**：強制切段等待時間減半，對話素材 p95 2706→1669 ms；舊設定在兩種素材上都不達標。
2. **滑動 prompt 是唯一有效且零延遲成本的準度補償**：切段變短損失的跨段上下文，用上一段字幕當 prompt 補回——逐句 CER 41.14%→38.63%（追平舊設定的 39.07%）、空字幕 chunk 7→4、32/32 句全上屏、碎片化也最好（30 行、被切開 14 句）。與 Whisper 官方 long-form 解碼的 `<|startofprev|>` 實務作法一致。
3. **重疊 anchor 判定有害，不採用**：+600 ms payload 使 ASR p95 +157 ms，CER 反而 +3.5 pp（42.54%），前綴去重也補不回來。
4. **16 kHz 上傳無實測效益，不採用**：延遲與準度都與 48k 無差異（p95 反而略差，屬噪音），維持 48k 避免端點相容風險。
5. **BGM 素材下 `chunkMin`/`minSilence` 不參與運算**：VAD 句界恆為 0（old 設 500 ms 也是 0），所有差異全來自 `chunkMax` 與 prompt。原候選 `balanced`（1000/300）在此素材與 `newctx` 數學上等價，故未重跑；無 BGM 素材的驗證已由第二輪補齊（見上表）。
6. **快的前緣卡在「漏句」而不是延遲**：`chunkMax` 1000 在 BGM 素材漏 4/32 句（空 chunk 25 個）、CER +4.7 pp；1100 相對 1200 只省 81 ms p95 卻 CER +2.6 pp → 1200 是唯一合理點。無 BGM 素材上 `chunkMin` 500 vs 700 亦無可測差異（p50 1219 vs 1164 ms），維持 700。
7. **慢的語料 CER 拐點在 `chunkMax` 2400**：3000 讓 CER 28.88%→29.84% 反彈（ASR 對 3 s＋BGM 片段 p95 1101 ms 也變慢），不採。
8. **慢檔 `minSilence` 500→800**：無 BGM 素材語料 CER 10.27%→8.35%（重跑同值）、過早句界 2→0；BGM 素材句界恆 0，兩值同值（28.88% 不回歸）→ 採用 800。正常檔 250 vs 350 產生完全相同的 chunk 流，穩定性成立。

## 最終設定（已寫入產品碼）

### VAD／切段 — `src/renderer/src/features/capture/vad.ts`

對外不再暴露逐項參數，改為**三速預設組合** `responseSpeedVadConfig`；`defaultVadConfig` 即「正常」檔：

| 參數 | 舊滑桿預設 | **快** | **正常** | **慢** |
| --- | --- | --- | --- | --- |
| `minSpeechMs` | 120 | 120 | 120 | 120 |
| `minSilenceMs` | 500 | **150** | **250** | **800** |
| `preRollMs` | 300 | 300 | 300 | 300 |
| `noiseFloorOffsetDb` | 12 | 12 | 12 | 12 |
| `chunkMinMs` | 1000 | **700** | **700** | **1000** |
| `chunkMaxMs` | 2400 | **1200** | **1500** | **2400** |

三速皆經對話素材實測（前 300 s、32 句參考、BGM 導致全強制切段）：

| 速度 | 延遲 p50 | 延遲 p95 | ≤2500ms | 逐句CER | 語料CER | 字幕行 | 沒上屏 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 快 700/1200/150 | **760 ms** | 1759 ms* | 96.9% | 37.44% | 35.16% | 32 | 1/32 |
| 正常 700/1500/250 | 1029 ms | 1701 ms | **100%** | 38.63% | 35.01% | 30 | 0/32 |
| 慢 1000/2400/800 | 1532 ms | 2760 ms† | 84.4% | **35.82%** | **28.88%** | 32 | 0/32 |

\* 該輪 ASR p95 681 ms（他輪 472–504 ms）的伺服器尖峰所致；快檔的 chunk 等待上限（1200 ms）實質低於正常檔，p50 760 vs 1029 ms 為穩定差異。
† 「慢」檔定位就是犧牲延遲換穩定，p95 超過 2.5 s 屬預期選擇，不是缺陷。慢檔此表測於 `minSilence` 500——BGM 素材句界恆為 0，500 與 800 測值相同；無 BGM 素材的 800 優勢（語料 CER 8.35% vs 10.27%）見第二輪矩陣。

選型過程淘汰的組合：
- **快 500/1000/150**（首版）：p95 1223 ms 最快，但 1000 ms 短片在停頓處被 ASR 判空（25 個空 chunk），**4/32 句沒上屏**、CER +4.7 pp → 淘汰，改 700/1200 後空 chunk 17、沒上屏 1 句、CER 追平正常檔。
- **快 700/1100/150**（第二輪）：相對 1200 只省 81 ms p95、CER +2.6 pp → 淘汰。
- **慢 1000/3000/500**（第二輪）：語料 CER 反彈（29.84% vs 28.88%）＋ASR 變慢 → 淘汰，chunkMax 維持 2400。
- **快 chunkMin 500／正常 minSilence 350**（第二輪，無 BGM）：皆無可測差異 → 維持 700／250。
- 滾動 prompt、重疊 anchor、16 kHz 的取捨見上一節。

### 模型適配器 — `src/renderer/src/features/models/model-adapter.ts`

- **滑動上下文 prompt**（`rollingPrompt()`）：把**上一段成功字幕（清洗後）的尾 60 字**併入 API `prompt`，與使用者術語 prompt 以換行合併。
  - 僅在語言明確時啟用，自動語言模式不送，避免污染偵測。
  - Electron 走 `prompt` 欄位；Web 走 `x-s2t-prompt` header（`server/index.cjs` gateway 已支援）。
  - 每次成功辨識後更新，`start()` 時重置。
- **輸出清洗**（`sanitizeAsrText`）：Breeze-ASR-25 會洩漏 `<|8.59|>` 時間戳 token 與 `||` 分隔符，於 HTTP 與 WebSocket 兩路徑統一清掉（產品 bug 修正，也避免髒字回灌 prompt）。

### 明確不採用

- 重疊 anchor（+600 ms 前段音訊）：實測準度與延遲皆劣化。
- 16 kHz 上傳：無實測效益。

### 使用介面改版（滑桿移至收音控制）

- **移除舊滑桿**：設定頁 VAD 卡片（6 支滑桿＋「恢復預設值」鈕、`SliderField` 元件與其 CSS）與收音面板的 3 支 inline 滑桿（chunkMin/chunkMax/停頓斷句）全部刪除。
- **單一滑桿**：收音控制側欄新增「回應速度：快‑正常‑慢」三段滑桿（`AppView.tsx` `quick-settings-speed`），錄音中調整會自下一段音訊生效；含 `aria-valuetext` 與 tooltip 說明（`speedHint`）。
- **設定 schema**：`Settings.vadConfig` → `Settings.responseSpeed`（`'fast' | 'normal' | 'slow'`），renderer、Electron main（`sanitizeModelConfig`）、preload 型別三處同步；Web gateway 以整包 JSON 儲存無需變更。
- **舊版相容**：既存的逐項 `vadConfig` 參數在 `normalizeSettings` 自動丟棄、一律正規化為三速之一——所有既有使用者直接取得實測最佳組合，不再需要手動「恢復預設值」。

## 驗證紀錄

| 項目 | 結果 | 證據 |
| --- | --- | --- |
| TypeScript 型別 | 通過 | `npm run typecheck` |
| 模型適配器合約（含滑動 prompt 斷言：首段無 context、次段帶上一段文字、Web header 同步） | 通過 | `npm run model-adapter:smoke` |
| 翻譯排程策略 | 通過 | `npm run translation-policy:smoke` |
| VAD | 通過 | `npm run vad:smoke` |
| 新路徑（重疊 WAV／16k）可執行性 | 通過 | 60 s 煙霧跑（準度數字僅供路徑驗證） |
| 最終配置端到端確認跑（產品碼滾動 prompt 路徑，對話前 300 s） | **p50 1053 ms / p95 1714 ms / ≤2500 ms 100% / 逐句CER 38.63% / 語料CER 35.01% / 30 行**（與 wave1 的 newctx 吻合） | `npm run caption:eval -- --preset new --max-seconds 300`（`experiment/evaluation-reports/caption-latency-new-300s.json`） |
| 三速實測（快/快首版/慢） | 通過，數值見「回應速度三速」表 | `npm run caption:eval -- --preset fast,fastv2,slow --max-seconds 300` |
| 第二輪調校矩陣（BGM 六組同場＋無 BGM 九組＋慢檔重跑） | 通過，數值見「第二輪調校矩陣」兩節 | `--preset fast1000,fast1100,fastv2,new,slow,slow3000`（BGM）、`--preset fast1000,fastMin500,fastv2,new,cn350,slow,cs800` 與 `--preset fast500x,cs800`（無 BGM） |
| 慢檔 `minSilence` 500→800 改動回歸 | 通過 | `npm run typecheck` ＋ `vad:smoke`／`i18n:smoke`／`model-adapter:smoke` |
| 滑桿改版回歸（型別、i18n 五語系、adapter 含滾動 prompt 合約、storage、translation-policy、production build） | 通過 | `npm run typecheck` ＋ `node tests/smoke/*-smoke-test.cjs` ＋ `npm run build` |

## 已知限制與後續

1. **參考非人工逐字稿**：對話素材 CER 只能跨 preset 相對比較；若要絕對準度需人工校對 TSV。
2. **素材譜系仍偏極端**：歌曲與對話影片含 BGM（EnergyVad 全強制切段）；無 BGM 素材目前只有旁白一種、停頓偏短（150–250 ms）。「無 BGM ＋較長停頓（250–800 ms）」的素材（如會議錄音）尚未量測——該類素材上慢檔 `minSilence` 800 會比 500 最多晚 300 ms 偵測句尾，屬可接受的準度換取，但屬未驗證組合。
3. **快檔可能偶漏 1 句**：停頓處的短片偶爾被 ASR 判為空輸出（實測 32 句漏 1）；這是快檔「較短片段換延遲」的固有代價，若漏句不可接受就選正常檔。
4. **慢檔 p95 2760 ms 超過 2.5 s 屬設計選擇**：換取最佳準度（語料CER 28.88%）與完整上屏；2.5 s 目標由預設的「正常」與「快」檔達成。
5. **P95 上限來自 request/response 架構**：切段等待（≤ chunkMax）＋ ASR 推論（p95 約 470–700 ms，偶發尖峰 >1 s）。正常檔對話素材 P95 1701 ms、餘裕約 800 ms；若日後要逼近更低延遲或降低尾部尖峰，需 partial/增量架構，屬「改 API」範疇，本次不動。
6. 歌曲素材的 CER 為清洗與 prompt 產品化之前的舊跑，數字不可跨輪比較。

## 重現指令

```bash
# 產生標準答案 TSV（Silero VAD 區間 + 逐段 ASR 文字）
npm run caption:reference -- --audio "music/xxx.mp3" [--max-seconds 300]

# 跑評測（presets: old/new/fast/fastv2/slow/slow3000/fast1000/fast1100/fast500x/
#   fastMin500/cn350/cs800/newov/new16k；滾動 prompt 與清洗由產品碼自動生效）
npm run caption:eval -- --audio "music/xxx.mp3" --tsv "music/xxx_句級Speaker時間軸.tsv" \
  --max-seconds 300 --preset old,new
```

報告 JSON 存於 `experiment/evaluation-reports/`。
