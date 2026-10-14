# 文件入口

操作方式以 guide 為準，API／資料格式以 reference 為準；量測證據集中在 [experiment](../experiment/README.md)。產品需求與待辦維持在 [Enhancement.md](Enhancement.md)。

| 要做的事 | 文件 |
| --- | --- |
| 啟動 Web／Docker、連接 Storage、備份遷移 | [部署指南](guide/DEPLOYMENT.zh-TW.md) |
| 環境變數、模型與預設設定 | [環境設定](guide/ENVIRONMENT.zh-TW.md) |
| 部署多副本應用 | [Kubernetes 指南](guide/K8S_SCALE_DEPLOYMENT.zh-TW.md) |
| 看首字延遲、耗時百分比與服務監控 | [監控指南](guide/OBSERVABILITY.zh-TW.md) |
| 選擇字幕回應速度五個位置 | [回應速度指南](guide/CAPTION_SPEED.zh-TW.md)、[完整五檔實驗](../experiment/silero-vad-chunking/speed-tiers-2026-10-13/README.md) |
| 重跑至少 2 Pod 的壓力測試 | [容量測試](guide/CAPACITY_TEST.zh-TW.md) |
| 自動檢查與真人驗收 | [驗收手冊](guide/VALIDATION.zh-TW.md) |
| 管理 Admin 帳號、專屬參數與 PostgreSQL 恢復 | [Admin 恢復](guide/ADMIN_RECOVERY.zh-TW.md) |
| 聲紋共享授權審批與撤銷 | [共享授權](guide/SHARING_AUTHORIZATION.zh-TW.md) |
| 安裝本機講者分離／VAD | [sherpa-onnx](guide/SHERPA_ONNX.zh-TW.md)、[Silero VAD](guide/SILERO_VAD.zh-TW.md)、[Nemotron CPU 分離](guide/NEMOTRON.zh-TW.md) |

## 開發契約

[架構](reference/ARCHITECTURE.zh-TW.md)、[模型 adapter](reference/MODEL_ADAPTER.md)、[Web Gateway](reference/WEB_GATEWAY.zh-TW.md)、[講者分離 API](reference/DIARIZATION_API.zh-TW.md)、[音訊品質](reference/AUDIO_QUALITY.zh-TW.md)、[介面與匯入](reference/INTERFACE.zh-TW.md)。

## 品質研究與量測

[字幕穩定性](reports/CAPTION_STABILITY.zh-TW.md)、[聲紋準確率](reports/VOICEPRINT_ACCURACY.zh-TW.md)。完整實驗數據與回放集中在 experiment，文件不複製 JSON／CSV。

## 審查與實作

[整合計劃](reports/REFACTOR_PLAN_2026-10-13.zh-TW.md)、[第一批進度](reports/REFACTOR_PROGRESS_2026-10-14.zh-TW.md)。

## 設計研究（research）

架構起源與可行性研究，作為設計背景參考，不取代現行部署指南或當成已驗證功能：[早期功能研究與架構起源](research/PLAN.zh-TW.md)、[開源後端方案](research/OPEN_SOURCE_BACKENDS.zh-TW.md)、[Kubernetes 擴充規劃](research/K8S_SCALE_PLAN.zh-TW.md)、[自動切分可行性](research/AUTO_CHUNKING.zh-TW.md)、[背景工作生命週期](research/SESSION_LIFECYCLE.zh-TW.md)。

需要追蹤的缺口與待辦以 [Enhancement.md](Enhancement.md) 為準。
