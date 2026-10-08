# 長時間講者分離：研究候選與實驗邊界

研究日期：2026-10-04。研究與原型均隔離在本聊天 work；不改正式程式或專案依賴。

## 架構候選

| 路線 | 原理／適用範圍 | 本輪狀態 |
| --- | --- | --- |
| 現有 sherpa：pyannote segmentation 3.0 + 3D-Speaker + 凝聚分群 | 保留 CPU／ONNX 相容；短視窗各自分群，再匹配標籤 | 原生長音檔基準；0.75／0.8／0.85 對照 |
| 全場聲紋記憶＋保守匹配／EMA | 長久未發言者回來仍可比對舊標籤；閾值與身份混淆需一起看 | 在相同快取上獨立原型；不等於模型升級 |
| 全場 spectral clustering | 使用每個有效段的 embedding 建圖、自動 eigengap 選人數、重新分群 | 客戶端離線原型；同一 sherpa 時間段，不能修復原分段的漏音與重疊 |
| pyannote Community-1／VBx | 原生完整分群管線、詞稿對齊可用 exclusive 結果；支援人數約束 | 本機無權重與 pyannote.audio；官方權重需使用條款與存取 token，未實測，不以 sherpa 的 pyannote segmentation 冒充 |
| Nemotron 3 Diarization | 官方聲明最多 8 人，arrival-order speaker cache 保留跨塊身份；支援串流與離線式配置 | 官方 macOS CPU 原生 v0.2.0 + Q8_0 權重，本機實測；預设的完整音檔重播不等於真實時間串流延遲驗證 |
| Streaming Sortformer v2.1 | 持續串流狀態與講者快取，但最多 4 人 | 文件候選，未另跑權重；不宜作超過 4 人錄音的通用預設 |
| Diart | 重疊感知 segmentation／embedding、incremental clustering、cannot-link；延遲可選 | 文件候選，未安裝原模型實測；不是單純每 30 秒跑一次離線分群 |

## 研究推論

即時字幕速度與講者標籤可分開：ASR 收到即顯示，講者標籤暫定；分離端用持續狀態而非每窗重置，停止後全場重算。全場重算也需保留人工更名與原字幕 ID；若 ASR 片段跨兩位講者，僅選最大重疊的一人會丟掉換人資訊，應先有詞級時間或可驗證的再切分，不能任意把文字平均切開。重疊音應保留多講者時間軸，exclusive 輸出只供單一文字歸屬，兩者不可混作評分。

最多 8 人的模型是明確容量上限；15 人素材不能靠重新命名 8 個通道驗收講者人數。未知姓名保持匿名，真實姓名需獨立的已註冊聲紋與拒識門檻。

## 第一手來源

- [sherpa 官方離線範例](https://github.com/k2-fsa/sherpa-onnx/blob/master/python-api-examples/offline-speaker-diarization.py)
- [pyannote 官方管線](https://github.com/pyannote/pyannote-audio/blob/main/src/pyannote/audio/pipelines/speaker_diarization.py)
- [Community-1 模型卡](https://huggingface.co/pyannote/speaker-diarization-community-1)
- [Nemotron 3 官方模型卡](https://huggingface.co/nvidia/Nemotron-3-Diarization)
- [NVIDIA 原生 runtime](https://github.com/NVIDIA/NeMo-Speech.cpp)
- [Sortformer v2.1 模型卡](https://huggingface.co/nvidia/diar_streaming_sortformer_4spk-v2.1)
- [Diart 原作者實作](https://github.com/juanmc2005/diart)
- [VoxConverse 官方資料說明](https://www.robots.ox.ac.uk/~vgg/data/voxconverse/)
- [pyannote.metrics 評分文件](https://pyannote.github.io/pyannote-metrics/reference.html#diarization-error-rate)
