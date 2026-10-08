# 長時間講者分離獨立實驗

正式程式未修改。實驗僅讀取專案 `tmp/` 的本機素材與現有模型；替代模型在獨立 work 目錄執行，沒有將錄音送到遠端。

## 查看結果

- `研究與實驗報告.md`：研究、比較結果、適用範圍與修正順序。
- `speaker-replay.html`：音訊、參考軌與兩方法的並排回放。
- `核對案例.md`：依參考標註自動選取的改善與退步案例，尚未逐例人工聽音。
- `final-comparison.json`、`comparison.csv`：長音檔分離、人數與錯配結果。
- `comparison.json`：既有快取初篩與新跑預覽比較。
- `metric-crosscheck.json`：官方 pyannote.metrics 交叉驗證。
- `jcako-paced60.json`：以每 20 ms 真實時間餵入官方原生 stream 的短測；不是 ASR／UI 延遲。

在此目錄執行：

```sh
python3 -m http.server 58756 --bind 127.0.0.1
```

開啟 <http://127.0.0.1:58756/speaker-replay.html>。HTML 與各音檔 MP3 放在同一目錄，也可直接開啟 HTML。

## 重跑與隔離

`tools/` 保存本輪獨立工具。原工作目錄為：

`/Users/liangzhiquan/Documents/Codex/2026-10-03/new-chat`

這批工具以原工作目錄下的 `work/diarization`、`outputs/diarization` 互相引用；它們是可核查的實驗來源，不是可直接在任意資料夾執行的產品安裝器。原專案素材位於 `/Users/liangzhiquan/Desktop/S2T-UI/tmp/voxconverse`，替代模型權重與 runtime 沒有打包進專案 experiment，需按研究報告的官方來源取得並核對 SHA256。`remaining.py` 會依序呼叫實驗，不同模型不並行爭用 CPU。

主要步驟（從原工作目錄執行）：

```sh
node work/diarization/native.cjs jcako full 0.8
node work/diarization/native.cjs jcako preview
python3 work/diarization/nemotron-run.py jcako
node work/diarization/compare.cjs
node work/diarization/score-final.cjs
work/diarization/metric-venv/bin/python work/diarization/verify-metrics.py
```

`metric-venv` 是獨立評分環境，未更改專案依賴。工具讀取 production 模組，後續 production 版本若改變，結果不能假定與本輪相同。模型 metadata、指令與雜湊保存於結果 JSON。

68 分鐘壓測是同一真實錄音重複四次的控制實驗，不是自然長會議；回放頁僅展示自然長音檔，壓測完整結果另列於報告與 RTTM／JSON。

較大講者快取壓測：`cache528.py` 以官方 C ABI 保持同一 stream，僅將 v3-offline 的 spkcache_frames 由 264 改為 528。`cache528-repeatability.json` 記錄重跑是否一致。這不是自然一小時中文會議驗收。
