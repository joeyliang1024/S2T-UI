# 摘要、模板與手動補救驗證（2026-10-11）

- `/data/template` 每個 `.md` / `.markdown` 檔案是一個共用模板；名稱取檔名，內容原樣載入。UI 修改另存成帳號私人模板，不覆寫檔案。
- Docker 將 `data/template` 唯讀掛載到 `/data/template`；K8s 使用 `s2t-summary-templates` ConfigMap，執行 `deploy/test/sync-summary-templates.py` 同步。
- 失敗補救一按一試、不輪詢舊 job；手動生成標題可使用失敗紀錄剩餘逐字稿，失敗保留原標題。
- 移除摘要過期黄色提示；Web 摘要使用模型 SSE → Gateway NDJSON → UI 增量更新。長逐字稿先分層整理，最後輸出串流；失敗恢復上一份摘要。Electron 原生橋接仍用原本完整回傳。
- 全部測試使用模擬 API，未呼叫真實模型。2 Gateway + 2 audio-worker + 2 ingress 壓測 100 使用者、6000 組鏈式請求零失敗（原始檔 load-results.json、pod-results.json）。此壓測驗證模板／補救版本；串流另用延遲模型與碎片化 UTF-8 測試，不代表 100 人摘要串流容量。
- `summary-stream-smoke-test.cjs`：首段在完成前到達、中文跨封包完整、中斷與錯誤拒絕。
- `summary-ui-recovery-smoke-test.cjs`：模板保存／私人副本、失敗與完成紀錄摘要、標題手動生成、單次補救、無瀏覽器錯誤。

8787 映像：`s2t-ui:20261011-summary-stream`；K8s：`s2t-stress:20261011-summary-stream`。
