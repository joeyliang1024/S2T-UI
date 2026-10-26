# SILERO_VAD：Python 部署

繁體中文 | [English](../en/SILERO_VAD.md)

更新日期：2026-10-26。Silero 由 Python 音訊引擎載入本機模型，權重置於 `models/`，依賴由 `backend/requirements-audio.lock` 安裝。前端切段與伺服器音訊處理分屬 `frontend/src/`、`backend/app/audio_engine.py`；舊 `server/` 程式已移除。

啟動、環境與掛載一律依 [Web 分離指南](WEB_SPLIT.zh-TW.md)；驗證範圍見 [部署報告](../reports/VALIDATION_2026-10-26.zh-TW.md)。
