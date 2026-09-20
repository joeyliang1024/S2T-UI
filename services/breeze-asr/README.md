# Breeze-ASR-26 本機橋接服務

這個服務實作 S2T UI 的 WebSocket 協定，預設監聽 `ws://127.0.0.1:8000/stream`。它將單聲道 Float32 音訊累積為 8 秒視窗，再呼叫 `MediaTek-Research/Breeze-ASR-26` 並傳回 final 字幕。

```bash
cd services/breeze-asr
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn server:app --host 127.0.0.1 --port 8000
```

在 S2T UI 的「設定」填入 `ws://127.0.0.1:8000/stream`，來源語言選擇「台語」。首次推論會下載約 2B 參數的模型。正式部署請使用 CUDA GPU；CPU 僅適合驗證流程。

這是 ASR 模型，會將台語語音輸出為中文漢字。模型卡說明它是 Whisper multilingual 的微調版，訓練／用途都集中於台語；一般國語、英語或翻譯需求應改用對應模型或在 ASR 後增加翻譯服務。
