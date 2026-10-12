# 五格字幕回應速度實驗

日期：2026-10-13（Asia/Taipei）；分支 `feature/silero-vad-chunking`。介面五個可選位置，只有第 1、3、5 格顯示「快、正常、慢」；第 2、4 格不顯示名稱。預設正常 3000ms，保留舊設定值 fast/normal/slow，增加兩個中間值。

## 完整素材結果

同一 Taiwan-Tongues test 固定抽樣：301.308 秒、79 clips、79 句、648 字／372 詞；素材清單與來源見[前輪紀錄](../taiwan-tongues-2026-10-12/README.md)。main 是 commit `5783fed98b10a26feb384c67f03d4625141fda2e` 的真實來源。

| 位置／候選 | 最大段／停頓 ms | 語料 CER | 語料 WER | 起話→首字幕 P50/P95 ms | 上屏句 | 請求錯誤 |
| --- | --- | ---: | ---: | ---: | --- | ---: |
| main baseline | 1500/250 | 39.66% | 45.7% | 1871/2864 | 78/79 | 0 |
| 1 快 | 1200/150 | 42.13% | 41.13% | 1707/2702 | 78/79 | 0 |
| 2 無文字 | 1500/250 | 38.73% | 44.09% | 1844/2767 | 78/79 | 0 |
| 3 正常 | 3000/250 | 20.37% | 29.3% | 2741/3390 | 79/79 | 0 |
| 4 無文字 | 4000/250 | 12.81% | 20.16% | 3295/4324 | 78/79 | 0 |
| 5 慢（前輪） | 6000/250 | 10.34% | 16.67% | 3432/5546 | 79/79 | 0 |
| 不採用 2秒 | 2000/250 | 86.73% | 86.56% | 2032/3532 | 78/79 | 0 |
| 不採用 4.5秒 | 4500/250 | 111.27% | 48.66% | 3585/4808 | 78/79 | 0 |

快檔選 1200/150ms：較 main 的中位延遲少 164ms、P95 少 162ms，CER 增加 2.47 個百分點；是優先出字的取捨。正常選 3000/250ms：相較 main，CER 降低 19.29 個百分點，P95 增加 526ms。慢檔沿用前輪最低 CER 的 6000/250/700ms，CER 10.34%，仍未達 10%。第 2 格 1500ms 保留接近原 main 的切段速度。

2 秒和 4.5 秒候選出現大量 ASR 幻覺，未採用。CER 可超過 100%，因為插入錯字的數量可大於 reference 分母。保守重複偵測能攔下固定短句循環，但仍會漏掉變形／混雜的重複文字；不宣稱此問題已完全修好。第 4 格改測 4 秒，完整 4 秒結果 CER 12.81%、P95 4324ms，位於正常與慢的取捨之間。原始失敗結果保留，沒有刪除或排除錯句來美化成績。

## 控制與限制

- 各臂 48kHz mono、Energy VAD、rolling context 開啟、overlap=0、Silero gate 關閉；共同 minSpeech=120、preRoll=300、noiseFloorOffsetDb=12、chunkMin=700ms。只調整表列最大段與停頓時間。Silero bug 修正有獨立 ONNX／adapter 測試，但本表不是 Silero 增益證據。
- 新一輪 evaluator 先將整份 src 複製到暫存目錄，固定來源後再播放，避免其他工作修改來源影響結果。JSON 保存 source hash、fixture hash、實際開始／結束時間；working-tree commit 是祖先識別，不能當作未提交來源的完整識別。這輪凍結來源可能包含其他同步工作，原始 adapter/VAD hash 保留；提交版本另以獨立快照測試。
- main 和慢檔引用前輪完整結果，其參數與素材一致，但不是本輪同時重跑。每個候選只有一次測量，遠端 ASR 負載／幻覺會變動；沒有信賴區間，也不保證品質隨檔位單調。
- 這批資料同時用於調參，不是 held-out 成績。逐句歸因無 word timestamps，跨句事件有歧義，排名使用語料 CER。延遲取 adapter 首次字幕事件代理，不含瀏覽器 paint、翻譯或後續校正。英文尚未驗證。
- 自然停頓可以提前送出；排隊時可能增加段長，最大受 6 秒上限約束。檔位值不是固定等候時間或所有字幕的硬延遲保證。

## 一併修正與驗證

修正評測重複計入 boundary revision、起話事件漏配／負延遲、標註句中截斷，加入真實 main source-ref 與來源／素材雜湊。Silero 修正 onset/end hysteresis、短尖峰／尾端 padding 造成假 speech interval；flush 保留 detector 類型、reset 狀態；ASR 空字／失敗／循環／gate veto 後清掉 rolling context。完整修正原因與歷史數字見前輪報告。

提交快照通過 typecheck、production build、model-adapter smoke、caption regression、Energy VAD smoke、真實 Silero ONNX smoke、五格 UI／設定往返、評測事件去重回歸。

重跑（依序播放約 25 分鐘，需既有 ASR 服務與公開 fixture）：

```sh
node scripts/evaluation/caption-latency-eval.cjs --preset speedFast,speedFastNormal,speedNormal,speedNormalSlow,speedSlow --audio music/taiwan-tongues/fixture-300s.wav --tsv music/taiwan-tongues/fixture-300s.tsv --out experiment/silero-vad-chunking/speed-tiers-rerun
```

現行參數與介面說明見[字幕速度指南](../../../docs/guide/CAPTION_SPEED.zh-TW.md)。原始 JSON 在 full/；總表 comparison.json／comparison.csv。原始 dataset 音檔不納入 Git。
