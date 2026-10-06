# 文件入口

操作方式以 guide 為準，API／資料格式以 reference 為準；量測證據集中在 [experiment](../experiment/README.md)。產品需求與待辦維持在 [Enhancement.md](Enhancement.md)。

| 要做的事 | 文件 |
| --- | --- |
| 啟動 Web／Docker、連接 Storage、備份遷移 | [部署指南](guide/DEPLOYMENT.zh-TW.md) |
| 環境變數、模型與預設設定 | [環境設定](guide/ENVIRONMENT.zh-TW.md) |
| 部署多副本應用 | [Kubernetes 指南](guide/K8S_SCALE_DEPLOYMENT.zh-TW.md) |
| 看首字延遲、耗時百分比與服務監控 | [監控指南](guide/OBSERVABILITY.zh-TW.md) |
| 重跑至少 2 Pod 的壓力測試 | [容量測試](guide/CAPACITY_TEST.zh-TW.md) |
| 自動檢查與真人驗收 | [驗收手冊](guide/VALIDATION.zh-TW.md) |
| 安裝本機講者分離／VAD | [sherpa-onnx](guide/SHERPA_ONNX.zh-TW.md)、[Silero VAD](guide/SILERO_VAD.zh-TW.md) |

## 開發契約

[架構](reference/ARCHITECTURE.zh-TW.md)、[模型 adapter](reference/MODEL_ADAPTER.md)、[Web Gateway](reference/WEB_GATEWAY.zh-TW.md)、[講者分離 API](reference/DIARIZATION_API.zh-TW.md)、[音訊品質](reference/AUDIO_QUALITY.zh-TW.md)。

## 品質研究

[字幕延遲](reports/CAPTION_LATENCY.zh-TW.md)、[字幕穩定性](reports/CAPTION_STABILITY.zh-TW.md)、[字幕比較](reports/CAPTION_COMPARISON_2026-10-04.zh-TW.md)、[聲紋準確率](reports/VOICEPRINT_ACCURACY.zh-TW.md)。研究資料與回放各保留一份在 experiment，避免文件再複製 JSON／CSV。

## 修正與盤點記錄

一次性的已套用修正與環境盤點，保留當時的根因、步驟與驗證結果，不再列入待辦：[完成列才辨識講者](reports/COMPLETED_CAPTION_SPEAKERS_2026-10-04.zh-TW.md)、[講者標註第一階段](reports/SPEAKER_LABEL_FIX_2026-10-04.zh-TW.md)、[Nemotron timeout 修正](reports/NEMOTRON_TIMEOUT_FIX_2026-10-04.zh-TW.md)、[Docker 連外盤點與 Nemotron 映像](reports/DOCKER_NETWORK_NEMOTRON_2026-10-04.zh-TW.md)。

research 中的規劃是歷史設計背景，不能取代現行部署指南或當成已驗證的功能。需要追蹤的缺口以 Enhancement.md 為準。
