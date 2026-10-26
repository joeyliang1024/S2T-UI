# NEMOTRON：Python 部署

繁體中文 | [English](../en/MODELS.md)

更新日期：2026-10-24。Python 音訊引擎使用 FFmpeg 與 Nemotron 原生 runtime，模型位於 `models/`。可設定 `S2T_DIARIZATION_MODEL=nemotron-3-diarization`。完整 CPU 後端由 `deploy/docker/backend.Dockerfile` 的 `audio` target 建置；可選獨立 CLI 映像位於 `deploy/docker/nemotron.Dockerfile`。Linux ARM64 CPU 路徑已有功能驗證；GPU 尚需實機驗證。

啟動、環境與掛載一律依 [Web 分離指南](WEB_SPLIT.zh-TW.md)；驗證範圍見 [部署報告](../reports/WEB_PYTHON_K8S_2026-10-24.zh-TW.md)。
