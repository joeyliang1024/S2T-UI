# -*- coding: utf-8 -*-
from pathlib import Path
import json,csv,hashlib,sys
root=Path(__file__).resolve().parents[2];out=root/'outputs/diarization';data=json.loads((out/'final-comparison.json').read_text());cache=json.loads((out/'comparison.json').read_text());rows=data['rows']
lines=['# 長時間講者分離：調查與獨立實驗',
'', '日期：2026-10-04。使用者指定專案 `tmp/` 素材；本輪不修改正式程式、設定或專案依賴。模型全部本機推論，沒有傳送音訊到外部端點。',
'', '## 建議與證據',
'', '**目前更值得採用的方向是：持續狀態的講者分離模型＋停止後整場校正。** 現有 sherpa 仍可保留為 CPU 基準或特定情境備援，但不能只靠把分群門檻調高，或讓每個視窗的標籤看起來穩定，來宣稱人數與標註正確。',
'', '本輪直接測了 NVIDIA 官方 Nemotron 3 Diarization Q8_0／macOS CPU runtime，以及現有 sherpa、全場 spectral clustering 原型與聲紋記憶原型。這些都是實驗結果，沒有接進正式 UI。',
'', '## 真實長音檔比較',
'', '|素材／方法|時長（分）|參考人數→輸出群數|DER ↓|漏標|誤報|講者錯配|牆鐘耗時（秒）|',
'|---|---:|---:|---:|---:|---:|---:|---:|']
for r in rows:
 if data['datasets'][r['id']].get('synthetic'):continue
 elapsed=r.get('elapsedMs',0)/1000
 if r.get('extraEmbeddingMs'): elapsed+=r['extraEmbeddingMs']/1000
 lines.append(f"|{r['id']}／{r['method']}|{r['seconds']/60:.2f}|{r['truthSpeakers']}→{r['predictedSpeakers']}|{r['DER']:.2f}%|{r['missPct']:.2f}%|{r['falseAlarmPct']:.2f}%|{r['confusionPct']:.2f}%|{elapsed:.2f}|")
lines += ['', 'Spectral 的耗時只列新增 embedding＋分群成本；需另加其來源分段（sherpa 0.8 或 Nemotron v3-offline）的時間；其他列為完整檔案呼叫牆鐘時間（包含該程序的模型載入）。sherpa 門檻掃描第二／三輪沿用已載入模型。CPU 設定不同：sherpa 使用目前預設 2 threads，NVIDIA 使用官方原生 CPU 預設；本表是這台機器上的可用配置，不是同算力模型優劣排行榜。所有神經模型推論依序執行。',
'', '### 如何判讀',
'', '- 人數接近只是必要條件；把不同的人合併到少數群也會讓人數看起來漂亮，仍須看錯配時間與案例。',
'- 15 人的 `ldnro` 超出 Nemotron 的 8 人模型上限，僅列容量壓力測試。這個模型不能作不限人數的通用解答。',
'- `v3-offline` 是約 30.4 秒輸入緩衝的串流狀態機配置，**不是**對整場錄音一次 full-attention 的推論。`v3-streaming` 是低延遲配置；完整檔案快速重播不能直接證明首筆／穩定標籤延遲。',
'- `silero` 列是同一離線式 Nemotron 結果，與現有 Silero VAD 的人聲區間取交集；另列 0／80 ms 外擴。它不重辨識講者、不新增第 9 個通道，可能丟掉低聲或短插話，必須一起看漏標。',
'- `pad005` 僅把輸出兩端 padding 改為 50 ms，其他模型與配置維持。它是檢查多標時間的實驗，不表示所有短發言都可安全縮短邊界。',
'- 本輪素材為 VoxConverse（影音訪談／節目），不等同你的自然中文多人會議、遠場麥克風或吵雜辦公室。匿名講者分群不等於 NT／姓名命中，未測已註冊聲紋的姓名辨識。',
'', '## 長時間壓測與即時短測',
'']
for r in rows:
 if data['datasets'][r['id']].get('synthetic'):
  lines.append(f"- 合成壓測 `{r['id']}`：{r['seconds']/60:.2f} 分鐘，參考 {r['truthSpeakers']} 人、輸出 {r['predictedSpeakers']} 群，DER {r['DER']}%，耗時 {(r['elapsedMs']+r.get('extraEmbeddingMs',0))/1000:.2f} 秒。")
if any(d.get('synthetic') for d in data['datasets'].values()):
 lines+=['',
'壓測將同一份 16.9 分鐘三人錄音重複 4 次，每次之間插入 5 秒靜音；標註同步平移、講者 ID 保持相同。用於檢查長時間狀態、返回講者與尾段，不是自然一小時會議，不能證明新聲音、麥克風改變或中途加入者也能處理。未對這份 68 分鐘素材重跑 sherpa，不能拿不同錄音長度的耗時直接比較。']
paced=out/'jcako-paced60.json'
if paced.exists():
 p=json.loads(paced.read_text());lines+=['',
'另用官方 C ABI 將 `jcako` 前 60 秒，以每 20 ms 真實時間餵入持續的同一 stream：',
'',f"- 模型載入 {p['modelLoadMs']:.1f} ms（輸入計時前）。首次 frame 結果 {p['firstFrameOutputWallMs']:.1f} ms。",f"- 已標註音訊落後牆鐘：P50 {p['labelledAudioLagP50Ms']:.1f} ms、P95 {p['labelledAudioLagP95Ms']:.1f} ms。",f"- push 呼叫耗時 P95 {p['pushCallP95Ms']:.2f} ms、最大 {p['pushCallMaxMs']:.2f} ms；餵入遲到 P95 {p['feedLatenessP95Ms']:.2f} ms。",f"- 停止後尾段 flush {p['tailFlushMs']:.2f} ms；總計 {p['wallSeconds']:.2f} 秒。",'',
'這些是 frame／機率／segment 結果可取得時間，不是講者身份已穩定、不再修正的時間，也不是字幕 DOM 繪製延遲。未同時跑 ASR，不能宣稱共享 CPU 時字幕速度完全不受影響。']
analysis=out/'paced-analysis.json'
if analysis.exists():
 a=json.loads(analysis.read_text());lines += ['',f"- 首筆非空 speaker segment 在 {a['firstNonemptySegmentWallMs']:.1f} ms 可取得；60 秒最終 DER {a['metrics']['DER']}%。參考時間段中點的已觀測標籤變化共 {a['totalObservedMidpointLabelChanges']} 次（不是所有 frame 或所有短插話均穩定的保證）。"]
lines+=['',
'## 失敗案例與不採用項目',
'',
'自然 17 分鐘三人素材的改善很大，但 68 分鐘重複素材出現新的第 4 群。逐份重複片段重新做最佳對齊後仍有錯配，不能只把它解釋成編號置換。整場 spectral 原型也沒有可靠恢復 3 人。最後將 native 講者快取從 264 增為 528 frames，其他 v3-offline 幾何維持，壓測回到 3 群、DER 9.51%（原配置 22.92%），耗時約 75 秒（原約 50 秒）。兩次重跑 RTTM 完全相同，耗時約 74.96／75.00 秒。這支持先驗證較大快取，但只有一份重複素材、尚未測即時共用 CPU 或自然長會議，不能宣稱通用解決。',
'',
'外掛 Silero 人聲過濾在四份素材中有三份增加 DER，也沒有消除 hkzpa 的第三標籤，因此不建議作預設補丁。50 ms padding 降低兩份素材的總 DER，但同時增加漏標；只適合後續按短發言覆蓋率驗收，不能用總 DER 單項決定。',
'',
'## 相同預覽快取的策略初篩',
'',
'10 份既有 VoxConverse 快取，以目前正式 renderer 的分配與穩定化函式作基準；實驗變體在記憶體打包，未改正式來源。排除唱歌對唱。主要表使用固定 2 秒的字幕時間片代理，避免拿參考的真實換人界作唯一輸入；另保存參考時間段代理作敏感度對照。二者都不是實際 ASR 的字幕時間戳。',
'',
'|方法|檔數|平均 DER|平均標籤純度|總輸出群數|字幕標籤修正數|',
'|---|---:|---:|---:|---:|---:|']
for method in ['current',
'voice08',
'memoryMargin',
'memoryEma']:
 selected=[r for r in cache['rows'] if r['method']==method and r['spanMode']=='fixed2s' and r['id']!='jcako']
 lines.append(f"|{method}|{len(selected)}|{sum(r['DER'] for r in selected)/len(selected):.2f}%|{sum(r['purityPct'] for r in selected)/len(selected):.2f}%|{sum(r['predictedSpeakers'] for r in selected)}|{sum(r['captionFlips'] for r in selected)}|")
lines+=['',
'快取沒有最後不足 30 秒的 tick，因此只評到最後已推論的 tick，沒有把未測尾段當成漏標。相同視窗區域以最新結果覆蓋舊結果，所有方法使用一致的拼接與評分規則。快取的 embedding 取自分群輸出，不使用參考人名；參考僅用於評分。',
'', '結果不支持直接套用本輪「提高聲紋門檻／加入全場記憶與 margin／EMA」原型：更高純度也伴隨過切與 DER 退步。全場記憶是一個必要架構能力，但這些特定規則不是已驗收的修正。']
long=[r for r in cache['rows'] if r['id']=='jcako' and r['spanMode']=='fixed2s']
if long:
 lines+=['',
'### 新跑的 17 分鐘預覽',
'',
'使用目前 production diarizeWav＋extractSpeakerLabelEmbeddings，45 秒視窗、30 秒 tick，另加入最後不足整個 tick 的尾段。輸入循序，但未按牆鐘真實時間餵入，供正確率與 CPU 成本比較。',
'',
'|策略|參考人數→輸出群數|DER|標籤純度|字幕標籤修正數|',
'|---|---:|---:|---:|---:|']
 for r in long:lines.append(f"|{r['method']}|{r['truthSpeakers']}→{r['predictedSpeakers']}|{r['DER']}%|{r['purityPct']}%|{r['captionFlips']}|")
lines+=['',
'## 適合目前系統的修正順序（未套用）',
'',
'1. **將 ASR 與講者分離分開排程。** 字幕即時顯示；分離服務持續保留同一錄音的 state/cache，不能每個 chunk 重置人數與編號。標籤暫定與最後校正狀態要明確，避免把暫定匿名 ID 當成已確認身份。',
'2. **最多 8 人且語料接近本輪時，優先驗證 Nemotron 3 作替代後端。** 即時用低延遲配置，停止後用離線式配置重跑；長時間錄音先驗證較大講者快取（本輪 528 frames），同時量測記憶體與共用 CPU 的成本。保留原文、譯文、時間與人工標記。超過 8 人或人數無上限，不能硬塞此模型，應改驗 Community-1／VBx 這類不限固定 8 通道的完整分群管線。本輪未取得其權重，所以不宣稱已比較過。',
'3. **對多出的短暫身份先查原音與人聲覆蓋。** `hkzpa` 參考為 2 人，預設 Nemotron 多出的第三標籤落在尾端約 954.8–964.7 秒，總計約 9.86 秒，不能只用「小於 3 秒就刪掉」來修正。本輪外掛 Silero 是針對人聲時間的獨立比較，不使用 RTTM 來過濾模型輸出。',
'4. **按時間對齊字幕時處理換人與重疊。** 已有字幕跨兩位講者時，單一最大重疊 ID 會掩蓋換人；有詞級時間才可逐詞歸屬或再切句。沒有詞級時間時保留整段與不確定／多講者資訊，不要按字數平均切出假的邊界。重疊時間保留多講者原始軌，另提供 exclusive 軌給單行字幕。',
'5. **姓名辨識維持獨立且可拒識。** 分離先得到穩定的匿名群，再用乾淨、非重疊、多段聲紋確認姓名；分數不夠維持匿名。沒有已註冊身份與標註時，不能拿 spk00／SPEAKER_00 的一致當作姓名辨識成功。',
'6. **後端契約必須明確轉換。** 目前 renderer 的 parseSpeakerTurns 要字串 speaker；官方 native HTTP API 的 speaker 是數字，不能只換 endpoint 就假定可用。即時服務需 session 級持續 stream，開始新錄音才重置，後續 chunk 不能每次重新開啟 diarize 工作。離線階段可先由現有 background worker 呼叫獨立 native CLI；原始多講者時間軸與人工標記要保留。Nemotron 講者快取不等於目前已註冊的 512 維聲紋，姓名識別仍要獨立抽樣／比對與版本檢查。',
'7. **導入前補真實中文會議驗收。** 選正常人數與接近上限的長錄音，包含短插話、久未出聲再返回、同時說話、麥克風移動；固定 RTTM 人工校對。比較 DER、speaker-count MAE、短發言覆蓋、返回講者混淆、人工改名保留與 ASR 共用資源時延遲。不是只驗證最後人數相同。',
'', '原設定 jcako v3-offline 重跑的 RTTM 完全相同（約 12.22／12.13 秒）；相同輸出只支持這台機器與這份素材的重現性，不能證明跨機器或所有音檔均無波動。',
'',
'## 評分與實驗限制',
'',
'- 標準答案是 `tmp/voxconverse/annotations/dev/*.rttm`，本機 README 記錄 v0.3。沒有以之前字幕 TSV 的機器文字當人數真值。',
'- DER：全檔 UEM、collar=0、包含重疊、全場最佳一對一標籤映射。同一標籤的重疊時間段先取聯集，避免把同一人重複計時；多群對應同一人仍會受罰。此數據可與同設定下本輪其他方法比較，不能直接拿官方不同設定的平均 DER 來排行榜。',
'- 字元辨識、翻譯品質、真人姓名與實際 ASR 句界不在本輪驗證範圍。',
'- 人數按整場出現過的非空標籤計算，不等於同時講話人數，也不能把未匹配的小群忽略來美化分數。',
'- Spectral 只重新分群 sherpa 或 Nemotron 的既有時間段：每段至少 2 秒，取中央最多 10 秒做 embedding；不足 2 秒暫用最近時間段的標籤。相似度圖取 10%／20% 近鄰，normalized Laplacian 最大 eigengap 在 1–20 群內選數，再固定種子分群。沒有輸入參考人數，仍有短段錯配與把真人合併的風險。']
check=out/'metric-crosscheck.json'
if check.exists():
 q=json.loads(check.read_text());lines+=['',f"官方 `pyannote.metrics 4.1` 已交叉核對 {len(q['rows'])} 份假設，與本輪 JavaScript 邊界積分評分差異 ≤0.011 個百分點。計算驗證見 [metric-crosscheck.json](metric-crosscheck.json)。"]
lines+=['',
'## 回放與資料',
'',
'- [speaker-replay.html](speaker-replay.html)：相同游標對照參考時間軸與兩個方法；可跳至錯配最多區間。回放是最終結果，不是即時事件到達速度模擬。',
'- [final-comparison.json](final-comparison.json)、[comparison.csv](comparison.csv)：真實長音檔與方法數值。',
'- [comparison.json](comparison.json)：預覽快取初篩與新長音檔預覽的逐檔結果。',
'- [研究候選](research.md)：來源、其他模型的能力與尚未實測項目。',
'- [README.md](README.md)：開啟與重跑方式。',
'', '## 來源與版本',
'',
'- [NVIDIA Nemotron 3 模型卡](https://huggingface.co/nvidia/Nemotron-3-Diarization)：容量、串流幾何與模型限制。',
'- [NVIDIA 官方 runtime](https://github.com/NVIDIA/NeMo-Speech.cpp)：本輪使用 v0.2.0 macOS aarch64 CPU；官方發布校驗碼一致。',
'- [pyannote Community-1](https://huggingface.co/pyannote/speaker-diarization-community-1)：替代完整管線候選，未實測權重。',
'- [Diart 原作者實作](https://github.com/juanmc2005/diart)：重疊感知 incremental clustering 與 cannot-link 約束，文件候選。',
'- [VoxConverse 官方資料](https://www.robots.ox.ac.uk/~vgg/data/voxconverse/) 與 [pyannote.metrics 評分](https://pyannote.github.io/pyannote-metrics/reference.html)。',
'', '權重 revision：`f667ed73aee57d40cc39428eb768b4fd87a0a29e`；Q8_0 SHA256：`08456d9e22cd9a323c0364d98375f3746d6e68507ebb705cd46438c534c7a3a1`。',
'', '## 隔離驗證',
'',f"本輪保存的 {len(data['integrity'])} 份正式來源／設定／README 雜湊全部一致：{all(x['unchanged'] for x in data['integrity'])}。本輪沒有寫入正式程式；專案原有未提交變更保留。完整檢查清單在 final-comparison.json 的 integrity；不將這份有限清單解讀為整個工作樹的所有檔案都沒有同期外部變更。"]
(out/'研究與實驗報告.md').write_text('\n'.join(lines)+'\n')
columns=['id',
'method',
'seconds',
'truthSpeakers',
'predictedSpeakers',
'DER',
'missPct',
'falseAlarmPct',
'confusionPct',
'purityPct',
'elapsedMs',
'rtf',
'extraEmbeddingMs']
with (out/'comparison.csv').open('w') as f:
 w=csv.DictWriter(f,fieldnames=columns,extrasaction='ignore');w.writeheader();w.writerows(rows)
(out/'research.md').write_text((root/'work/diarization/research.md').read_text())
print('Wrote report',len(rows),'long-audio hypotheses')
