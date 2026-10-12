# Silero VAD（獨立 pool，可調 worker 數）

Web gateway 的 Silero VAD 不在 HTTP 主執行緒執行，也不與其他工作共用佇列。自 2026-10 起它跑在**專屬 pool**（`S2T_SILERO_VAD_WORKERS`，每 worker 一個 ONNX session），與互動池（聲紋註冊／dynaudnorm／status）和 heavy 池（diarization／聲紋區塊）分離，因此長任務不會卡住 VAD 請求，VAD 也不會排在聲紋註冊後面：

```env
S2T_SILERO_VAD_WORKERS=1        # 提高以增加並發 VAD 吞吐（先確認 CPU 夠）
S2T_SILERO_VAD_MAX_QUEUE=32
S2T_SILERO_VAD_JOB_TIMEOUT_BASE_MS=10000
S2T_SILERO_VAD_JOB_TIMEOUT_MS=30000
S2T_SHERPA_FAST_WORKERS=1       # 互動池（聲紋註冊等），與 VAD 數量無關
S2T_SHERPA_WORKERS=1            # 重型池（diarization）
S2T_SHERPA_MAX_QUEUE=8
S2T_MODELS_DIR=/models
# Optional per-file override:
# S2T_SILERO_VAD_MODEL=/models/silero-vad/silero_vad.onnx
S2T_SILERO_VAD_SHA256=1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3
```

**HA 與任務分配**：pool 依序把 VAD 請求派給空閒 worker（任務分配）；worker 崩潰自動重生、逾時 worker 被隔離（其餘 worker 繼續服務）、佇列滿明確拒絕而不是靜默卡住。`S2T_SILERO_VAD_WORKERS=2` 即兩倍並發且單一 worker 掛掉不中斷服務；提高前先確認 Pod CPU 夠（workers × 每 worker 推論執行緒）。觀測：`sherpaWorkerPool.stats().pools.silero` 含每操作次數、平均耗時與 RTF。warmup（`S2T_AUDIO_WARMUP=silero`）逐一預熱每個 worker，部署後沒有冷啟動。

模型固定為 upstream `snakers4/silero-vad` `v6.2.1` 的 ONNX opset 16 artifact。應在映像建置或受控的 init job 完成下載與 checksum 驗證；服務請求不會下載模型。預設路徑是 `models/silero-vad/silero_vad.onnx`，環境變數可覆寫為 Pod 掛載的唯讀路徑。

在 Web「ASR／VAD」設定開啟「使用 Silero VAD」後，下一次收音先查 `/api/audio-processing/status`。模型檔、checksum 或 ONNX Runtime 任一項不健康時，收音不會假裝啟用它。每個待送 ASR 的短 WAV 會先由 worker 判斷；無語音就不發出 ASR 請求。**＜300 ms 的微型 chunk 豁免**（2026-10 校準：快切碎音結構性湊不出 120 ms 連續語音，硬判會誤殺真語音；實測誤殺全為 20-220 ms、被擋的 BGM 全 ≥1200 ms——見 `experiment/silero-vad-chunking/comparison-2026-10-12/實驗報告.md`）。這是可選的額外 CPU 工作，ASR／翻譯仍應以獨立模型 Deployment 擴容。

## 指標監控（Prometheus，`GET /metrics`）

Silero 相關的觀測面分三層，皆免额外設定：

| 指標 | 內容 |
| --- | --- |
| `s2t_sherpa_worker_jobs{pool="silero",state=...}` | pool 量能：`configured`／`workers`／`busy`／`queued`／`inFlight`／`maxQueue`。佇列持續堆高＝ worker 不足或有 worker 掛掉 |
| `s2t_sherpa_op_*{op="sileroVad"}`（另有 `sileroStatus`／`sileroWarmup`） | 操作次數、耗時分布、音訊秒數與 **RTF**。RTF 漂高＝ CPU 不足 |
| `s2t_caption_events_total{event="silero_veto"\|"silero_failed"}` | 字幕閘門決策（Web 收音路徑）：`silero_veto`＝ chunk 被判定無語音、未送 ASR；`silero_failed`＝ 閘門請求失敗（此時**降級放行**——故障的輔助閘門不應讓字幕整段消失），失敗率持續 > 0 要查 pool 健康 |

另可 `GET /api/audio-processing/status` 查模型檔／checksum／ONNX Runtime 健康（`sileroVad.available`）。注意 caption 遙測只在 Web 收音路徑發送（桌面端由 `window.s2t` 橋接，不走瀏覽器量測）；pool／op 指標則兩種部署都會匯出。

判讀基準（2026-10 實測，300 s 對話素材）：閘門否決率約 7–10 % 屬正常（BGM 段）；乾淨旁白素材應趨近 0——若 `silero_veto` 在乾淨素材上持續出現，等於在丟真語音，要回頭調 Silero 閾值。

## 喂法契約：每幀 576 樣本（64 context + 512 window）

官方 wrapper 每次推論餵的是**前一幀的 64 樣本尾巴 + 本幀 512 樣本**（16 kHz，共 576），並把 2×1×128 的 recurrent state 帶到下一幀。只餵 512 樣本**不會報錯**，但 state 追不到語音，所有機率會塌到 ~0.003（upstream 原話：*probabilities stay near zero*）。本專案過去就是這種餵法，等於：

- UI 的「使用 Silero VAD」一開，`model-adapter.ts` 判無語音就**直接丟棄該段、不送 ASR** → 字幕完全不出；
- `/api/audio-processing/silero-vad` 永遠回 `speech: []`；
- 聲紋的逐塊門檻 `S2T_VOICEPRINT_VAD=1` 會把所有區塊（含正常語音）全部否決。

回歸測試：`npm run silero:vad:smoke`（真實語音 fixture 必須被判為語音、靜音必須不是），素材在 `tests/fixtures/speech-sample.wav`。

## 錄音層否決（聲紋標註，預設開）

聲紋標註前會先用一次 Silero 掃描整份錄音（RTF ≈ 0.003）：若「語音總時長 < 10 s」**且**「語音比例 < 5 %」，就跳過整輪聲紋標註並回 `vetoed: true`（log 理由 `recording-no-speech`）。這是為了擋音樂素材——其實測語音比例僅 0.024，而且純樂器間奏對註冊聲紋可以拿到 0.702 分（高於 0.65 門檻），不擋就只能標出錯誤身分。

```env
S2T_VOICEPRINT_AUDIO_VAD=1        # 0 = 關閉否決
S2T_VOICEPRINT_AUDIO_VAD_MIN_SEC=10
S2T_VOICEPRINT_AUDIO_VAD_MIN_RATIO=0.05
```

逐塊比例門檻 `S2T_VOICEPRINT_VAD=1` 仍為選配，兩者並存。

`Dockerfile.sherpa-models` 已將該模型放入 `/models/silero-vad/`；主 gateway image 需要將該目錄以 image layer 或唯讀 volume 提供給上述環境變數。

## 研究回饋的修正（2026-10-12）

`server/silero-vad.cjs` 現在使用起音 0.5／結束 0.35 的雙閾值遲滯，與研究評測的閘門一致。至少 120 ms 的連續候選語音才確認起音；短促尖峰之後的靜音不再湊進最短語音時間，尾端靜音也不列入語音區間。576 樣本餵法、recurrent state 與 <300 ms chunk 豁免保持有效，並以真實語音／靜音與合成機率回歸測試驗證。

字幕 adapter 對佔回應大部分的四次以上片語迴圈作保守過濾（單字需八次），兩次重複仍可正常顯示。被否決、空白、迴圈或失敗的回應會清除 rolling context，避免錯誤文字持續影響後續請求。此啟發式不能辨識全部幻覺，也沒有取代模型信心度。

BoundaryVad 在暫停時只重設說話狀態；Silero 的音訊 cursor 與機率窗口位置保留，恢復後不會改用 EnergyVad 或重播開頭機率。此能力仍是評測／注入 detector 的支援，並未把預先計算的 Silero 切點冒充產品即時切點。

實驗評測改為按字幕 ID／revision 更新：句界更新不再重複計入文字，首次顯示時間不會被更新時間覆蓋。main 與 feature 一律使用同一份修正後的評測器；原本未去重的 CER/WER 與「句起點找不到 request」的 latency 結果須重新量測。詳見 [Taiwan-Tongues 實驗紀錄](../../experiment/silero-vad-chunking/taiwan-tongues-2026-10-12/README.md)。

目前五格速度設定與 Energy VAD 預設請見[字幕速度指南](CAPTION_SPEED.zh-TW.md)；6000ms 已改列為慢檔。
