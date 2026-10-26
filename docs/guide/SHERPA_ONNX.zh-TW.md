# SHERPA_ONNX：Python 部署

繁體中文 | [English](../en/SHERPA_ONNX.md)

更新日期：2026-10-26。Python 音訊依賴由 `backend/requirements-audio.lock` 安裝，模型放在 `models/`，容器唯讀掛載。使用本機分離時可設定 `S2T_DIARIZATION_MODEL=sherpa-onnx-speaker-diarization`，遠端 endpoint 與 key 留空。模型／音訊引擎實作以 `backend/app/audio_engine.py` 為準，不需安裝舊 Node 原生套件。

啟動、環境與掛載一律依 [Web 分離指南](WEB_SPLIT.zh-TW.md)；驗證範圍見 [部署報告](../reports/VALIDATION_2026-10-26.zh-TW.md)。
