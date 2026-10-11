# 前端 VAD 切段、慢 API 佇列與字幕收尾

日期：2026-10-06（Asia/Taipei）；分支：feature/k8s-scale-docker-compatible。

## 重現漏音訊

舊壓測直接呼叫 ASR API，不能涵蓋前端的四筆有序音訊佇列。本次直接執行真正的 OpenAiChunkedModelAdapter：45 秒連續語音、16 kHz、每 10 ms 輸入一個 frame，第一個模型回應 12 秒、其餘 400 ms。

修改前，720,000 個 PCM sample 只送出 672,000 個，缺少 **48,000 samples（3 秒）**，出現一個 queue-overflow gap。原因是四筆佇列滿了，就略過下一個正常語音片段。這是傳送流程的缺口，不能說成 VAD 或 ASR 已經辨識過的內容。

## 修正與資料界線

- 四筆有序模型請求上限保留；滿載時暫存尚未送出的音訊，記住 VAD 自然邊界。請求完成就繼續派送，不依賴下一個 microphone frame，也保留修改 VAD 設定前已判定的語音。
- 未送出音訊最多 30 秒；如果模型持續過慢，仍會產生明確 gap，而不是無限耗用記憶體。相鄰丟棄區間合成同一個 gap，每秒最多更新一次，避免每個 AudioWorklet frame 都新增紀錄及警示。
- stop 排空時每個 clip 最多六秒，保留自然切點和最後句子結束，不把累積的長 backlog 塞成單一巨大請求。
- 同一音訊重試沿用同一冪等 key、語言與 prompt；避免第一個回應遺失後重做已完成的辨識，或設定變動造成 fingerprint 衝突。
- 尾端純靜音回傳空文字（或被 Silero 判為非語音）時，只關閉緊鄰前一字幕的句子邊界。metadata-only 更新不覆寫手動改字、譯文、講者或 revision，讓整句翻譯不用無限等後續字幕。

## 驗證

| 測試 | 結果 |
|---|---|
| 同一 45 秒音訊，第一個回應 12 秒 | 修改後送出全部 720,000 samples，零 gap |
| 100 個前端錄音流程，同樣延遲 | 每個流程的 PCM sample 數量及 SHA256 順序均相符，四筆請求上限維持，零 gap |
| 模型持續延遲 120 秒的極端狀態 | 暫存 ≤30 秒，產生明確合併 gap、沒有 frame 頻率的 UI 更新洪水，stop clip ≤6 秒 |
| 尾端空辨識結果 | 只關閉原字幕邊界，手動內容、譯文、講者與 revision 保留 |
| 語言／prompt 在重試間變動 | 同一請求仍沿用原 key 與參數 |
| 實際 Chrome＋隔離 Gateway，故意丟掉已完成的 HTTP 回應 | 瀏覽器送兩次，同一 key，mock upstream **只收到一次 ASR**，第二次取回持久化結果 |
| 原 100 帳號資料完整性 | 全部通過 |

100 個錄音流程是 **虛擬時鐘的前端模擬**，不代表 100 個實體麥克風或真實模型的辨識率。所有模型回應均模擬；另通過 fast／normal 的十分鐘字幕／翻譯回歸、VAD onset／silence、model-adapter smoke、TypeScript 與 Docker 正式 Web 建置。

## 原始證據與重現

- [原流程缺口](results/baseline.json)、[修正後完整 sample](results/fixed.json)。
- [100 流程與極端負載檢查](results/backlog-smoke.txt)、[瀏覽器回應遺失](results/browser-retry.json)、[upstream 一次的計數證據](results/retry-upstream-proof.json)。
- results/caption-regression.txt、model-adapter-smoke.txt、vad-smoke.txt、typecheck.txt、integrity.json。

```sh
node tests/smoke/caption-backlog-smoke-test.cjs
node tests/smoke/caption-regression-test.cjs
node experiment/captions/vad-2026-10-06/probe.cjs rerun
```

browser-retry.cjs 需要隔離測試 K8s、8790 port-forward、本機 Chrome 和既有大型紀錄測試帳號。它在 Gateway 成功回覆後故意 abort 第一個瀏覽器請求；沒有呼叫真實 ASR API。計數前後快照需由 load-client /stats 另行取得，避免把 cached replay 當成兩次辨識。

目前映像為 s2t-stress:20261006-vad-backlog2。此次證明送入模型的 PCM 順序與佇列處理；**不能保證真實 ASR 不漏字，亦未改成所有音量／噪聲都能偵測**。EnergyVad 的最短 onset、能量閾值和對噪聲的取捨仍存在，低音量或短於 onset 的語音需要後續 corpus／實際錄音驗證。完整錄音與即時字幕是不同保存流程，gap 會保留在字幕資料供檢查。
