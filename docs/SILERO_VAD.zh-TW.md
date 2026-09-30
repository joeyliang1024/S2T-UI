# Silero VAD（同 Pod CPU worker）

Web gateway 的 Silero VAD 不在 HTTP 主執行緒執行。它跑在**互動池**（`S2T_SHERPA_FAST_WORKERS`，與聲紋註冊、status 共用），與 heavy 池（diarization／聲紋區塊）分離，因此長任務不會卡住 VAD 與註冊請求：

```env
S2T_SHERPA_FAST_WORKERS=1
S2T_SHERPA_WORKERS=1
S2T_SHERPA_MAX_QUEUE=8
S2T_SILERO_VAD_MODEL=/models/silero-vad/silero_vad.onnx
S2T_SILERO_VAD_SHA256=1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3
```

模型固定為 upstream `snakers4/silero-vad` `v6.2.1` 的 ONNX opset 16 artifact。應在映像建置或受控的 init job 完成下載與 checksum 驗證；服務請求不會下載模型。預設路徑是 `models/silero-vad/silero_vad.onnx`，環境變數可覆寫為 Pod 掛載的唯讀路徑。

在 Web「ASR／VAD」設定開啟「使用 Silero VAD」後，下一次收音先查 `/api/audio-processing/status`。模型檔、checksum 或 ONNX Runtime 任一項不健康時，收音不會假裝啟用它。每個待送 ASR 的短 WAV 會先由 worker 判斷；無語音就不發出 ASR 請求。這是可選的額外 CPU 工作，ASR／翻譯仍應以獨立模型 Deployment 擴容。

## 喂法契約：每幀 576 樣本（64 context + 512 window）

官方 wrapper 每次推論餵的是**前一幀的 64 樣本尾巴 + 本幀 512 樣本**（16 kHz，共 576），並把 2×1×128 的 recurrent state 帶到下一幀。只餵 512 樣本**不會報錯**，但 state 追不到語音，所有機率會塌到 ~0.003（upstream 原話：*probabilities stay near zero*）。本專案過去就是這種餵法，等於：

- UI 的「使用 Silero VAD」一開，`model-adapter.ts` 判無語音就**直接丟棄該段、不送 ASR** → 字幕完全不出；
- `/api/audio-processing/silero-vad` 永遠回 `speech: []`；
- 聲紋的逐塊門檻 `S2T_VOICEPRINT_VAD=1` 會把所有區塊（含正常語音）全部否決。

回歸測試：`npm run silero:vad:smoke`（真實語音 fixture 必須被判為語音、靜音必須不是），素材在 `scripts/fixtures/speech-sample.wav`。

## 錄音層否決（聲紋標註，預設開）

聲紋標註前會先用一次 Silero 掃描整份錄音（RTF ≈ 0.003）：若「語音總時長 < 10 s」**且**「語音比例 < 5 %」，就跳過整輪聲紋標註並回 `vetoed: true`（log 理由 `recording-no-speech`）。這是為了擋音樂素材——其實測語音比例僅 0.024，而且純樂器間奏對註冊聲紋可以拿到 0.702 分（高於 0.65 門檻），不擋就只能標出錯誤身分。

```env
S2T_VOICEPRINT_AUDIO_VAD=1        # 0 = 關閉否決
S2T_VOICEPRINT_AUDIO_VAD_MIN_SEC=10
S2T_VOICEPRINT_AUDIO_VAD_MIN_RATIO=0.05
```

逐塊比例門檻 `S2T_VOICEPRINT_VAD=1` 仍為選配，兩者並存。

`Dockerfile.sherpa-models` 已將該模型放入 `/models/silero-vad/`；主 gateway image 需要將該目錄以 image layer 或唯讀 volume 提供給上述環境變數。
