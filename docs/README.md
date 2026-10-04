# 文件索引

S2T-UI 文件依用途分四類；待辦與需求狀態只看 [Enhancement.md](Enhancement.md)，本目錄文件提供操作、契約與量測證據。

## guide — 上手與操作

| 文件 | 內容 |
| --- | --- |
| [DEPLOYMENT.zh-TW.md](guide/DEPLOYMENT.zh-TW.md) | Web 啟動順序、外部 Storage（MinIO／PostgreSQL／Milvus）、fallback 遷移、備份與故障 |
| [VALIDATION.zh-TW.md](guide/VALIDATION.zh-TW.md) | 驗收手冊：各輪實測的版本、平台、步驟與結果 |
| [SHERPA_ONNX.zh-TW.md](guide/SHERPA_ONNX.zh-TW.md) | sherpa-onnx 離線講者分離、模型安裝與 Linux x64 離線模型 image |
| [SILERO_VAD.zh-TW.md](guide/SILERO_VAD.zh-TW.md) | Web gateway Silero VAD worker 設定與環境變數 |
| [CAPACITY_TEST.zh-TW.md](guide/CAPACITY_TEST.zh-TW.md) | K8s 容量測試操作（1／10／25／50／100 路） |

## reference — 契約與架構

| 文件 | 內容 |
| --- | --- |
| [ARCHITECTURE.zh-TW.md](reference/ARCHITECTURE.zh-TW.md) | 程式目錄與責任劃分（renderer／server／main） |
| [MODEL_ADAPTER.md](reference/MODEL_ADAPTER.md) | 自有模型接入契約（ModelAdapter 事件與介面） |
| [WEB_GATEWAY.zh-TW.md](reference/WEB_GATEWAY.zh-TW.md) | Web ASR Gateway 端點、認證與代理行為 |
| [DIARIZATION_API.zh-TW.md](reference/DIARIZATION_API.zh-TW.md) | 自動講者分離 API 契約 |
| [AUDIO_QUALITY.zh-TW.md](reference/AUDIO_QUALITY.zh-TW.md) | 音訊品質與取樣率、降噪策略 |

## research — 研究與規劃（歷史參考，不覆蓋 Enhancement.md 決策）

| 文件 | 內容 |
| --- | --- |
| [K8S_SCALE_PLAN.zh-TW.md](research/K8S_SCALE_PLAN.zh-TW.md) | 0930 計畫：100 人即時收音、K8s 多副本可靠性與容量目標 |
| [PLAN.zh-TW.md](research/PLAN.zh-TW.md) | 早期功能研究 |
| [OPEN_SOURCE_BACKENDS.zh-TW.md](research/OPEN_SOURCE_BACKENDS.zh-TW.md) | 開源後端方案研究與自有模型整合 |

## reports — 量測報告

| 文件 | 內容 |
| --- | --- |
| [CAPTION_COMPARISON_2026-10-04.zh-TW.md](reports/CAPTION_COMPARISON_2026-10-04.zh-TW.md) | 五分鐘旁白獨立比較：顯示分組、上下文、LocalAgreement、音訊重疊；三檔延遲、核對案例與未校對參考限制 |
| [CAPTION_LATENCY.zh-TW.md](reports/CAPTION_LATENCY.zh-TW.md) | 即時字幕延遲調校（P95 ≤ 2.5 秒）：方法、三速實測與淘汰依據 |
| [VOICEPRINT_ACCURACY.zh-TW.md](reports/VOICEPRINT_ACCURACY.zh-TW.md) | 聲紋辨識準確率量測與改善計畫 |

- [環境變數與模型設定](guide/ENVIRONMENT.zh-TW.md)：共用模型根目錄、舊覆寫相容、模型服務選擇與 worker 參數範圍。

- [背景處理生命週期檢查](research/SESSION_LIFECYCLE.zh-TW.md)

- [講者標註第一階段修正與驗證](reports/SPEAKER_LABEL_FIX_2026-10-04.zh-TW.md)
