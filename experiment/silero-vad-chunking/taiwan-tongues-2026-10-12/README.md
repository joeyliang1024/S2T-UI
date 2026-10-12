# Taiwan-Tongues：main 基線、CER 優先切段與研究 bug 修正

> 後續更新：本報告當時套用的 6000／250／700ms 方案，現已改列為「慢」。目前正常為 3000ms，介面有五格；請見[五檔實驗紀錄](../speed-tiers-2026-10-13/README.md)與[現行設定指南](../../../docs/guide/CAPTION_SPEED.zh-TW.md)。以下保留當時的實驗數字與名稱。

實驗起始日：2026-10-12，完成日：2026-10-13（Asia/Taipei）。分支：`feature/silero-vad-chunking`。

## 控制與素材

- Baseline 是真正的 **main**：`5783fed98b10a26feb384c67f03d4625141fda2e`。評測器用 `--source-ref main` 匯出該 commit 的 `src`，載入其 adapter、VAD、字幕合併策略及相依 renderer 模組；沒有改 checkout，也沒有以 feature preset 冒充 main。
- 所有臂使用同一份修正後的評測器、Breeze-ASR-25、48 kHz mono PCM16、原始句級 TSV、同一 ASR 端點；順序執行，避免臂之間互搶模型。原始 JSON 保存 source commit、adapter/VAD SHA256、音檔/TSV SHA256、參數、請求失敗、queue、延遲與字幕明細。
- 資料來源：[Taiwan-Tongues-ASR-CE-dataset-zhtw 的官方資料卡](https://huggingface.co/datasets/adi-gov-tw/Taiwan-Tongues-ASR-CE-dataset-zhtw/blob/main/README.md)，使用本機 test shard 的固定種子抽樣。這是 79 個 clip、79 句、648 個正規化字元的子集，不代表整個資料集。
- `music/taiwan-tongues/fixture-300s.wav` 實際約 301 秒；保留逐 clip 標註，clip 間加 0.6 秒靜音。**不合併標註句子來壓低 CER**，也不把另外產生的 `-g24` 素材混入同場比較。
- `fixture-manifest.json` 記錄 seed `20261012`、clip 清單與 SHA256。修正後的 fixture 產生器以 `--group-chars 0 --gap 0.6` 重建，WAV／TSV checksum 與既有素材完全相同。

| 素材 | SHA256 |
| --- | --- |
| WAV | `237536cc95f0d97a2f05979bf10588c9aa93b06efb69b2caea1a6cc52dc115d5` |
| TSV | `5af1aeab37734ab866920d65ec1d49f76714a7e8343a762338cf9b6d07a11edf` |

## 指標與評測 bug

語料 CER = 正規化後的字元編輯距離／reference 字元數；WER 使用同一正規化與 `Intl.Segmenter('zh-TW')` 詞界。選擇方案使用**語料級 CER**，同時報告 WER、起話至第一個重疊字幕事件的 P50/P95、≤2500ms 比例、錯誤与漏句。延遲是 adapter 的事件顯示代理，沒有包含真實瀏覽器繪製或產品 Silero gateway 往返。

1. **句界 revision 重複計分**：adapter 會發出 `boundaryOnly` 更新同一段字幕；舊評測把它當新 final，再拼一次 sourceText。現在依 ID／revision 更新既有事件，保留首次 displayWall，且 boundary 更新不再破壞 overlap 去重結果。用回歸測試驗證相同文字加句界更新後仍是 CER=0。
2. **已顯示卻算未送出**：舊版只找覆蓋 reference 起點的 request，起點落在丟棄的靜音區間時找不到。現在找與句子重疊的首個 final，並禁止以起話之前已顯示的字幕得到負延遲。
3. **截斷答案**：`--max-seconds` 若切在標註句子中間，評測器拒絕執行。短樣本採 `58.596` 秒、14 個完整句子（113 字／61 詞）；完整評測不截音檔。
4. 逐句 CER 的時間區间歸因仍沒有 word timestamps；一個 request 橫跨多句時，文字可能計入多句。JSON 的 `sentenceAttributionAmbiguousEvents` 揭露這種情況；**逐句 CER 不用來排名**，不可將其虛高解讀成產品重複輸出。

舊 `caption-latency-new.json` 的 59.26%、`caption-latency-fastv2.json` 的 64.35%，以及 `resume-connected` 的 39.67% 使用了舊評測器，不是本輪有效 baseline。`resume-smoke` 全數因沙箱 DNS 解析失敗，100% CER 是連線失敗，也不列入品質比較。舊檔保留作診斷，沒有覆盖或修改其原始數字。

## 短樣本篩選

每個候選在同一前 58.596 秒篩選；以這批資料調參，因此不能當獨立 held-out 成績。

| 來源／方案 | max chunk／停頓 (ms) | 語料 CER | 語料 WER | latency P50／P95 (ms) | ≤2500ms | ASR 錯誤 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| main `new` | 1500／250 | 23.89% | 31.15% | 2078／3303 | 78.57% | 0 |
| feature `accuracy2400` | 2400／250 | 29.20% | 39.34% | 2025／4122 | 57.14% | 0 |
| feature `accuracy6000` | 6000／250 | 13.27% | 21.31% | 3533／5904 | 0% | 0 |
| feature `accuracy6000NoContext` | 6000／250，不用 rolling prompt | 14.16% | 22.95% | 3664／6290 | 0% | 0 |
| feature `newSileroInd` | 1500／500，Silero 句界＋gate | 36.28% | 44.26% | 2102／3315 | 71.43% | 0 |
| feature `accuracy6000Conservative` | 6000／500 | **9.73%** | **14.75%** | 4466／6033 | 0% | 0 |

原始資料在 `screening-main/` 與 `screening-feature/`。`newSileroInd` 的框機率在播放前計算，數字不含即時 Silero 的推論／IPC 時間，且產品並未接成即時 Silero 句界。

## 完整素材驗證與套用

完整 main baseline 與兩個篩選候選已完成；79 句／648 字／372 詞，ASR 端點錯誤皆為 0。main source SHA256 已與 `git show 5783fed:...` 逐項核對，三臂音檔／TSV hash 与 reference 分母完全相同。

| 完整 301 秒方案 | 語料 CER | 語料 WER | latency P50／P95 (ms) | ≤2500ms 全句 | 上屏／總句 | ASR 錯誤 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| main `new` | 39.66%（257/648） | 45.70%（170/372） | 1871／2864 | 86.08% | 78/79 | 0 |
| feature `accuracy6000` | 10.34%（67/648） | 16.67%（62/372） | 3432／5546 | 7.59% | 79/79 | 0 |
| feature `accuracy6000Conservative` | 11.11%（72/648） | 17.20%（64/372） | 3790／5988 | 3.80% | 79/79 | 0 |

**套用完整測試最低的 `accuracy6000`，不是短樣本勝出的 Conservative**：EnergyVad、`minSpeechMs=120`、`minSilenceMs=250`、`preRollMs=300`、`noiseFloorOffsetDb=12`、`chunkMinMs=700`、`chunkMaxMs=6000`、48 kHz、無 overlap、保留 rolling prompt；Silero 句界未設為產品預設，Silero gate 保留為可選項。

- main → selected：CER **39.66% → 10.34%（−29.32pp）**，WER **45.70% → 16.67%**；編輯距離由 257 減為 67。**完整素材仍未低於 10%**，不能用短樣本的 9.73% 宣稱達標。
- latency P95 **2864 → 5546 ms（+2682 ms）**，P50 1871 → 3432 ms；≤2500ms 全句比例由 86.08% 降到 7.59%。依本次「最低 CER」要求選擇此方案，**沒有宣稱兼顧原先 P95≤2500ms 目標**。
- ASR request 207 → 82；上屏代理覆蓋 78/79 → 79/79；三臂皆無 queue overflow／ASR request error。
- `defaultVadConfig` 與「正常」檔套用勝出參數，未指定 config 的 adapter 也使用同一預設。快檔保留 1200ms／150ms；慢檔共用 6000ms 上限、保留 800ms 停頓等待與 1000ms minimum。慢檔不是本輪 CER 排名的方案，未宣稱其已獲相同結果。既有管理員覆寫仍有效。
- UI 回應速度提示明確說明正常檔優先準度、可能等待數秒。自然句界仍優先於 6 秒上限：兩秒語音加停頓的 mock 收音會在三秒內一次送出，不必等滿六秒。

原始完整報告在 `main-baseline/`、`full-feature/`；摘要在 [comparison.json](comparison.json) 與 [comparison.csv](comparison.csv)。摘要保存套用後 adapter/VAD 的 hash。編譯後的 `defaultVadConfig`、`speedToVadConfig('normal')` 已逐欄與勝出報告的參數比對相同；候選 presets 固定參數，產品 default 變動不會令兩個歴史候選变成同一組。

本輪 benchmark 沒有套用管理員 `strictChunkLimits` 覆寫。工作區另有同步進行的管理員 strict limits 與清空字幕修改，本輪保留它們，並在整合後重跑 adapter／caption regression、typecheck 與 build；不能把本輪 ASR 數字宣稱為清空字幕流程或管理員覆寫組的實測結果。

這是一次子集調參、單輪完整驗證；短樣本包含在完整素材內，不是獨立 held-out。ASR 端點存在推論與網路波動，6 秒兩臂差距只差五個字符，不能推論全資料集或其他語言／BGM 場景有同樣排名。main 對 feature 的改善包含產品文字衛生修正與切段改變，未用消融實驗將收益全部歸因於單一參數。

## 研究指出的問題及產品修正

參考 [AUTO_CHUNKING 研究](../../../docs/research/AUTO_CHUNKING.zh-TW.md) 與 [先前 Silero 實驗](../comparison-2026-10-12/實驗報告.md)：

- server gate 從單一 0.5 閾值改為起 0.5／止 0.35 遲滯；最短 120 ms 必須由連續候選語音達成，不能由 32 ms 尖峰加靜音湊足，最後零填充的視窗也不能憑空增加真實時長。
- server 語音区間修掉尾端靜音灌入 voiced duration，避免污染後續語音比例門檻。
- adapter `flush()` 不再把注入的 detector 換成 EnergyVad；Silero reset 保留音訊 cursor／nextWindow，恢復時不重播開頭機率。
- 保守的文字迴圈過濾：同一片語連續 ≥4 次、且佔回應 ≥80% 才否決，單字至少 8 次；兩次重複保留。被 gate 否決、空白、迴圈或 ASR 失敗時清掉 rolling context，避免錯誤持續影響後續請求。這是啟發式，無法保證分辨所有真實重複與模型幻覺。
- 缺 64 樣本 context 的 ONNX 餵法、<300ms chunk 必殺、gate 故障靜默漏字幕已在這個分支的既有 commit 修過。本輪保留並回歸驗證 576 樣本輸入、state 延续、micro-chunk 豁免與 fail-open；沒有把已修好的 bug 當成本輪新修正。

[Whisper 原始碼的說明](https://github.com/openai/whisper/blob/main/whisper/transcribe.py) 指出前段輸出作為下一段 prompt 可能造成重複迴圈；停用可能改善迴圈但也損失跨段一致性。本輪以對照選擇保留或關閉，而不是預先假設關閉一定更好。

## 重現

```sh
# 本機須先有 test shard 解壓至 music/taiwan-tongues/clips。
node scripts/evaluation/build-taiwan-tongues-fixture.cjs --seconds 300 --gap 0.6 --group-chars 0

# 真正 main；指定 commit 可重現本輪 baseline，避免 main 日後變動。
node scripts/evaluation/caption-latency-eval.cjs --source-ref 5783fed98b10a26feb384c67f03d4625141fda2e --preset new --audio music/taiwan-tongues/fixture-300s.wav --tsv music/taiwan-tongues/fixture-300s.tsv --out experiment/silero-vad-chunking/taiwan-tongues-2026-10-12/main-baseline

# 完整候選對照；網路須能到達 .env 既有 ASR 端點。
node scripts/evaluation/caption-latency-eval.cjs --preset accuracy6000,accuracy6000Conservative --audio music/taiwan-tongues/fixture-300s.wav --tsv music/taiwan-tongues/fixture-300s.tsv --out experiment/silero-vad-chunking/taiwan-tongues-2026-10-12/full-feature
```

逐 clip 的 `raw-asr-cer.cjs` 是另一種 request 切法的診斷；先前 8.95%／14.25% 不能當 main baseline，也不能直接相減宣稱有 30pp 管線因果誤差。更新後腳本另報 ASR HTTP P50/P95，該數字不等於字幕上屏延遲。

## 驗證

- `node tests/smoke/caption-evaluation-events-smoke-test.cjs`：ID／revision 去重、保留首次顯示時間、保留 overlap 去重文字。
- `npm run model-adapter:smoke`：自然句界提早送出、預設長片段仍在 capture 中送出、迴圈過濾與 context 清除、暫停／恢復 detector、gate fail-open／micro-chunk 豁免／否決後清 context。
- `npm run vad:smoke`、`npm run silero:vad:smoke`：合成機率的連續語音／遲滯／尾端／零填充回歸，以及真實語音與靜音 ONNX 檢查；真實語音比例 0.997、peak 1.000，靜音 peak 0.009。
- `npm run sherpa:worker:smoke` 與 `S2T_SILERO_VAD_WORKERS=2 npm run sherpa:worker:smoke`：獨立 Silero pool／worker 數配置。這不等於完整 Pod failover 壓測。
- `npm run caption:regression`：套用後 10 分鐘 virtual normal capture 為 100 次 ASR，含注入翻譯故障的測試，最後都無 gap、未翻譯、pending audio 或 in-flight 殘留；快檔正常。
- `npm run translation-policy:smoke`、`npm run caption:display:smoke`、`npm run i18n:smoke`、`npm run typecheck`、`npm run build`、`git diff --check`。
