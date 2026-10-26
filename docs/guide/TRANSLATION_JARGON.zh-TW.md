# 翻譯 CSV 術語匹配

後端每次處理 `POST /api/translations`，會讀取共用 CSV 的最新版本，僅將
`原文.includes(jargon)` 命中的列組成 `jargon->az_jargon_listen`，以換行串接。
比對區分大小寫、採子字串包含、不限制詞界，並保留 CSV 列順序；同一術語
在原文出現多次不會重複該列。CSV 中重複的列則會依序保留。

沒有匹配時，內容固定為：

```text
本次無匹配術語, 請依據場內情境自由發揮專業翻譯
```

CSV 必須包含 `jargon` 與 `az_jargon_listen` 欄位。支援 UTF-8、UTF-8 BOM、
引號及包含逗號／換行的欄位；空白列、空術語或空譯文不參與匹配。

```csv
jargon,az_jargon_listen
GPU,graphics processing unit
CPU,central processing unit
```

範例僅示範格式，系統不會自動將這些範例加入正式資料。

## 路徑與部署

- 本機：`data/jargon/jargon_en.csv`（隨後端 `S2T_DATA_DIR` 調整）。
- Compose：既有 data 掛載中的 `/data/jargon/jargon_en.csv`。
- 指定不同檔案：後端環境變數 `S2T_JARGON_FILE`。
- Kubernetes：`npm run k8s:up` 會將本機 `data/jargon/jargon_en.csv` 放入
  `s2t-jargon` ConfigMap，所有後端 Pod 唯讀掛載到 `/data/jargon`。
  改用 `K8S_JARGON_FILE` 可指定部署來源檔。修改本機檔案後須重新部署，
  或直接更新 ConfigMap；直接更新時需等 Kubernetes 掛載內容同步。
- 大於 900 KiB 的 CSV：以 `K8S_JARGON_PVC` 指定既有共享 PVC，檔案須位於
  PVC 根目錄並命名 `jargon_en.csv`。該儲存必須可供所有後端 Pod 同時讀取。

每次請求會檢查檔案版本；未變動時使用已解析的記憶體快取。
讀檔與 CSV 解析在背景執行緒進行。每個 Pod 各自維護快取，依共用掛載的
新版本更新；掛載同步期間仍可能短暫讀取舊版。建議以原子替換方式更新 CSV。

檔案尚未提供或已移除時，以無匹配提示繼續翻譯；檔案存在但格式無效或
無法讀取時，翻譯 API 回傳 503，不會悄悄沿用舊的術語資料。

## Prompt

`gatewayTranslationZh` 與 `gatewayTranslationEn` 使用 `{glossary}` 插入加工後
術語；`{{glossary}}` 也支援。只執行一輪替換，原文和術語內的大括號不會被
當成第二輪 template。Markdown 翻譯也使用同一流程。

原有帳號術語表會保留在 `{{terms}}`。既有自訂 prompt 不會被覆寫；若舊版
模板沒有 glossary 欄位，CSV 結果會附加到 `{{terms}}`。自訂模板至少要包含
`{glossary}`、`{{glossary}}` 或 `{{terms}}` 之一，才能顯示 CSV 結果。
