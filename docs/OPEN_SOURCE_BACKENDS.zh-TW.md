# 語音處理技術參考與自有模型整合方案

本文件取代先前的引擎採用方案。**使用者提供自己的模型；本 repo 參考 faster-whisper 與 sherpa-onnx 的語音處理思路，實作可對接自有模型的應用層。** 文件沿用原路徑，以維持既有連結有效。

不指定這兩個套件、預訓練模型、Python、ONNX、CTranslate2、GPU 或部署位置。以下為規劃，尚未實作；引擎特有功能不視為自有模型已支援的能力。

## 1. 參考內容與實際整合範圍

| 技術參考 | 可借鏡的處理思路 | 本 repo 規劃的模組 |
| --- | --- | --- |
| faster-whisper 的 VAD 與段落處理 | 語音區間、切段參數、靜音處理與原音訊位置對應 | SpeechSegmenter、TimelineMapper |
| faster-whisper 的 segment／word 時間戳 | 統一辨識結果結構，供字幕定位、回放及匯出 | TranscriptAssembler、SubtitleExporter |
| faster-whisper 的批次轉錄 | 區分直播延遲與離線吞吐需求 | 有上限的任務佇列；檔案轉錄列後續 |
| sherpa-onnx 的串流／非串流區分 | 依模型能力採取不同音訊送入與結果更新方式 | ModelAdapter、capabilities |
| sherpa-onnx 的串流生命週期 | 開始、送入音訊、取得更新、端點判定、收尾、重置 | SessionController |
| sherpa-onnx 的 VAD、標點等分工 | 將處理步驟模組化、按能力啟用 | 可選前後處理介面 |

參考來源：[faster-whisper 官方 README](https://github.com/SYSTRAN/faster-whisper)、[轉錄程式碼](https://github.com/SYSTRAN/faster-whisper/blob/master/faster_whisper/transcribe.py)、[sherpa-onnx 官方 README](https://github.com/k2-fsa/sherpa-onnx)、[官方文件](https://k2-fsa.github.io/sherpa/onnx/index.html)。

滑動視窗、穩定前綴、跨請求版本控制與背壓是本專案的整合設計，不宣稱為兩個 repo 都直接提供的完整功能。此處以自行實作介面與流程為範圍；若未來確定要移植某段上游程式碼，另外記錄檔案、版本與必要授權聲明。

## 2. 應用與模型的責任邊界

本 repo 負責收音、裝置切換、音量條、錄音保存、格式轉換、傳輸、字幕組裝、翻譯對齊、錯誤狀態及匯出。模型端負責辨識與其提供的翻譯／時間戳等推論結果。

是否需要 VAD、重採樣或應用端切段，必須從模型介面決定。若模型已提供端點事件，優先沿用，避免兩邊獨立切段造成漏字。若需要額外 VAD，先定義可替換的 VadProvider；其實作或模型來源待確認，不默認使用 Silero 或上述 repo。

音量條直接從 PCM 計算 RMS／peak；音量門檻不能被當成準確的語音活動偵測。

## 3. 預定架構

```text
音源 → AudioCapture → 共用 PCM
                       ├─ LevelMeter → 音量條
                       ├─ RecordingWriter → 本機 WAV
                       └─ AudioProcessor（依模型格式轉換）
                            → Segmenter（按需啟用）
                            → ModelAdapter → 使用者自有模型
                                                ↓
                                 原文／譯文／時間戳事件
                                                ↓
                          TranscriptAssembler → 字幕與逐字稿
                                                ↓
                         TranslationAdapter（若需獨立翻譯）
```

應用層採 Electron + TypeScript。ModelAdapter 只封裝實際需要的傳輸：已有 WebSocket 串流服務則使用 WebSocket；HTTP 片段服務則使用請求佇列；本機 SDK／程序只有在自有模型需要時才安排獨立 worker／程序。實際協定以使用者介面為準，不為抽象介面先實作所有傳輸方式。

模型無法使用時仍能錄音、查看音量與保存音檔，字幕區顯示具體狀態。

## 4. 音訊管線

- 收音與推論分開：音源只擷取一次，錄音保留完整時間軸；VAD 不能刪掉原始錄音的靜音。
- 模型格式依契約設定：sampleRate、channels、PCM 位元深度／浮點格式或壓縮容器。實際重採樣，不只改標籤。
- 分塊長度可設定：以模型要求及傳輸效率決定，不先硬編碼 16 kHz 或固定 chunk 大小。
- 每塊記錄 sequence、startSample、frameCount 與 streamId。來源時鐘及模型輸入時鐘透過 offset／採樣率映射。
- 切段保留前後緩衝與長句上限。裁切後時間戳需還原到錄音時間軸。
- 限制佇列與在途請求；延遲過高時顯示狀態，超限標記缺口。補送要依模型去重／續傳能力決定。
- 暫停、切換音源及停止均有 flush／reset 語意；切換前後結果不得混入同一串流狀態。

## 5. 模型適配契約（本 repo 內部格式草案）

外部 API 不必長得相同，由適配器轉換；此表不是要求使用者重寫模型服務。

| 類別 | 所需資訊 |
| --- | --- |
| capabilities | 串流或片段輸入、可否回傳 partial／final、支援格式、語言、時間戳精度、翻譯能力 |
| session | sessionId、streamId、語言、音訊格式、模型識別資訊（若有） |
| audio | sequence、startSample、frameCount、音訊內容 |
| result | segmentId、revision、partial／final、原文、可選譯文與時間範圍 |
| translation | segmentId、sourceRevision、目標語言、譯文、狀態 |
| control | start、flush、stop、cancel；映射到現有 API 支援的操作 |
| failure | requestId、錯誤類型、可否重試、最後已確認區間（若有） |

若模型缺少 segmentId，由適配器按請求與音訊區間建立。若模型缺少時間戳，先以送入片段的起訖作粗略段落時間，標記 timestampSource=segment-boundary；不能宣稱詞級對齊。時間精度不足時，SRT 驗收需另測並揭露限制。

## 6. 即時字幕與翻譯

原生串流：同一段 partial 以更新取代追加，final 才提交；依序號處理亂序與重複回應。

片段模型：端點切段後取得句子結果。若模型允許重複辨識未完成片段且效能足夠，再評估滑窗重疊及穩定前綴。只會句末回傳的模型，不能承諾句中字幕；先量測是否滿足使用者的即時要求。

翻譯可以由自有模型同時回傳，或對接使用者指定的獨立端點。TranslationAdapter 是邏輯邊界，不強制增加另一個服務。模型能力未明前不選第三方翻譯商。

原文修改即增加 revision；譯文與 sourceRevision 綁定，過期結果丟棄或留在歷史。暫定譯文明示會修訂；翻譯失敗保留原文，提供待處理狀態。停止時有限度等待尾段，超時保留未完成標記，不無限阻擋音檔保存。

會後重轉錄及第二輪複核皆非首版必要項；只有使用者模型提供相應能力並有明確需求時再安排，保留原稿與人工編輯版本。

## 7. 階段與驗收

| 階段 | 工作 | 驗收 |
| --- | --- | --- |
| 1A | 共用收音、音量條、切換、分塊、保存、內部契約 | 真實音訊可錄可播，樣本時間連續，緩衝有上限 |
| 1B | 對接自有模型，確認串流與翻譯能力 | 真實原文／譯文、延遲量測、時間戳映射 |
| 2 | 切段與字幕穩定、版本管理、暫停、匯出 | 五項核心需求端到端通過 |
| 3 | 60 分鐘錄製、故障／重連、歷史回放、跨平台打包 | 不因模型失敗丟失已保存錄音，不出現重複／倒退字幕 |
| 後續 | 系統音、浮動字幕、檔案轉錄及模型延伸能力 | 各自設定驗收條件 |

可用模擬適配器驗證亂序、重複、超時、取消和背壓；它只服務工程測試，不作辨識完成的驗收證據。使用同一組音訊分別測量模型原始輸出與應用整合輸出，區分模型錯字與應用切字／漏段問題。

首批整合需要使用者模型的 API／SDK 範例、輸入格式、回應格式、認證方式、部署位置與翻譯能力。未取得前仍可完成 1A；真實字幕驗收須待介面可用後進行。工時在介面確認後估算。
