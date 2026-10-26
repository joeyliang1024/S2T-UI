# 模型權重與原生 runtime

預設 `S2T_MODEL_DIR=./models`，維持現有結構：

```text
models/
├── silero-vad/
├── sherpa-onnx/
└── nemotron-3-diarization/
    └── runtime/
```

權重與 runtime 不提交 Git；一般 Web 映像透過唯讀 volume 或 PVC 掛載，
不會在啟動時自動下載。`deploy/docker/nemotron.Dockerfile` 的獨立映像沿用既有封裝方式。
本次整理沒有搬動或重新下載權重，既有 `S2T_MODEL_DIR` 設定仍可使用。
