# sherpa-onnx 本機講者分離

本專案以 Node.js 的 `sherpa-onnx-node` 執行離線講者分離，不需 Python、GPU 或外部 API key。它使用 pyannote segmentation ONNX 與 3D-Speaker embedding ONNX，在 CPU 將完整錄音切為時間區段並自動標示 `SPEAKER_00`、`SPEAKER_01` 等講者。

## 啟動

模型預設置於未納入 Git 的 `models/sherpa-onnx/`。完成依賴與模型下載後，啟動 Web gateway：

```bash
npm install
npm run web:serve
```

在 Electron 的「完整設定」填入：

| 欄位 | 值 |
| --- | --- |
| 講者分離 endpoint | `http://127.0.0.1:8787/api/diarizations` |
| 講者分離 model ID | `sherpa-onnx-speaker-diarization` |
| API key | 留空 |

Web 版若透過 Vite 執行，未填 endpoint 時會直接呼叫同源 `/api/diarizations`。

## 音訊契約與限制

`POST /api/diarizations` 接收 raw `audio/wav`，最大 500 MB，回傳：

```json
{
  "model": "sherpa-onnx-speaker-diarization",
  "exclusive_diarization": [
    { "start": 0.32, "end": 3.84, "speaker": "SPEAKER_00" }
  ]
}
```

服務接受 PCM 16-bit WAV；若錄音為多聲道或不是 16 kHz，會先混成單聲道並線性重取樣至 16 kHz。此為離線後處理，需在「記錄」頁對已完成 WAV 按「自動識別講者」，不會阻塞即時字幕。

這個模型做的是聲紋分群，並不認得人的姓名。可在逐字稿中把 `SPEAKER_00` 手動改成「講者 1」等名稱。CPU 處理耗時取決於音檔長度與機器；先以 30 秒至數分鐘錄音驗收，再評估長會議的背景工作需求。
