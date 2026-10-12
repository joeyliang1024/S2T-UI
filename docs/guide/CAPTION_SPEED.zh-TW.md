# 字幕回應速度：五個位置（2026-10-13）

滑桿提供五個可選位置；只在第 1、3、5 格顯示「快／正常／慢」，第 2、4 格不顯示名稱。選擇會保存於設定，重新啟動後仍保留原位置。舊的 `fast`／`normal`／`slow` 設定對應第 1／3／5 格，未指定或未知值回到正常。

| 位置 | 顯示文字 | 切段目標上限 | 自然停頓門檻 | 用途 |
| --- | --- | ---: | ---: | --- |
| 1 | 快 | 1200ms | 150ms | 優先早出字幕，短片段可能辨識較差 |
| 2 | — | 1500ms | 250ms | 快與正常之間 |
| 3 | 正常 | 3000ms | 250ms | 預設；平衡準度與等待 |
| 4 | — | 4000ms | 250ms | 正常與慢之間 |
| 5 | 慢 | 6000ms | 250ms | 使用較完整語音上下文，優先準度 |

共同參數：語音確認 120ms、前卷 300ms、噪音偏移 12dB、chunk minimum 設定 700ms。使用 EnergyVad 與原有 rolling prompt，沒有換 ASR 模型或啟用 Silero 句界。Silero 非語音否決 gate 是另外的可選設定。

收到自然句界可以提早送出，不是每句都等滿表中上限。一般非管理員覆寫的流程允許自然短句少於 700ms；ASR 排隊較多時會放大強制切段長度以降低請求量，整體最多 6 秒。因此表中是健康負載下的目標，不是所有情境下每個 WAV 的硬上下限。管理員客製參數會覆蓋滑桿設定。

## 驗證範圍

最新完整成績、未採用方案與選擇理由見 [五檔實驗](../../experiment/silero-vad-chunking/speed-tiers-2026-10-13/README.md)。同一 Taiwan-Tongues test 子集、79 句、648 個正規化字元、372 詞、約 301 秒，Breeze-ASR-25，48kHz、無 overlap。主指標為語料 CER，同時報告 WER 與 adapter 首個字幕事件延遲。

這份中文子集上的延遲 **P95 不是 ≤2.5 秒保證**，也不包含真實瀏覽器 paint、翻譯或另外的字幕校正。較慢的含義是「句子起點到第一段字幕顯示的等待較久」，不是逐字播放速度。英文、其他資料集與正式多人負載未在本輪驗收；英文尚未開始，中文慢檔 10.34% 仍未達 CER≤10%。

先前 [Taiwan-Tongues CER 優先實驗](../../experiment/silero-vad-chunking/taiwan-tongues-2026-10-12/README.md) 曾將 6 秒方案套在正常檔；該名稱只描述當時版本。依最新分檔，該 **6 秒／250ms／700ms 方案完整移到慢檔**，没有沿用舊慢檔的 800ms 停頓或 1000ms minimum。

## 重跑目前產品設定

```sh
node scripts/evaluation/caption-latency-eval.cjs --preset speedFast,speedFastNormal,speedNormal,speedNormalSlow,speedSlow --audio music/taiwan-tongues/fixture-300s.wav --tsv music/taiwan-tongues/fixture-300s.tsv --out experiment/silero-vad-chunking/speed-tiers-2026-10-13/recheck
```

這五個 aliases 從載入的原始碼讀取配置；歷史候選名稱保留固定參數。`--source-ref <commit>` 會直接載入指定 commit 的程式碼，baseline 使用 main 的 `5783fed98b10a26feb384c67f03d4625141fda2e`。原始音訊與 tar 不提交 Git；抽樣清單、WAV/TSV checksum 與重建步驟保存在實驗紀錄。
