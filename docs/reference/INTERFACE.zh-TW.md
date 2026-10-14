# 介面與匯入

即時字幕工具列、側邊欄行為，以及音訊／影片匯入的格式與限制。

## 即時字幕工具列與側邊欄

下方工具列依序提供 A−、A＋、紀錄、收音控制、標記講者與子母視窗；圖示可透過滑鼠停留或鍵盤聚焦查看功能提示。點擊紀錄、收音控制或標記講者會展開側邊欄，隱藏 Workspace／Management 與其他導覽，讓設定從標題下方開始顯示；再次點擊會收起。

`S2T_PRODUCT_TITLE_IMAGE=icon/product_design_title.png` 指定側邊欄展開時的標題圖片。路徑以專案工作目錄為基準，使用 `icon/` 下的 PNG（最多 2 MB），不需電腦絕對路徑。Web gateway 與 Electron 均由環境設定載入；留空或檔案無法讀取時顯示「S2T UI」文字。修改後需重新啟動服務；此設定不影響模型選擇。

側邊欄導覽採共用 SVG 圖示網格、圓角線條與深淺色配色；選取、滑鼠提示及鍵盤焦點跟隨主題，並尊重減少動態效果設定。瀏覽器分頁小圖示來源為 `icon/favicon.svg`，由 Vite 打包為網站資產；獨立字幕視窗沿用相同圖示。

## 音訊／影片匯入

支援 WAV、MP3、M4A、AAC、OGG、WebM、FLAC、MP4、MOV、MPEG／MPG、MPGA、Opus、MKV、AVI、AIFF／AIF、WMA。

- PCM16 WAV 沿用原有 45 秒分段、1.5 秒重疊與斷點接續。
- 其他格式（含非 PCM16 WAV）先送登入中的 Gateway，由本機 FFmpeg 轉成單聲道、16 kHz PCM16 WAV，再分段送到選定 ASR。影片使用第一條音軌；無音軌或解碼失敗會顯示錯誤。
- 匯入與轉換後 WAV 上限均為 2 GB。Gateway 將輸入串流寫入暫存檔，同時僅接受一個轉換，轉換限時 10 分鐘；完成、失敗或取消後清理暫存檔。
- 非 WAV 匯入需要可連線的 Gateway，Electron 也使用已設定的 Gateway。轉換不下載外部編解碼器；既有 M4A 匯出 API 不變。尚未進行完整 2 GB 壓力測試。

驗證：`node tests/smoke/import-audio-smoke-test.cjs`。這些測試驗證轉換與切段，不代表各格式的辨識準確率。

音訊取樣率與降噪策略見 [音訊品質](AUDIO_QUALITY.zh-TW.md)。
