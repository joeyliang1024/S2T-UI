# 舊格式紀錄的資料保存、版本修復與音訊保護

日期：2026-10-06（Asia/Taipei）；分支：feature/k8s-scale-docker-compatible。

## 真實重現

在隔離 PostgreSQL 建立專用模擬帳號，直接寫入舊格式資料，再呼叫實際 Gateway API。

- version 缺失、字串或小數：原 GET 回 200，但把非空紀錄回成空清單。負版本雖保留內容，卻不能按正常非負 CAS 版本同步。
- 無法辨識的字串／物件：原 GET 仍回空清單、POST 空 snapshot 也回 200，原資料被覆蓋。
- 舊陣列／損壞紀錄的音訊稽核，以及舊陣列的補償重試：將仍有參照的音訊判成孤兒，測試 WAV 隨後變成 404。

這些不是資料庫網路連線故障，也不能用新帳號正常來排除舊資料問題。測試只涉及額外建立的模擬帳號，未注入或刪改正式／原 100 帳號資料。

## 修正

新增共用 loadSessionSnapshot，套用到紀錄讀寫、音訊稽核、補償重試、背景工作建立與講者分離處理中的所有 session snapshot 讀取。

已知舊格式（陣列、非空 version 0、版本缺失／字串／負數／小數）在 adapter 的原子 update 鎖內修復。保留全部 sessions 和可辨識物件的其他根欄位，以新的安全整數 epoch 取代失效版本；不是單純重設 1，避免較早的正數版本快取也意外符合 CAS。正常正數版本不寫回，新的未建立帳號仍使用空清單 version 0。

同時讀到舊資料的請求在鎖內重新檢查目前值；只修復一次，不拿鎖外舊副本覆蓋別人剛保存的內容。舊 version 0／1 的空寫入回 409，新 epoch 的正常修改能保存。背景工作仍按現有 generation 和 CAS fencing 提交。

無法辨識的根格式回覆 503 與還原備份提示；原內容保留，禁止空 snapshot 覆蓋，也停止依空參照清單刪除音訊。這不代表能自動重建已經毀損或刪除的資料。

## 驗證

| 情境 | 證據 |
|---|---|
| 六種舊格式，每種 20 個同時 GET | 120 次均保留內容，讀到相同有效 epoch |
| version 0 與較早正數 1 的空寫入 | 各種格式均 409，既有資料保留 |
| 使用修復後版本保存新紀錄 | 各種格式均 200，版本正確 +1，讀回內容相符 |
| 無法辨識的兩種格式 | GET／POST 均 503，資料不變 |
| 舊陣列稽核／補償重試 | WAV 仍 200，位元組完全相符 |
| 損壞資料的音訊稽核 | 稽核 503，WAV 仍 200 且位元組相符 |
| 舊陣列的背景講者分離 | 正常排入 202，使用 mock 模型完成並保存安全版本 |
| 原 100 帳號資料 | 音訊 SHA256、翻譯、完成工作與聲紋全部通過 |

本地兩個 LocalConfigStore instance 的並行修復測試亦通過；真實 API 驗證使用隔離 PostgreSQL／MinIO。TypeScript、HTTP lifecycle smoke 通過。背景講者分離使用 namespace 內的模擬服務，未呼叫真實模型 API。

## 原始證據

- [修改前 API 結果](results/baseline.json)、最新修復與正常修改 (intermediate artifact removed)。
- [音訊誤刪重現](results/audio-before.json)、[音訊保留及背景工作](results/audio-fixed.json)。
- [100 帳號完整性](results/integrity-final.json)、results/local-smoke.txt、results/http-smoke.txt。

probe.cjs／audio-probe.cjs 須在具有隔離 Storage 環境變數的 Gateway 容器內執行，每次建立專用帳號並在 finally 清理。baseline 會故意重現該專用帳號的資料覆寫／音訊刪除；請勿在正式環境執行。測試輸出沒有認證 token。

目前隔離 K8s 使用 s2t-stress:20261006-legacy-history4。此輪驗證格式辨識與資料保護，不取代對特定使用者已損壞檔案／資料庫紀錄的根因調查。
