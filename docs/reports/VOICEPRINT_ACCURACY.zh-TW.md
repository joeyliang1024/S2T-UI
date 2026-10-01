# 聲紋比對準確度與 CPU 成本優化計畫

> 依據 sherpa-onnx 原始碼（`sherpa-onnx/csrc/`）與本專案現況的對照分析。
> 對應 `0930_plan.md` 的「聲紋品質」與「音訊前處理」章節。

---

## 一、sherpa-onnx 的做法（我們要對齊的基準）

### Diarization 管線（`offline-speaker-diarization-pyannote-impl.h`）
1. pyannote segmentation，滑動 window 切 chunk，powerset multi-label。
2. `ExcludeOverlap()`：**重疊發言的幀整幀剔除**，不參與 embedding。
3. 每個 `(chunk, speaker)` 各算**一筆** embedding；該 speaker 幀數 `< 10` 跳過；**NaN 丟棄**。
4. 聚類 `fast-clustering.cc`：每列 L2 正規化 → 距離 `1 - cosine` → **complete-linkage** → 用 `num_clusters`（已知人數時優先）或 `threshold`（預設 0.5）切樹。
5. `min_duration_on` 預設 **0.3s**、`min_duration_off` 預設 **0.5s**（過濾與合併）。
6. 可選 `compute_confidence`：每個 embedding 的 **silhouette** → 與 segment 重疊區間平均 → 該段信心值。

### 識別（`speaker-embedding-manager.cc` + 官方 demo）
- 註冊：`Add(name, vector<vector<float>>)` = **多樣本 embedding 相加（等價平均）→ L2 正規化 → 存一筆**。
- 比對：query L2 正規化 → 內積（cosine）→ 取 max → 與 threshold 比較；官方 demo `--threshold` **預設 0.5**。
- **沒有 margin、沒有共識機制**（這兩項是我們自己加的，方向正確但目前數值未校正）。

---

## 二、現況根因診斷

| # | 根因 | 位置 | 影響 |
|---|---|---|---|
| R1 | 把一個 SPEAKER_XX **整場所有 segment 串成一條**只算 1 筆 embedding | `server/sherpa-diarization.cjs:107-129` | 分群錯誤時 = 混合向量 → 全線掉分（拒識）或飄到別人（錯配）；**也是最大 CPU 浪費**（輸入可能幾十分鐘） |
| R2 | 查詢端**沒有** ExcludeOverlap / 短段過濾 / NaN 檢查 / 信心值 | 同上 | 重疊、短促、噪聲段污染 embedding |
| R3 | 註冊僅 **1 筆、3 秒**、品質檢查只有 rms/duration/削波 | `index.cjs:733-744`、`sherpa-diarization.cjs:41-51` | 同人分數變異大；無 VAD 語音比與 SNR 檢查 |
| R4 | 註冊音訊（乾淨麥克風）vs 比對音訊（會議、可能經 dynaudnorm/denoise/遠端混音）**音訊域不一致** | 兩端前處理不同 | 同人分數系統性偏低 |
| R5 | `threshold=0.65`、`margin=0.05` **無資料支撐** | `index.cjs:245-248` | 太高→漏標、太低→錯配 |
| R6 | diarization `threshold:0.5` 固定、`minDurationOn/Off=0.25/0.35` 比預設更短、未開 confidence | `sherpa-diarization.cjs:70-74` | 上游分群更雜、碎段流入比對 |
| R7 | `identityCandidates` 對同 NT 取 **max** | `voiceprint-matching.cjs:2-10` | 註冊筆數越多越易被噪聲樣本拉高 |
| R8 | `resampleMono` 無 low-pass 線性插值 | `sherpa-diarization.cjs:26-35` | 48k→16k alias，輕微傷 embedding |

### CPU / 排程根因
| # | 根因 | 位置 | 影響 |
|---|---|---|---|
| C1 | Silero **逐 32ms 一次 `session.run`、掃全檔、回傳全量 `probabilities`** | `silero-vad.cjs:45-51,69` | 1 小時 = 112,500 次呼叫 + 112,500 物件跨 thread 序列化 |
| C2 | 每次 VAD 都 `readFileSync` + sha256 整個模型檔 | `silero-vad.cjs:36→13-15` | 每 job 重複讀檔雜湊 |
| C3 | 單一 pool：`size=1`、`maxQueue=8`、`timeout=120s` 固定、**無搶佔** | `sherpa-worker-pool.cjs:13,65-79` | 一個巨型 background job 期間，註冊/VAD 只能在佇列插隊但無法中斷進行中 job；長會議可能逾時被砍 |
| C4 | **每個 job 都複製整份 WAV**（structured clone + `Buffer.from` 第二次複製） | `sherpa-worker.cjs:25` | 一場會議 N+2 次全檔複製 |
| C5 | VAD、比對、embedding 分散成多個 job | 各自 `pool.execute` | 每步都要重新排隊、重新序列化音訊 |
| C6 | 聲紋標註在 `/api/diarizations` **同步**執行 | `index.cjs:877-881` | 佔住 worker，拖慢 diarization 回應 |

---

## 三、目標

1. **準確度**：錯配率（把 A 標成 B）大幅下降；寧可拒識維持 `SPEAKER_XX`，絕不錯配。
2. **CPU 時間**：標註流程總耗時 `≤ 音檔時長 × 0.2`（可配置預算）；註冊與 VAD 的互動延遲不被長任務拖垮。
3. **可量測**：所有參數（門檻、margin、塊數、預算）依實測分佈決定，不猜。

---

## 四、分期計畫

### P0 — 量測基線（先做，決定後續一切數字）
| 任務 | 改動點 | 內容 |
|---|---|---|
| P0-1 | `sherpa-worker-pool.cjs` | `stats()` 擴充 per-operation 統計：`count / totalMs / totalAudioSec / RTF`（sileroVad、extractEmbedding、diarizeWav、dynaudnorm） |
| P0-2 | `index.cjs`（labelDiarizationTurns） | 每次比對記錄 `top1、top2、margin、語音總時長、segment 數、決策結果` |
| P0-3 | `scripts/eval-voiceprint.*`（新） | 評測腳本：輸入標註音訊（檔案 + 正確 NT）→ 輸出 **錯配率 / 拒識率 / 正確率 + score 分佈** |

**驗收**：跑一次真實會議可取得各 op 的 CPU 秒與 RTF；有一條可重複執行的評測指令。

### P1 — 查詢端改分層共識（準確度主戰場，不動資料結構）
| 任務 | 改動點 | 內容 |
|---|---|---|
| P1-1 | `sherpa-diarization.cjs:107-129` | 廢除「串接全場」：改為每個 speaker 取**最長 3 塊**，每塊 cap `10~15 秒`有效語音、總量 cap `45 秒`；有效語音 `< 8 秒` 直接不比對（維持匿名） |
| P1-2 | 同上 | 每塊先 **能量粗篩**（零成本），必要才呼叫 Silero；過濾 `<1s`、低能量、削波、疑似重疊段 |
| P1-3 | `index.cjs:343-351` | **Stage-1 粗篩**：只用 block#1 查向量層 top-3 身份 → **Stage-2 驗證**：只對 top-3 比 block#2/#3 |
| P1-4 | 同上 | 決策：`median ≥ threshold` **且** 命中段數 `≥ 2` **且** `top1-top2 ≥ margin` → 標 NT，否則維持 `SPEAKER_XX` |
| P1-5 | 同上 | **Early exit**：block#1 `≥ 0.75` 且領先第 2 名 `≥ 0.15` → 直接標，跳過後續塊 |
| P1-6 | `sherpa-diarization.cjs` | 每次 embedding 加 `(輸入秒數, ms)` log |

**驗收**：P0-3 評測的錯配率下降；embedding 推論輸入總秒數**低於現況**；未命中一律維持匿名。
**風險**：低。純邏輯替換，不動資料結構、不需重新註冊。

### P2 — Silero 與 worker 成本
| 任務 | 改動點 | 內容 |
|---|---|---|
| P2-1 | `silero-vad.cjs` | `modelStatus()` 結果快取（啟動時算一次 sha256） |
| P2-2 | `silero-vad.cjs:69` | 預設只回 `speech` 區間，`probabilities` 改 opt-in（debug） |
| P2-3 | 新 `labelSpeakers` op | VAD 只跑 P1-1 選出的候選塊，**不掃全檔** |
| P2-4 | `silero-vad.cjs:28` | ORT session 設 `intraOpNumThreads: 1`（小模型多線程反有開銷） |
| P2-5 | `sherpa-diarization.cjs:72,88` | 明確設定 `numThreads`；heavy（diarize/embedding）可調 2~4，fast 保持 1，避免多 worker × 全核互搶 |
| P2-6 | `sherpa-worker-pool.cjs` | **分兩個 pool**：`fast`（sileroVad、dynaudnorm、assess、status）與 `heavy`（diarizeWav、extractEmbedding） |
| P2-7 | `sherpa-worker-pool.cjs` | timeout 依輸入長度計算（如 `min(300s, 音檔秒數 × 0.5)`），取代固定 120s |
| P2-8 | `sherpa-worker.cjs` | **音訊駐留 worker**：`loadAudio` 一次複製 → 後續 op 以 `audioId` 引用 → `releaseAudio`；全檔複製 N+2 → 1 |

**驗收**：P0-1 顯示 Silero CPU 秒大幅下降；註冊/VAD 的互動延遲不再被長任務阻塞；單一 job 失敗只影響單一 speaker。
**風險**：中（P2-6/P2-8 涉及排隊與生命週期）。建議 P2-1~P2-5 先行，P2-6~P2-8 獨立一輪。

### P3 — 聲紋庫資料模型：一身份一列平均向量
| 任務 | 改動點 | 內容 |
|---|---|---|
| P3-1 | `index.cjs` POST `/api/voiceprints` | 同身分多次註冊 → `normalize(Σ sample 向量)` 存**單列**；原始 sample 向量存 PostgreSQL/config（補註冊時重新平均，不必重錄） |
| P3-2 | `index.cjs` | `S2T_VOICEPRINT_EMBEDDING_VERSION` → `sherpa-onnx-v2-mean`：舊向量自動退出比對，**強制重新註冊**（沿用既有 model/version 門檻機制，避免跨版本錯配） |
| P3-3 | `voiceprint-matching.cjs` | 一身份一列後，top1/top2 天然不同人；NT 分組保留當保險，`max` 可改為「平均或 best」並重新校正門檻 |
| P3-4 | 註冊品質 | 最低時長 3s → **≥10 秒有效人聲**；加 VAD 語音占比（如 ≥60%）與 SNR 檢查；註冊與比對走**同一前處理分支**（消 R4 域不一致） |

**驗收**：向量層列數 = 身份數；重新註冊後評測分數分佈明顯收斂。
**風險**：中（需全員重註冊）。**先確認 P1 的效果再決定是否需要此項**。

### P4 — 排程與門檻校正
| 任務 | 改動點 | 內容 |
|---|---|---|
| P4-1 | `index.cjs:853-882` | 聲紋標註改 **background**：`/api/diarizations` 先回 `SPEAKER_XX`，標註完成回填（對應 0930_plan「即時字幕優先於聲紋」） |
| P4-2 | 標註 job | **per-speaker 小 job** + `hash(audioKey+speaker+segments)` 快取（重試/重算不重跑）；依講話總時長排序，時間預算用完即停、剩餘保持匿名 |
| P4-3 | `index.cjs:245-248` | 依 P0-3 的分佈**校正 `threshold` 與 `margin`**（選定目標錯配率），取代 0.65/0.05 |
| P4-4 | `sherpa-diarization.cjs:70-74` | `clustering.threshold` 調小（更碎、對識別更安全）；已知人數時給 `numClusters`；`minDurationOn/Off` 回 0.3/0.5 或更長；評估開 `compute_confidence` 拒絕低信心段 |
| P4-5（選） | 模型 | 若 P0 量測顯示 embedding 是瓶頸：換更快模型（如 CAM++ 192 維），靠既有 version 機制安全遷移（需重註冊） |

**驗收**：`錯誤率/拒識率` 達成目標且可重複；標註總耗時在預算內；互動 op 延遲 P95 不受長任務影響。

---

## 五、執行順序與依賴

```
P0 量測基線
 ├─→ P1 分層共識（低風險，先拿準確度）
 │     └─→ P3 聲紋庫改造（視 P1 成效決定是否需要）
 └─→ P2-1~P2-5 Silero/線程小改（低風險，與 P1 並行）
       └─→ P2-6~P2-8 分池 + 拆 job + 音訊駐留
             └─→ P4 排程 background + 門檻校正（依 P0/P3 數據）
```

**建議第一輪範圍**：P0 + P1 + P2-1~P2-5。
理由：不動資料結構、不需重新註冊、同時改善準確度與 CPU 時間，且風險可控。

---

## 六、環境變數（既有，調整用）

```
S2T_VOICEPRINT_THRESHOLD        # 目前 0.65，P4-3 校正後更新
S2T_VOICEPRINT_MARGIN           # 目前 0.05，P4-3 校正後更新
S2T_SHERPA_WORKERS              # 預設 1，分池後 heavy 可設 2（務必搭配 P2-5 線程限制）
S2T_SHERPA_MAX_QUEUE            # 預設 8
S2T_SHERPA_JOB_TIMEOUT_MS       # 預設 120_000，P2-7 改為依輸入長度
S2T_VOICEPRINT_EMBEDDING_VERSION # P3-2 提升版本號觸發重新註冊
```

---

## 七、非目標 / 前提

- 不承諾具體改善幅度，依 `0930_plan.md`：**無標註資料不宣稱改善幅度**。
- P0-3 評測需要**授權的標註音訊**（同人/異人 pair）；沒有資料就只做機制，不填數字。
- 不在本計畫處理：100 路即時字幕延遲、K8s 多副本（屬 0930_plan 其他章節）。

---

## 八、第一輪執行情況

**範圍**：P0 + P1 + P2-1～P2-5（不動資料結構、不需重新註冊）。

### 已完成

| 任務 | 狀態 | 實作位置 |
| --- | --- | --- |
| P0-1 per-operation CPU 統計 | ✅ | `sherpa-worker-pool.cjs` `stats().ops`（count / totalMs / maxMs / avgMs / audioSec / audioMB / rtf），`resetStats()` 可清零 |
| P0-2 比對決策 log | ✅ | `index.cjs` `[voiceprint]` 一行 JSON：speaker、speechMs、blocks、decision、path、top1/top2、margin、hits、reason、ms，末尾 `summary`（extractionMs / totalMs） |
| P0-3 評測腳本 | ✅ | `scripts/eval-voiceprint.cjs`（`npm run voiceprint:eval`）：同人／異人分數分佈、EER、指定門檻下的正確／錯配／拒識率 |
| P1-1 區塊取樣取代全場串接 | ✅ | `sherpa-diarization.cjs` `extractDiarizedSpeakerBlocks`；每塊 ≤15 s、每人 ≤3 塊／45 s |
| P1-2 能量與長度粗篩 | ✅ | 段 <1.5 s、塊 <5 s、RMS < -45 dBFS 一律不進模型；總語音 <8 s 不比對 |
| P1-3 分層搜尋 | ✅ | 第一塊全庫搜尋 → 其餘塊僅對 top-3 身份複驗（`voiceprint-matching.cjs` `findMatches` 回傳原始列，供後續指定 id 查詢） |
| P1-4 共識決策 | ✅ | `voiceprint-matching.cjs` `decideIdentity`：中位數 ≥ 門檻 且 命中塊數 ≥ `MIN_BLOCKS` 且 領先 ≥ margin |
| P1-5 early exit | ⚠️（見偏差） | `fastMatch`：第一塊達 0.75 且領先 0.15 即命中，**跳過 stage-2 向量搜尋** |
| P1-6 embedding 計時 | ✅ | `[voiceprint-embed] {speaker, block, inputSec, ms}` |
| P2-1 sha256 快取 | ✅ | `silero-vad.cjs` 依 path+mtime+size 快取 `modelStatus()` |
| P2-2 機率幀 opt-in | ✅ | 預設只回 `speech`；`?frames=1` 或 `includeProbabilities` 才回；內部改用 `Float32Array` 不再逐幀建物件 |
| P2-3 Silero 只跑候選塊 | ✅（預設關） | `S2T_VOICEPRINT_VAD=1` 啟用，只分析選出的塊，永不掃全檔 |
| P2-4 ORT 線程 | ✅ | Silero session `intraOpNumThreads: 1` |
| P2-5 sherpa 推論線程可調 | ✅ | `S2T_SHERPA_INFER_THREADS`（預設 2），套用於 segmentation / embedding 兩處模型 |

### 未完成（下一輪）

- **P3** 聲紋庫改「一身份一列平均向量」＋ version bump
- **P4** 標註改 background / per-speaker job、依分佈校正門檻、diarization 參數
- （P2-6～P2-8 已於第二輪完成，見第九節）

### 與計畫的偏差（刻意）

1. **P1-5 的 early exit 只在評分層生效**：P2-8（音訊駐留）尚未實作，拆第二個 worker job 代表整份音檔要再 structured clone 一次，代價大於省下的 1～2 次短推論。因此本輪維持**單一 job**，early exit 用來省掉 stage-2 的向量搜尋；待 P2-8 完成後可升級為推論層 early exit。
2. **P2-3 的 Silero 門檻預設關閉**：能量閘已先過濾，第一輪不額外引入 CPU。需要更高精度時以 `S2T_VOICEPRINT_VAD=1` 開啟。第二輪新增**預設開啟的錄音層否決**（第九節），兩者並存：前者逐塊比例、後者整份錄音。

### 執行中發現並修正

- **分塊未真正封頂**：原本單一長 segment（例如 20 分鐘獨白）會整段變成一個區塊，等於沒有 15 秒上限。已改為對單一 segment 也做切片（`buildSpeakerBlocks`），並在 `voiceprint-blocks-smoke-test.cjs` 加了 40 秒單一轉段切成 3 塊的回歸測試。
- **無可見聲紋時仍浪費推論**：舊流程即使沒有任何可比對聲紋也會跑 embedding。現在在 `labelDiarizationTurns` 開頭直接 return。

### 實測（本機 CPU，`npm run` 可重現）

```
[voiceprint-embed] {"inputSec":15,"ms":486}   # 15 秒輸入 ≈ 0.5 s
[voiceprint-embed] {"inputSec":9,"ms":203}
# 端到端（19.27 s、兩講者、已註冊 1 人）：
#   SPEAKER_00(Daniel) → accept path=fast score=0.995 → "alice"
#   SPEAKER_01(Amira)  → reject reason=below-threshold top1=0.166 → 維持 SPEAKER_01
#   extractionMs=435 totalMs=437
```

### 下一步建議

1. 用**真實標註音訊**跑 `npm run voiceprint:eval`，依分佈設定 `S2T_VOICEPRINT_THRESHOLD` / `MARGIN`（這是 P4-3，也是唯一能證明改善的方式）。
2. P2-6～P2-8：分池、依長度 timeout、音訊駐留。
3. 視 P1 成效決定是否執行 P3（需全員重新註冊）。

---

## 九、第二輪：P2-6～P2-8、第一份標註評測、Silero VAD 根因

### 9.1 已完成

| 任務 | 狀態 | 實作位置 |
| --- | --- | --- |
| P2-6 分池 | ✅ | `sherpa-worker-pool.cjs`：`interactivePool`（Silero VAD、註冊、status）與 `heavyPool`（diarization、聲紋區塊）分離；`/metrics` 以 `pool=` 標籤分開 |
| P2-7 依輸入長度 timeout | ✅ | `60s + 音訊秒數 × 3s`，上限 `S2T_SHERPA_JOB_TIMEOUT_MS`（預設 600 s）取代固定 120 s；status 類 op 固定 10 s |
| P2-8 音訊駐留 | ✅ | 以 **Buffer 本身**（`WeakMap`）當 audioId 的 key，同一份錄音的第二次呼叫不再跨 thread 複製；`extractSpeakerBlocks transferredBytes = 0`；worker 端 audio cache（TTL／數量／MB 可調）＋ `AUDIO_MISSING` 重試 |
| Silero VAD 喂法修正 | ✅ | 見 9.3，`npm run silero:vad:smoke` |
| 錄音層否決 | ✅（預設開） | 見 9.4，`S2T_VOICEPRINT_AUDIO_VAD` |

新增／更新測試：`sherpa:residency:smoke`、`silero:vad:smoke`、`voiceprint:blocks:smoke`（加入否決斷言）、`gateway:auth-smoke`（更新 pool 指標斷言）。

**自己寫出來又修掉的三個 bug**：`/metrics` 的 op 指標輸出 `[object Object]`（未展開物件）、pool 統計被 MB 四捨五入吃掉（改回 raw bytes）、`audioId` 每次呼叫都新生成導致駐留永遠 miss（改以 Buffer 身分為 key）。

### 9.2 第一份有 ground truth 的評測（P0-3 落地）

素材：`music/梁山伯與茱麗葉_句級Speaker時間軸.tsv`（句級 start/end/speaker，曹格、卓文萱，含和聲標記）＋ 對唱 MP3（16 kHz mono WAV，238.4 s）。
工具：`npm run voiceprint:eval:timeline -- --tsv <檔> --audio <檔>`（註冊前 4 句、其餘 25 句為測試集，和聲句另計；同一句永不會與自己比對）。

**對照組（純語音 TTS）先驗證工具本身**：same 0.839 / diff 0.145，門檻 0.65 下正確率 100 %。

**對唱素材（唱歌＋配樂）**：

```
same-singer    n=144  min 0.017  median 0.480  max 0.876
diff-singer    n=156  min 0.010  median 0.476  max 0.942
EER = 0.48（等同隨機猜測）
門檻 0.65 / margin 0.05：正確 2/25 (8 %)、錯配 1/25 (4 %)、拒識 22/25 (88 %)
```

任何門檻都救不了（0.65 時 pair-FAR 0.135、pair-FRR 0.896）→ **唱歌＋配樂對語音型 speaker embedding 是無訊號領域**，不是門檻問題。另外量到誤標機制：**純樂器間奏對註冊向量拿到 0.702 分**（> 0.65、領先 0.144）→ 依規則會被標成身分，完全是配樂造成。

> 結論：這是**領域外的壓力測試**，不能用來宣稱會議／口說場景的錯配率；但它證明了「沒有標註就不能調門檻」以及「音樂素材需要前置否決」。

### 9.3 Silero VAD 從未偵測到語音（根因與修正）

官方 wrapper 是餵 **64 樣本 context + 512 樄窗 = 576 樣本**；本專案只餵 512，**不會報錯**但 recurrent state 追不到語音，機率全部塌成 ~0.003（官方原話：*probabilities stay near zero*）。後果：

1. UI 勾「使用 Silero VAD」→ `model-adapter.ts` 判定無語音就**直接丟棄該段、不送 ASR** → 字幕完全不出。
2. `S2T_VOICEPRINT_VAD=1` 門檻會把**所有**區塊（含正常語音）全部否決 → 100 % 匿名。
3. `/api/audio-processing/silero-vad` 永遠回 `speech: []`。

修正後實測（`server/silero-vad.cjs`，回歸測試 `npm run silero:vad:smoke`）：

| 素材 | 語音比例（修正前） | 語音比例（修正後） |
| --- | --- | --- |
| 語音 TTS-A / TTS-B | 0.000 / 0.000 | **0.997 / 0.983** |
| 音樂前奏 | 0.000 | 0.000 |
| 唱歌（曹格主歌） | 0.000 | 0.233 |
| 對唱整首 | 0.000 | 0.024 |

### 9.4 錄音層否決（新預設，使用者決定）

**一次 Silero 掃描整份錄音（RTF ≈ 0.003），若「語音總時長 < 10 s」且「語音比例 < 5 %」（兩個條件同時成立）就跳過整輪聲紋標註**，回 `vetoed: true`、log 理由 `recording-no-speech`。理由：音樂素材的聲紋分數不可信（9.2），而真實對話的語音比例是數十百分比，兩個條件並用可避免誤傷安靜但真實的錄音。

- 開關與門檻：`S2T_VOICEPRINT_AUDIO_VAD`（預設 1）、`_MIN_SEC`（10）、`_MIN_RATIO`（0.05）
- 逐塊比例門檻 `S2T_VOICEPRINT_VAD=1` 仍為選配，兩者並存
- 放在 `extractDiarizedSpeakerBlocks`（heavy worker 內、免額外複製音訊），因為 diarization 產出的分段是 API 本身的答案，不屬於聲紋路徑，不因此省下
- 單元測試：`shouldVetoRecording` 為純函式，`voiceprint-blocks-smoke-test.cjs` 另以「大聲但無語音」素材驗證整合行為，並以真實語音 fixture 驗證不會誤否決

### 9.5 對唱素材的 CPU 壓力測試（238.4 s，本機 CPU）

| Op | CPU 時間 | RTF | 說明 |
| --- | --- | --- | --- |
| `sileroVad` | 0.83 s | 0.003 | 首個語音 00:24.9、5 區間／5.8 s voiced |
| `diarizeWav` | 38.0 s | 0.159 | 39 段、**8 個說話者（真值 2）** |
| `extractSpeakerBlocks` | 3.4 s | 0.022 | 156 s 輸入、`transferredBytes = 0` |

分離度（標籤取自 diarization 分群，非 ground truth）：同群 median 0.706、異群 median 0.547，仍有重疊。2 位歌手被分成 8 群 → 唱歌是 pyannote 的已知弱項；CPU 上 diarization 佔整條流程約 90 %，是下一輪（P4）的主戰場。

### 9.6 下一步

1. **口說標註資料**（任何有時間軸的對話／會議錄音）→ 才能算真正的錯配率／拒識率並校正 `S2T_VOICEPRINT_THRESHOLD` / `MARGIN`（P4-3）。唱歌素材已證明無法校正門檻。
2. **P4-2** per-speaker job ＋ hash 快取 ＋ 時間預算，把 38 s 的 diarization 移出請求路徑。
3. **P3** 一身份一列平均向量（dev 無註冊，version bump 零風險）。
4. **P4-1** 標註改 background（會改變前端4 處同步 POST 消費，需先確認輪詢行為）。
