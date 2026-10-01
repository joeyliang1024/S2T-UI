# 音訊品質與取樣率

## 目前策略

- 瀏覽器取得麥克風後，以 `AudioContext.sampleRate` 作為實際錄音取樣率，WAV header 與 PCM 資料使用相同數值，不修改 header 偽裝重採樣。若 ASR 模型宣告不同支援取樣率，僅送模型的分支會使用串流 windowed-sinc 低通與重採樣；保存 WAV 仍維持裝置原生取樣率。
- sherpa-onnx 的 3Dspeaker 聲紋範例使用 **16 kHz**。因此送往聲紋 embedding 的音檔應在服務端或 renderer 做真正的重採樣至 16 kHz；目前本機 sherpa gateway 會依模型輸入處理 WAV，正式部署前仍須以目標模型確認。
- ASR 取樣率由所選模型的 endpoint／文件決定。不能把 48 kHz 錄音只改寫成 16 kHz header；那會破壞音高、時長與時間戳。

## 降噪

App 提供「啟用麥克風降噪」設定，使用 `getUserMedia` 的 `noiseSuppression` 約束。瀏覽器若不支援會忽略此偏好，因此 UI 的設定是請求而非硬性保證。它只影響新建立或切換的麥克風 stream，不會改寫已保存音檔；目前錄音保存與送往 ASR 的音訊均使用同一個處理後 stream。

## 建議實測

針對 16 kHz 與裝置原生取樣率各錄製相同內容，至少比較：

1. ASR 文字錯誤率、端到端延遲與 API 傳輸量。
2. 已知講者命中率、未知講者分群穩定性。
3. 開啟／關閉降噪時的文字品質、聲紋相似度與主觀聽感。
4. WAV 時長、字幕時間戳與實際錄音是否一致。

建議預設保留裝置原生取樣率錄音；聲紋服務以真正的 16 kHz 重採樣副本計算 embedding。這可同時保留原始音檔品質與匹配模型需求。

## 參考資料

- [sherpa-onnx speaker identification example](https://github.com/k2-fsa/sherpa-onnx/blob/master/python-api-examples/speaker-identification.py)
- [MDN: noiseSuppression](https://developer.mozilla.org/en-US/docs/Web/API/MediaTrackSettings/noiseSuppression)
