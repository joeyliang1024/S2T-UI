# GPU：Python 部署

繁體中文 | [English](../en/MODELS.md)

更新日期：2026-10-24。GPU 映像位於 `deploy/docker/audio-cuda.Dockerfile`，Compose overlay 為 `deploy/compose/gpu.yaml`。設定置於 `backend/.env`；CPU／CUDA 策略以 Python 音訊引擎為準。H100／H200 路徑尚未經實機驗證，不應以 CPU 功能測試宣稱 GPU 已可用。

啟動、環境與掛載一律依 [Web 分離指南](WEB_SPLIT.zh-TW.md)；驗證範圍見 [部署報告](../reports/WEB_PYTHON_K8S_2026-10-24.zh-TW.md)。
