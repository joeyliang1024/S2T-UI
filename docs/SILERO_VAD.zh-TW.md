# Silero VAD（同 Pod CPU worker）

Web gateway 的 Silero VAD 不在 HTTP 主執行緒執行。它和 sherpa embedding／diarization 共用有上限的 `worker_threads` pool，預設每 Pod 一個 CPU 密集工作：

```env
S2T_SHERPA_WORKERS=1
S2T_SHERPA_MAX_QUEUE=8
S2T_SILERO_VAD_MODEL=/models/silero-vad/silero_vad.onnx
S2T_SILERO_VAD_SHA256=1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3
```

模型固定為 upstream `snakers4/silero-vad` `v6.2.1` 的 ONNX opset 16 artifact。應在映像建置或受控的 init job 完成下載與 checksum 驗證；服務請求不會下載模型。預設路徑是 `models/silero-vad/silero_vad.onnx`，環境變數可覆寫為 Pod 掛載的唯讀路徑。

在 Web「ASR／VAD」設定開啟「使用 Silero VAD」後，下一次收音先查 `/api/audio-processing/status`。模型檔、checksum 或 ONNX Runtime 任一項不健康時，收音不會假裝啟用它。每個待送 ASR 的短 WAV 會先由 worker 判斷；無語音就不發出 ASR 請求。這是可選的額外 CPU 工作，ASR／翻譯仍應以獨立模型 Deployment 擴容。

`Dockerfile.sherpa-models` 已將該模型放入 `/models/silero-vad/`；主 gateway image 需要將該目錄以 image layer 或唯讀 volume 提供給上述環境變數。
