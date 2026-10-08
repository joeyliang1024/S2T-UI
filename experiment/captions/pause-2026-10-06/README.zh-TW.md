# 暫停收音時的字幕尾段送出

日期：2026-10-06（Asia/Taipei）；分支：feature/k8s-scale-docker-compatible。

## 重現

600 ms 語音已超過 VAD onset，但低於一般 HTTP clip 上限。原 togglePause 只暫停 MediaRecorder／停止輸入 frame，沒有送出 pending audio，因此在暫停期間沒有模型請求或字幕；直到 resume 或整段 stop 才送出。baseline.json 顯示暫停前尾段 9,600 samples、resume 前零請求、零字幕。

## 修正

ModelAdapter 增加可選 flush，OpenAiChunkedModelAdapter 將目前音訊終點標成明確暫停邊界。togglePause 更新 paused 狀態後同步觸發 flush，既有請求繼續執行；不 stop adapter，不重設字幕 sequence，不等待模型才更新按鈕。

若暫停恰好在完整 clip 切點，對尚未回覆的 clip 補上句子結束；若它已回覆，僅更新 boundary metadata。若四筆慢請求滿載，保留尾段並在 slot 恢復時送出。resume 重新做 VAD onset，不把暫停前的 speaking 狀態當成新語音。重複 flush 不重送音訊，純靜音不新增模型請求。

## 驗證

- 600 ms 尾段：resume 前已有一筆模型請求、一筆閉合字幕；全部 9,600 samples 只送一次。
- 1,500 ms 恰好切點：在途 clip 正確閉合，不新增重複 clip。
- 9 秒語音＋首個回應 12 秒：四筆佇列滿載時的暫停可排空，再 resume／stop，完整 sample 數量相符。
- 純靜音及重複 flush：沒有多餘請求。
- 真實 Chrome UI 使用 **合成 tone WAV 的假麥克風**、專用模擬帳號，點選開始與暫停按鈕；暫停前零 ASR 請求，暫停後一筆，首筆約 **43 ms** 送出。之後成功點選結束收音。ASR route 回覆為模擬，不使用真實模型 API。
- 原 100 帳號資料完整性全部通過；100 流程慢 API PCM 回歸、十分鐘字幕／翻譯回歸、TypeScript 和 Docker 正式 Web 建置通過。

瀏覽器 harness 初期選取麥克風選單 index 1，實際是「不使用」，以及 resume／stop 的文字 matcher 不符合中文按鈕，造成測試定位逾時；已改為明確 default device 及正確名稱。最終 browser.json 為完整按鈕流程成功結果，不把定位錯誤當作應用失敗。

## 證據與重現

[修改前](results/baseline.json)、[修改後](results/fixed.json)、[原生 UI 點擊](results/browser.json)、results/pause-smoke.txt、backlog-smoke.txt、caption-regression.txt、integrity.json。

```sh
node tests/smoke/capture-pause-smoke-test.cjs
node experiment/captions/pause-2026-10-06/probe.cjs fixed
node experiment/captions/pause-2026-10-06/browser.cjs
```

browser.cjs 需要隔離 Gateway 的 8790 port-forward、本機 Chrome 與 bundled Playwright。它建立專用模擬帳號、合成 tone WAV 與測試錄音，不讀取實際麥克風；原 100 個帳號不修改。仍未以真實 ASR 評估 600 ms clip 的辨識準確率。

目前測試映像 s2t-stress:20261006-capture-pause，4 個 Gateway／1 個 audio-worker。實驗環境以 mock API 運作，原 localhost:8787 服務未修改。
