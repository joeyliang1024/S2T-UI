# 文件入口

繁體中文 | [English](en/README.md)

開發者先看 [CONTRIBUTING](../CONTRIBUTING.md)、[目錄規範](wiki/Repository-Layout.md) 與 [文件規範](wiki/Documentation-Standards.md)。Wiki 來源位於 `docs/wiki/`，分類文件範本位於 `docs/templates/`。

操作方式以 guide 為準，API／資料格式以 reference 為準；整理後結果集中在 [結果索引](reports/README.md)，原始實驗資料僅留本機。產品需求與待辦維持在 [Enhancement.md](Enhancement.md)。

| 要做的事 | 文件 |
| --- | --- |
| Nginx＋獨立 Python 後端、Web 開發與多 Pod | [Web 分離指南](guide/WEB_SPLIT.zh-TW.md) |
| 啟動 Web／Docker、連接 Storage、備份遷移 | [部署指南](guide/DEPLOYMENT.zh-TW.md) |
| 環境變數、模型與預設設定 | [環境設定](guide/ENVIRONMENT.zh-TW.md) |
| 以 NT 與密碼登入、註冊與管理使用者 | [NT 登入](guide/NT_LOGIN.zh-TW.md) |
| 以 CSV 術語匹配翻譯 prompt | [翻譯術語說明](guide/TRANSLATION_JARGON.zh-TW.md) |
| 部署多副本應用 | [Kubernetes 指南](guide/K8S_SCALE_DEPLOYMENT.zh-TW.md) |
| 看首字延遲、耗時百分比與服務監控 | [監控指南](guide/OBSERVABILITY.zh-TW.md) |
| 選擇字幕回應速度五個位置 | [回應速度指南](guide/CAPTION_SPEED.zh-TW.md) |
| 規劃 Python 後端容量量測 | [容量測試](guide/CAPACITY_TEST.zh-TW.md) |
| 錄音上傳慢、OPFS Worker 與斷線恢復 | [錄音可靠性](guide/RECORDING_RELIABILITY.zh-TW.md) |
| 自動檢查與真人驗收 | [驗收手冊](guide/VALIDATION.zh-TW.md) |
| 管理 Admin 帳號、專屬參數與 PostgreSQL 恢復 | [Admin 恢復](guide/ADMIN_RECOVERY.zh-TW.md) |
| 聲紋共享授權審批與撤銷 | [共享授權](guide/SHARING_AUTHORIZATION.zh-TW.md) |
| 安裝本機講者分離／VAD | [sherpa-onnx](guide/SHERPA_ONNX.zh-TW.md)、[Silero VAD](guide/SILERO_VAD.zh-TW.md)、[Nemotron CPU 分離](guide/NEMOTRON.zh-TW.md) |

## 開發契約

[現行 Web／Python 架構](reference/ARCHITECTURE.zh-TW.md)、[模型 adapter](reference/MODEL_ADAPTER.md)、[Python Web API](reference/WEB_GATEWAY.zh-TW.md)、[講者分離 API](reference/DIARIZATION_API.zh-TW.md)、[音訊品質](reference/AUDIO_QUALITY.zh-TW.md)、[介面與匯入](reference/INTERFACE.zh-TW.md)。

## 最新部署驗證

[2026-10-26：NT、相依漏洞稽核、錄音極限、Grafana 與 500 人容量結果](reports/VALIDATION_2026-10-26.zh-TW.md)。每一種請求頻率與失敗證據分開記錄；英文版見 [English validation](en/VALIDATION_2026-10-26.md)。

[2026-10-25：五項錄音／清理修正與故障驗證](reports/RECORDING_FIXES_2026-10-25.zh-TW.md)，含跨重載清理、51 項前端與 38 項 Python 測試。

[錄音可靠性修正與故障驗證](reports/RECORDING_PIPELINE_2026-10-24.zh-TW.md)：前端 r8，65 秒上傳中斷與 durable ACK 遺失測試通過。

[2026-10-24 Web／Python／K8s 實測報告](reports/WEB_PYTHON_K8S_2026-10-24.zh-TW.md)：前端 1 Pod、後端 2 Pods、跨 Pod、錄音流程及 Grafana 計時核對。外部模型使用 mock，真實模型品質與 GPU 尚需另驗。

## 品質研究與量測

[字幕穩定性](reports/CAPTION_STABILITY.zh-TW.md)、[聲紋準確率](reports/VOICEPRINT_ACCURACY.zh-TW.md)。完整實驗數據與回放集中在 experiment，文件不複製 JSON／CSV。

H100／H200 的環境變數與部署方式見 [GPU 部署指南](guide/GPU.zh-TW.md)。

## 設計研究（research）

架構起源與可行性研究，作為設計背景參考，不取代現行部署指南或當成已驗證功能：[早期功能研究與架構起源](research/PLAN.zh-TW.md)、[開源後端方案](research/OPEN_SOURCE_BACKENDS.zh-TW.md)、[Kubernetes 擴充規劃](research/K8S_SCALE_PLAN.zh-TW.md)、[自動切分可行性](research/AUTO_CHUNKING.zh-TW.md)、[背景工作生命週期](research/SESSION_LIFECYCLE.zh-TW.md)、[現有模型 GPU 加速評估](research/GPU_ACCELERATION_2026-10-17.zh-TW.md)。

需要追蹤的缺口與待辦以 [Enhancement.md](Enhancement.md) 為準。



[結果重現指南](guide/REPRODUCE.zh-TW.md)；[目前字幕合併結果](reports/CAPTION_MERGE_2026-10-26.zh-TW.md)。
