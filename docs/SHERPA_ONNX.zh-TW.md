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

分群結果先使用 `SPEAKER_00`、`SPEAKER_01` 等匿名名稱。已註冊聲紋後，可透過下列 API 將單一講者 WAV 轉為 512 維 embedding，並以 Milvus 或本機向量層比對；命中門檻預設為 0.65，回傳註冊帳號的 NT 與 Department。CPU 處理耗時取決於音檔長度與機器；先以 30 秒至數分鐘錄音驗收，再評估長會議的背景工作需求。

`POST /api/diarizations` 的本機模式會自動將同一匿名講者的所有分群區段合併成一個樣本，再做一次聲紋比對。命中的區段 `speaker` 會回傳 NT；未命中者維持 `SPEAKER_XX`。字幕畫面的講者名稱是可編輯文字欄位，使用者可以覆寫自動結果。

## 聲紋註冊與比對 API

三個 API 都需要登入後的 `Authorization: Bearer <token>`，並接受 PCM16 WAV。註冊時 NT 與 Department 一律取自登入身分，不能由瀏覽器指定；Milvus 的業務欄位只有 NT、Department 與 embedding。啟用 PostgreSQL 時，`s2t_voiceprint_records` 另保存 vector ID、擁有者、embedding 模型與版本；可用 `S2T_VOICEPRINT_EMBEDDING_MODEL_NAME`、`S2T_VOICEPRINT_EMBEDDING_VERSION` 覆寫其識別值。

比對只會使用目前 embedding 模型與版本完全相同的註冊資料。沒有模型／版本 metadata 的舊聲紋不會被比對，需由使用者重新註冊；這避免不同模型即使碰巧維度相同仍產生錯誤匹配。

| 方法 | 路徑 | 功能 |
| --- | --- | --- |
| `POST` | `/api/voiceprints` | 從單一講者 WAV 建立聲紋註冊。 |
| `GET` | `/api/voiceprints` | 列出目前登入使用者註冊的聲紋。 |
| `POST` | `/api/voiceprints/identify` | 從 WAV 搜尋最近的已註冊聲紋，低於門檻時回傳 `match: null`。 |
| `DELETE` | `/api/voiceprints/:id` | 刪除目前登入使用者自己的註冊。 |

請以安靜環境、單一講者且至少 1 秒的 WAV 註冊。可用 `S2T_VOICEPRINT_THRESHOLD`（0 到 1）調整門檻；提高門檻可減少誤配，降低門檻可減少漏配。
