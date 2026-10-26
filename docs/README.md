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

## 目前結果與重現

[2026-10-26 完整驗證結果](reports/VALIDATION_2026-10-26.zh-TW.md)、[字幕合併](reports/CAPTION_MERGE_2026-10-26.zh-TW.md)、[重現指南](guide/REPRODUCE.zh-TW.md)。目前功能部署基線為前端 r16／後端 r24；容量數字維持原 r23／r24 的實測範圍，後續 UI 更新未重新壓測。

500 人／600 秒／3 秒 cadence 的容量及錄音完整性通過；2 秒 cadence 未通過。同步瀏覽器翻譯 P90 3.023 秒，未達嚴格小於 3 秒目標。測試模型為各 500ms mock，不代表真實推論運算或 500 個實體瀏覽器。歷史與本機 ASR 研究不是目前顯示合併的準確率證據。

原始實驗與中間輸出保留在本機忽略路徑；只提交整理後結果、測試腳本和重現方式。歷史研究保留其當時數字並明確標示，不取代現行 guide。完整結果入口見 [結果索引](reports/README.md)。

## 設計研究（research）

架構起源與可行性研究，作為設計背景參考，不取代現行部署指南或當成已驗證功能：[早期功能研究與架構起源](research/PLAN.zh-TW.md)、[開源後端方案](research/OPEN_SOURCE_BACKENDS.zh-TW.md)、[Kubernetes 擴充規劃](research/K8S_SCALE_PLAN.zh-TW.md)、[自動切分可行性](research/AUTO_CHUNKING.zh-TW.md)、[背景工作生命週期](research/SESSION_LIFECYCLE.zh-TW.md)、[現有模型 GPU 加速評估](research/GPU_ACCELERATION_2026-10-17.zh-TW.md)。

需要追蹤的缺口與待辦以 [Enhancement.md](Enhancement.md) 為準。



[結果重現指南](guide/REPRODUCE.zh-TW.md)；[目前字幕合併結果](reports/CAPTION_MERGE_2026-10-26.zh-TW.md)。

本次預發行版：[0.2.0-rc.1 更新說明](releases/0.2.0-rc.1.zh-TW.md)。
