# S2T-UI 統一需求與改善清單

更新日期：2026-10-01。此檔為 repo **唯一待辦與需求狀態來源**。

已整併原 TODO、假日需求單、新版需求單、舊 Enhancement 長時間錄音設計，以及 README、docs 下的規劃、技術契約、部署與驗收文件；並納入本次程式碼盤點與使用者確認。前三份舊待辦已由本檔取代並刪除，歷史原文可從 Git 查閱。技術文件保留作為操作／契約參考，不再另訂優先順序。

**目前急迫需求只有：語者分離系統、斷句速度、翻譯模式。** 舊文件的 P0／P1、先做 storage、先做語系等排序不再沿用。先處理這三項需要的直接依賴，其餘按本檔分類追蹤；本次只整理文件，不代表已完成下列開發。

狀態規則：**部分完成**＝有實作但仍有明確缺口；**未完成**＝未見完整功能路徑；**待驗收**＝已有路徑、缺情境證據；**不確定**＝規格衝突、候選方案或外部契約未定。工程改善建議會明示，不把建議當成新增的使用者承諾。完成項目應移除待辦，保留版本、平台、步驟與結果於 [驗收手冊](guide/VALIDATION.zh-TW.md)。

已確認的共同規則：

- **NT 是公司唯一代號**，不是自由顯示名稱；匹配講者可顯示 NT，不要求額外真實姓名欄位。資料授權仍以後端驗證的穩定 user ID 為準，需補資料層 NT 唯一性。
- 支援 Web 與 Electron。Web 經 gateway 保存；Electron 可選本機／遠端保存，歷史載入須讀兩端。每種 storage 可獨立配置，整組未配置才使用本機 fallback；部分配置或已配置服務故障應報錯，不靜默改目的地。
- MinIO 放音檔，PostgreSQL 放帳號／設定／字幕／紀錄／摘要／模板／術語／聲紋管理資訊，Milvus 只放必要主鍵及 NT、Department、embedding。沿用 blob、config、vector 抽象層。
- 正式 Electron 連外部 HTTPS gateway，以 `S2T_GATEWAY_URL` 配置，不內嵌或啟動 gateway；本機服務供測試。沒有外部環境不阻擋本機功能開發與驗收。
- 聲紋預設私有；同部門／跨使用者共享需擁有者明確同意，後端限制候選集合及刪除權限。人工講者修改不得被自動結果覆寫。
- 保留現有翻譯策略；重講保留原音檔與可切換版本；重構和外觀改版分開驗證。模型失敗不得導致已錄音訊遺失。
- UI 五語系為繁中、簡中、英文、日文、德文；這不等於 ASR／翻譯能力。模型目前介面提供中、英、日、德，具體雙向規則見 Q02。

## 1. 優化

### O01 結構拆分與共用契約 — 部分完成（原 25；舊 N13）

現況：App.tsx 已是入口，auth、storage、翻譯策略、摘要規劃、術語解析已有模組；摘要工作區／渲染與講者批次改名已拆為獨立 view component。主要流程仍集中於約 1,959 行的 useAppController，畫面仍有大型 AppView 區塊。

- [x] App.tsx 已收斂為 auth gate 與 controller/view 組裝；應用行為分別位於 auth hooks/views、app controller 與 app views/services，入口檔不再承載收音、翻譯或 Storage 邏輯。
- [ ] 將即時字幕、歷史、摘要、匯入、模型、聲紋、設定與浮動字幕拆為各自 view／components；拆出收音生命週期、音源切換、字幕、翻譯、歷史與設定 hooks。
- [ ] 按責任拆 HTTP／WebSocket adapter、gateway 路由／模型代理，以及 Electron 錄音、session、金鑰、IPC、視窗服務；避免僅把大檔移到另一個大檔。
- [ ] 統一 session、segment、speaker、model、錯誤及資料版本契約；必要回歸涵蓋亂序 revision、時間軸、取消、資料遷移與權限。
- [ ] 拆分時維持現有外觀與行為，確認錄音、翻譯、匯入、保存、舊金鑰與浮動字幕不退化；相關 feature 修改時逐步完成，不以全 repo 重構阻擋三項急迫需求。

### O02 長時間錄音、字幕與資源上限 — 部分完成（舊 Enhancement／TODO 長錄音設計）

現況：Electron 持續寫 WAV，已有約 125 ms PCM 批次、寫入 ACK、約 2 秒待寫入保護；HTTP ASR 有佇列上限及 gap 事件。Web 仍累積完整 PCM，字幕／session 仍持有完整陣列。不能把既有背壓、AudioWorklet 或逐片 WAV 讀取重新列為未實作。

- [x] Web 收音在支援 OPFS 的瀏覽器逐片寫入暫存 PCM16 WAV，記憶體只保留 ASR／VAD 所需緩衝；停止時以磁碟 backed Blob 保存，完成後清理暫存檔。不支援 OPFS 時保留既有記憶體 fallback，需在 V09 量測其限制。
- [ ] 已顯示瀏覽器儲存使用量／配額、OPFS／記憶體／Electron 暫存模式與持久儲存授權狀態；Electron／OPFS 都有寫入背壓、暫停／自動續錄與可理解錯誤。仍需補不支援 OPFS 時的短暫預覽限制。MediaRecorder 壓縮 blob 方案須驗證容器與播放，不以改副檔名冒充 WAV／MP3。
  - [x] Web 設定頁已顯示瀏覽器儲存使用量／配額、OPFS／記憶體／Electron 暫存模式及持久儲存授權；不支援 OPFS 的 RAM fallback 以 256 MB 為上限，觸頂會暫停並要求先保存目前錄音，不會無界累積或靜默丟失已收音訊。
- [ ] 逐字稿改為可增量持久化與分頁讀取，UI 虛擬列表只載入最近／可見內容（舊設計建議 200–500 筆）。搜尋、CSV、摘要走持久資料；清除字幕只移動顯示游標。
  - [x] 即時字幕未搜尋時只渲染最近 500 段，避免長時間錄音讓 live DOM 無界成長；完整逐字稿仍供保存、匯出、摘要與關鍵字搜尋使用，清除字幕仍只移動顯示邊界。
- [ ] 保存 session completion marker、錄音／字幕游標與暫停、音源切換、缺口事件，以便強制關閉後復原；錄音與字幕使用一致有效錄音時間，另記牆鐘事件。
  - [x] Web 收音期間會將帳號隔離的 live draft（final 字幕、時間、暫停狀態、來源與 OPFS 暫存識別）持久化至 IndexedDB；正常完成會清除，強制關閉後重開會轉成可查看的「復原字幕」歷史項目，並在 OPFS 檔仍可讀時重建 WAV 供播放。
- [ ] 量測 Electron 慢磁碟與 IPC 待處理量，finish 等 ACK 並核對 sample count。評估 sequence、persistedBytes、credit 契約；MessagePort／transferable 是候選優化，不是現有 ACK 方案未完成的理由。
- [ ] gateway 已分 ASR／翻譯／摘要限流桶，仍需獨立併發上限、Retry-After 與可診斷錯誤；ASR 優先，不讓附屬工作堵塞收音。翻譯排程統一追蹤 U03，分離視窗統一追蹤 U01。
  - [x] gateway 以獨立 bucket 限制 ASR 60／分鐘、翻譯 30／分鐘、摘要 12／分鐘、語者分離 8／分鐘；限制回應包含 `Retry-After` 與 `retryAfterSeconds`，隔離 gateway smoke 已驗證語者分離的限制與 header。

設計保留：音訊 chunk 至少包含 sessionId、chunkIndex、start/end sample、MIME；字幕事件包含 sessionId、order、revision、updatedAt，索引可按 sessionId＋startMs。背壓不得靜默丟掉原始 WAV；無法寫入時明確暫停／停止。

### O03 儲存同步、遷移與故障恢復 — 部分完成（原 10；舊 V04）

現況：三類 adapter、本機帳號隔離、並行 config 寫入、損毀檔報錯、CAS 與保留遠端衝突副本已有。本機 config 以同程序序列化加 lockfile 跨程序保護；兩個獨立 Node 程序競爭同一 CAS 已驗證僅一方成功。

- [x] session 遠端保存已改為單一序列化、合併最新 snapshot，避免同視窗連續保存使用相同版本造成自我衝突；同步錯誤後可由設定中的「重新載入並同步遠端紀錄」重新載入、合併並恢復同步。
- [x] Web 一般設定已以帳號 scope 寫入外部 config，登入時載入並以 CAS 同步；摘要模板與術語各自使用版本端點，避免互相覆蓋。gateway smoke 已驗證跨帳號隔離與版本衝突。
- [x] 設定頁已顯示全域遠端同步中／正常／暫停、實際 blob／config／vector adapter 與 schema version，並可重新載入遠端紀錄或手動重試 Storage 補償；同 ID 不同內容仍以保留遠端衝突副本處理。
- [x] 歷史紀錄逐筆顯示本機、遠端、本機＋遠端與待同步狀態；遠端保存失敗會將非遠端-only 記錄標示為待同步，重試成功後改為本機＋遠端。
- [ ] 最終衝突選擇規則見 Q05。
- [ ] 設定、模板、術語、文字與音檔的帳號範圍和保存目的地一致；修補載入競態、部分成功、配額不足、跨程序鎖定及損毀復原。
- [x] Web 已按登入 user ID 將舊 IndexedDB session 的未遷移音檔上傳至遠端 blob storage，成功後再同步 session 引用；本機保留遷移 marker，失敗於下次登入重試。
- [x] fallback→外部 Storage 有保護式遷移命令：先 dry-run 盤點，再以 `--apply` 搬移帳號、設定、術語、blob、向量與聲紋 metadata；同 key 不同內容不覆蓋。已以本機 fallback 資料遷移至 Docker 的三個外部服務驗證，既有同名 admin 可明確採用外部帳號 ID。
  - [x] `--apply` 會在來源資料夾留下權限受限的 migration journal，記錄完成、衝突或失敗；中斷後的下一次 run 會標示前次未完成，保守新增／衝突保留的 copy 可安全重跑。目標 PostgreSQL 以 advisory lock 序列化整個 migration，避免兩位操作者同時搬移。已以明確 scope mapping、帳號採用與 Docker 外部服務完成實測。
- [x] fallback 遷移只會處理可由本機帳號記錄對應的 scope；匿名／無帳號設定、blob scope 與無 metadata 的向量會列在 `unowned` 並跳過，不會自動歸給任一帳號。人工確認歸屬後可用受目標帳號存在性驗證的 `S2T_MIGRATION_SCOPE_MAP_JSON` 明確遷移。
- [x] PostgreSQL／Milvus 的聲紋註冊與刪除具持久補償紀錄；MinIO／本機音檔先進入待 session 確認清單，session CAS 成功後確認引用或清除孤兒檔。清理失敗會保留並於下次操作或手動按鈕重試。
- [x] 外部 gateway 補償整合測試已驗證：未提交 session 的音檔會由重試清除、已提交 session 的音檔保留，聲紋補償佇列可清空；測試使用臨時帳號並於結束後刪除。
- [x] 外部 MinIO 與 Milvus 故障恢復測試已驗證：服務停機時音檔／聲紋補償維持 pending，重新啟動後重試可清除 blob、metadata 與佇列；測試只操作本機 Docker Compose。
- [x] session 更新會在 CAS 前記錄不再引用的音檔清理意圖，CAS 成功後回收原始、接續及重講版本的遠端 blob；刪除 session 的實測已覆蓋此流程。
- [x] 遠端 Storage 設定區可稽核與清理未被 session 或待補償項目引用的舊音檔 blob；稽核與清理均需登入且依帳號 scope 執行，外部 smoke 已驗證發現、清理及 404 確認。
- [x] 已完成向量與 metadata 同時間點備份還原與跨程序失敗注入驗收。
  - [x] 外部 PostgreSQL／Milvus 的聲紋快照會驗證 metadata、聲紋清單與 embedding 完整性，還原以交易替換 metadata 並復原向量；`storage:voiceprint-backup:smoke` 已在 Docker 服務驗證刪除後可完整還原，且注入設定寫入失敗時會回復向量與 metadata。
  - [x] PostgreSQL 以帳號級 advisory lock 序列化聲紋 metadata 的完整替換；外部 smoke 會由兩個獨立 Node 程序同時還原同一快照，確認最終 metadata、聲紋清單與 Milvus embedding 一致。
- [x] `/api/storage` 回報 blob／config／vector adapter 模式、schema version 與 ready 狀態；PostgreSQL 記錄 `001-core-storage` migration。
- [x] 本機 Docker Compose 與 adapter fallback 已分開驗證：`storage:smoke` 僅驗證本機替代層；`storage:remote:smoke` 實測 MinIO blob、PostgreSQL CAS 與 Milvus upsert/search，web `/api/storage` 也已回報三個外部 adapter。
- [x] PostgreSQL schema migration 以 advisory lock 序列化；remote smoke 已用兩個獨立程序驗證同時啟動不死鎖、同一 CAS 僅一方成功。
- [x] fallback local config 以 lockfile 跨程序序列化 read-modify-write；`storage:smoke` 已由兩個獨立 Node 程序驗證同一 CAS 僅一方成功。
- [ ] 實際外部部署與 V08 的跨程序、離線、配額、權限錯誤及備份還原驗收。

### O04 登入、NT 與憑證可靠性 — 部分完成（原 2、10）

- [x] NT 以公司範圍、大小寫不敏感方式強制唯一；本機使用原子 reservation，PostgreSQL 使用唯一索引，重複註冊回傳 409。既有遠端重複 NT 會讓 migration 明確失敗，需先人工合併後再建立索引；大小寫及格式正規化見 Q01。
- [ ] 工程補強：測試預設 admin 初始化不得覆蓋既有帳號；正式環境避免使用 admin/admin，補登入嘗試限流、token 逾期／撤銷與可理解的登入失效動線。改環境密碼不等於既有帳號密碼已更新。
  - [x] 預設使用者只在帳號不存在時依環境變數建立；重啟後改動 bootstrap 密碼不會覆蓋既有帳號。`storage:smoke` 已驗證原帳密仍能登入、新密碼不會被套用。
  - [x] JWT 為 7 天有效期且帶唯一 jti；登出會在帳號範圍的 config 儲存撤銷紀錄，之後同一 token 的 session 與受保護 API 均失效，過期撤銷紀錄會在讀取時清理。
  - [x] gateway 對同一 IP＋帳號在 15 分鐘內限制 8 次失敗登入，成功登入會清除失敗紀錄；隔離 gateway smoke 已驗證第 9 次回傳 429，帳號與 Storage API 隔離不受影響。
- [ ] Electron 以 gateway 驗證身分決定帳號目錄，登出清除主程序身分；換帳號時設定、金鑰、模板、術語、字幕、摘要、WAV、復原 manifest 均隔離。
- [ ] API key 僅存後端或 Main safeStorage，不能進 DOM、localStorage、URL、匯出或日誌；逐模型綁定憑證，避免文字服務共用 key slot 導致切模型後錯用憑證。
  - [x] Web 的模型 key 現在只經已登入 gateway 的單向寫入端點保存；gateway 以其持久 auth secret 派生 AES-256-GCM 金鑰、帳號 scope 與模型 ID 加密保存，registry 的讀取回應不會包含 key。Electron 繼續使用 Main safeStorage；gateway smoke 已驗證 key 不會由 registry 洩漏且可刪除。
- [ ] 簡易登入先維持可用，不自行擴成完整企業 IAM；未來 TSSO 另見 Q07。

### O05 模型管理、語言與音訊契約一致 — 部分完成（原 19、26；舊 N03、N04）

現況：模型列表、搜尋、用途篩選、註冊／編輯、ASR 能力欄位與 Electron ASR 免 key 已有；Web 已有環境 ASR 多模型列表及 profile ID 路由，尚不等於完成使用者註冊 registry。

- [ ] Web 註冊／編輯模型接上後端 registry，實際 endpoint、model ID、key、用途與選項一致；翻譯／摘要仍固定環境服務的路徑需接上選擇。
  - [x] gateway 已提供帳號隔離、版本化的 model registry，保存 ASR／翻譯／摘要／語者分離／embedding 的名稱、endpoint、model ID、用途、免 key 與能力欄位；隔離 smoke 已驗證跨帳號不可讀取及 CAS 衝突。
  - [x] Web 模型管理的 ASR、翻譯、摘要與講者分離修改會載入並以版本化 registry 回存；環境模型先載入，再套用使用者模型，避免預設服務覆寫使用者設定。模型 key 以獨立加密端點寫入，不進一般 settings 或 registry；Web ASR、翻譯、摘要與講者分離會以選定 ID 在 gateway 解析帳號模型與憑證後代理呼叫，smoke 覆蓋 ASR、翻譯與摘要的選擇路徑。
- [ ] 四類既有模型統一表單與保存語義；新增聲紋用途見 F01。明確免 key 模式延伸至 Web 及其他用途，不能用假 key 代替。
- [ ] 即時開始、匯入與片段重講都會依模型宣告語言能力拒絕不相容設定；接續沿用開始時設定。仍需實機驗證錄音中改語言與全流程取樣率，未知能力不得當成全支援。
  - [x] 即時收音保存時，session 與其 audio version 都會保存實際模型 ID、endpoint、model、傳輸類型、能力、語言、術語 prompt，以及原始／模型取樣率快照；日後修改 registry 不會改寫既有收音的追查資料。
- [ ] 即時 ASR 已真正重取樣；PCM WAV 匯入與片段重講也會解碼、downmix、重取樣後送 ASR，錄音原始檔與字幕 offset 不變。仍需對非 WAV 匯入、模型能力缺失與各流程的原始／模型取樣率追蹤做實機驗證；不要只改 WAV header。
- [ ] 固定模型選擇於收音開始；目前鎖定策略不等同需開發熱切模型。能力探測、真正串流與熱更新的服務契約見 Q03。
  - [x] 即時收音開始後，完整設定與快速設定中的 ASR 模型選擇皆會鎖定；本次收音使用的 adapter 與模型快照不會隨 UI 設定變更而切換。
- [ ] 驗證 maxPayloadBytes、音訊格式、language／prompt、時間戳來源、逾時與錯誤回應；配置錯誤應明示，不默默改用其他模型／語言。
  - [x] Web ASR gateway 已拒絕未支援的 MIME 類型（415）與不支援的語言代碼（400），不再以通用二進位格式或預設語言靜默轉送。

### O06 重講、接續與版本一致性 — 部分完成（原 20、21）

- [x] 重講保存音訊與 ASR 輸入已統一使用固定原時間槽：超長裁切、過短保留靜音；保存 WAV 正確 downmix，字幕不再描述被裁掉的聲音。時間軸規則見 Q04。
- [x] 音檔版本保存相應的字幕、翻譯與時間軸快照；切換會一併還原文字，所有目前版本的講者／文字／時間軸編輯與語者分離也會回寫快照。摘要保存來源版本與逐字稿簽章，版本或文字不符時會要求重新產生。
- [ ] 接續已以所選音檔實際時長作為字幕 offset，保存後以有效收音時間更新總時長並保留父版本；仍需驗證保存失敗回復、重試不重複追加、多聲道重講 WAV 長度及解碼錯誤時 AudioContext 清理。
- [ ] 歷史載入即時區之前保護未保存／未提交編輯，錄音中限制清楚；編輯後搜尋、複製、匯出及摘要過期提示同步。
  - [x] 即時字幕有未保存內容時，載入歷史紀錄會以五語系確認視窗保護；取消會保留現有字幕，收音中則仍拒絕載入。

### O07 全介面語系、主題與可用性 — 部分完成（原 11、12、22、23、24；舊 N01、N02）

UI 視覺優化的最後順位參考：使用者提供的 [Threads prompt](https://www.threads.com/share/BAZd9qWfxy/) 提倡 Linear／Arc／Raycast／Apple／Stripe／Vercel 等級的乾淨黑白產品介面、單一可延展主體、可見而有因果的互動、克制的彈簧與液態 tab／toggle／slider 動態。此項排在所有功能、可靠性與驗收之後；落地時仍須遵循無障礙、可讀性與既有工作流程，並不將影片、音樂或 1440×1440 動畫輸出誤當成產品功能。

- [ ] 移除 AppView、controller 與錯誤路徑固定文案，涵蓋五語系、無障礙名稱、日期及排序 locale。業務狀態不能依「正在產生摘要…」等顯示文字判斷。
- [ ] 統一色彩、字級、間距、密度、圖示、焦點與狀態 token；整理重複 CSS 覆寫，逐頁核對深／淺／系統主題。已有 light CSS，不列為需重新建立整套主題。
- [ ] 改善長內容、窄／低視窗、對話框、選單關閉及焦點管理；錄音、模型、翻譯、保存與錯誤狀態可辨識且不只靠顏色。
- [ ] 歷史側欄大量資料分頁／虛擬化，保留「全部紀錄」入口；浮動字幕的字級、可讀性、置頂／全螢幕及低干擾控制回歸。
- [ ] 側欄左右位置先依 Q06 收斂，不直接恢復舊拖曳浮層。即時參數內容缺口先由 U02 處理。
- [ ] 視覺改版和業務邏輯分離；美術僅用在非關鍵資料區，來源、授權與對比需記錄。參考圖未在 repo 內時不得宣稱像素驗收完成。

### O08 摘要、模板、術語與輸出品質 — 部分完成（原 6、9、13、16、17）

- [x] Markdown UI 已支援表格、粗體、受限的 HTTP(S)／mailto 連結、引用、巢狀列表、inline／區塊程式碼與標題；以 React 節點渲染，不插入不可信 HTML。摘要匯出保留原始 Markdown，與畫面內容一致。
- [ ] 摘要已有分段／分層合併與 generation／來源簽章；補模型上下文預算、超時／取消、失敗重試、晚到回應與來源更新的一致性，不能靜默截掉長逐字稿。
- [ ] 自訂模板會立即保存：Electron 使用帳號範圍本機設定；Web 使用版本化遠端模板 API，跨重開會載入，衝突與保存失敗會提示。即時摘要、摘要頁與歷史卡片摘要複製共用失敗提示；仍需補實機跨視窗合併／重新載入動線。
- [ ] 術語 JSON 物件／陣列匯入、1 MB 限制、去重、逐筆管理、帳號版本及 ASR／翻譯套用驗收；保留返回來源頁，不恢復舊「重新載入伺服器術語」按鈕。
- [ ] 確認匯出選項、搜尋後範圍、時間／講者／翻譯與目前版本一致；VTT 特殊字元／時間檢查、CSV BOM／引號／換行與 gap 原因維持正確。
  - [x] `transcript:export:smoke` 驗證 VTT 的時間、`<v 講者>`、原文／譯文特殊字元跳脫與排除 gap，以及 CSV 的 BOM、講者欄與 gap 原因輸出。

### O09 降噪、取樣率研究與觀測 — 部分完成（原 15、18）

- [x] 已顯示 noiseSuppression 音軌實際回報的已套用／未套用／未知狀態及生效時機；設定套用到即時收音、片段重講與聲紋取樣的新建 stream，錄音和 ASR 共用即時收音的處理後 stream。
- [ ] 相同素材比較 48k→16k、44.1k→16k、原率直通與降噪開關，記錄 CER／WER、聲紋誤配／漏配、聽感、頻寬、延遲、CPU／記憶體、樣本數與時間戳。
- [ ] 比較聲紋端線性重取樣與 ASR 端重取樣品質，依實測決定預設，不假定更高取樣率一定更好。獨立降噪模型見 Q08。
- [ ] 量測收音、VAD、傳輸、推論、字幕更新及翻譯各階段；每分鐘記錄 renderer heap、Main RSS、pending PCM、各 queue depth、P50／P95、gap、CPU、event-loop delay 與磁碟用量。
- [ ] 建立 5–10 分鐘可重現 fixture；2 小時錄音、4 小時／10,000 段字幕與大檔壓測詳 V09。具體資源／品質門檻見 Q09，不把早期目標當已達成承諾。

### O10 技術文件與部署說明一致性 — 部分完成

- [x] docs/ 依用途分四類並建立索引：`guide`（操作）、`reference`（契約與架構）、`research`（歷史研究與規劃）、`reports`（量測報告），新增 `docs/README.md` 分類索引；根目錄 `0930_plan.md` 移為 `docs/research/K8S_SCALE_PLAN.zh-TW.md`。全 repo 連結、程式碼內文件路徑註解與 README 同步翻新（瘦身為分類索引＋快速開始＋常用指令，長篇 Storage 操作併入部署文件）。
- [ ] 技術文件的操作範例持續核對現有 code：模型註冊位置、儲存與認證、能力欄位、語者分離即時／離線路徑、檔案大小、取消行為。
  - [x] Gateway 文件已同步 Bearer auth、100 MB 格式上限、模型 registry／加密 key 寫入端點、選定帳號模型代理與目前的限流／錯誤行為；部署文件已說明 bootstrap 帳密只建立新帳號、不會覆寫既有密碼。
  - [x] README、部署與 sherpa 操作文件已同步 Web 啟動順序、`5173`／`8787` 的責任、常見 404／Origin 問題、完整 `.env.example` 與 Linux x64 離線模型 image；`joeyliang1024/s2t-sherpa-models:1.13.8` 已以 `linux/amd64` 建置並驗證包含 segmentation、embedding 與授權檔。
- [ ] 將歷史研究中的「不依賴 sherpa」與現有可選 sherpa gateway 區分；API key 留空不代表不需要登入 token；前端／後端聲紋樣本長度檢查需一致。
- [ ] 部署範例不可誤把本機 adapter 測試當遠端整合證據；Docker 資源／版本、TLS、備份還原、故障檢查及乾淨環境安裝需可重現。

## 2. 新功能

本章保留舊設計中尚未完整提供的能力；已有 UI 但後端未接通的改善列於第一章。未確認的產品延伸放第五章，不自動納入交付。

### F01 聲紋模型用途與註冊管理 — 未完成（原 26；假日需求單第 6 節）

- [ ] 在模型列表獨立表示聲紋／embedding 用途，填 name、model ID、endpoint、key／免 key、用途、模型版本與能力；不要把語者分離服務等同 embedding 服務。
  - [x] 模型列表已有獨立的 Embedding 篩選頁與「註冊 Embedding」入口，可保存名稱、endpoint、model ID、key／免 key 至帳號專屬 registry；它與講者分離分開呈現。模型版本、能力宣告與實際聲紋服務套用仍待完成。
- [ ] 註冊樣本、比對與 Milvus 維度／版本相容性接上選定模型，變更模型後提示重註冊／遷移；一般聲紋錄製／上傳／刪除已存在，不重做。
- [ ] 驗收新增、編輯、刪除、重開、憑證綁定與實際呼叫一致；此項作為 U01 的直接依賴時先處理必要部分。

### F02 大檔轉錄 checkpoint 與續跑 — 未完成（舊 Enhancement 第四階段）

現況：PCM16 WAV 已採 RIFF header＋File.slice 逐片讀取，每段約 45 秒、重疊 1.5 秒，Web 可 abort 當前請求。

- [ ] 保存 job ID、原檔 fingerprint（名稱／大小／lastModified／必要 hash）、next byte offset、完成片段及模型／語言／prompt 設定快照。
  - [x] Web PCM16 WAV 匯入會以登入帳號範圍的 IndexedDB checkpoint 保存檔案名稱／大小／lastModified、next chunk／byte offset、完成字幕、模型快照、語言與術語 prompt；來源檔不複製，避免重複佔用大檔空間。
- [ ] 重新選同一檔可從完成位置繼續；取消／重啟保留 checkpoint，設定改變建立新 job，不混用結果。
  - [x] 同一 WAV 與相同模型快照、語言、術語設定會從已完成 chunk 接續；取消、請求失敗或重開會保留 checkpoint，成功才刪除。變更設定會從第 1 段重新建立結果，不混入舊段落；`import-checkpoint:smoke` 已覆蓋檔案、模型、語言與術語設定的接續匹配／拒絕條件。
- [ ] 分段同時受模型 payload 上限約束；保留原始 ASR 結果與重疊去重決策。Electron 當前請求取消需補對等路徑。
- [ ] 2 GB fixture 驗證記憶體只與單段＋overlap 有關，續跑不重複、不漏段；取消清理與進度可見。

### F03 大型非 WAV／影片轉碼工作 — 未完成（舊 Enhancement 第五階段）

現況：非 WAV 單次 100 MB 上限、原始檔名與 MIME 轉送已有，不能再把舊 12 MB 不一致列為未修。

- [ ] 受控 server job 串流上傳到隔離暫存、轉 PCM16 WAV、分段 ASR，提供進度、取消、逾時、TTL 清理與磁碟配額。
- [ ] 轉碼器放服務端 worker，renderer 不內嵌 FFmpeg、不一次讀入整個大型影片；輸出／錯誤契約與 WAV job 一致。
- [ ] 驗證 20–100 MB 既有單次路徑及超過上限的新 job；依實際模型能力決定格式白名單，不承諾任意容器。

### F04 Electron 可交付安裝包 — 未完成（舊 TODO 發布與品質）

- [ ] 補打包設定、CI、圖示、版本與發行產物；production build 不等於可安裝包。
- [ ] 依 Q07 決定 macOS 架構、Windows 版本及打包工具，接簽署／notarization；憑證不進 repo。
- [ ] 乾淨裝置安裝後驗收 HTTPS gateway、麥克風／系統音訊權限、safeStorage、浮動字幕、保存與換帳號；見 V07。

## 3. 急迫需求

### U01 語者分離系統 — 待驗收（原 1、27；舊 N11）

**目標：已註冊聲紋命中顯示 NT，未命中自動分群，字幕可編輯講者；即時與歷史均可使用。**

現況：本機 sherpa 與外部分離服務皆會將分群結果接到可見聲紋比對，命中顯示 NT；未命中會維持匿名群組。Web 與 Electron 都使用最近 45 秒緩衝，每 15 秒預覽一次，並以重疊區間穩定匿名 ID；即時講者預覽可獨立開關，失敗不會中斷收音，會顯示狀態。字幕可直接手動輸入或從註冊 NT 清單選取講者。這不是原生逐 frame 講者辨識，仍須以 V01 的真人素材量測穩定性與誤配。

- [x] 外部分離服務回傳統一接上聲紋匹配；不能只在本機分支命中 NT。
- [x] 跨窗口以重疊區間維持匿名 ID；預覽標示暫定，完整檔最終處理保留人工修正。
- [x] Web／Electron 都改固定窗口，預覽可獨立開關、錯誤可查，分離失敗不會中斷 ASR、登入或保存。
- [x] 即時與歷史可手動編輯／指派講者；輸入欄提供註冊 NT 選擇入口，即時字幕可依原講者批次改名，人工結果優先。
- [ ] 校正樣本品質、匹配門檻、不同模型版本／維度、短句、噪音及多人重疊；一段字幕跨多人時不能把最大重疊策略宣稱為精準逐字講者。
  - [x] 註冊前會拒絕少於 3 秒、RMS 低於 -45 dBFS 或削波超過 2% 的 PCM16 WAV；註冊 metadata 保存樣本時長與 RMS，`diarization:smoke` 已覆蓋可接受、過短、過低音量與削波樣本。
- [ ] 共享、刪除與向量 metadata 一致性補齊；NT 已在本機與 PostgreSQL 以大小寫不敏感方式強制唯一，模型用途必要部分追蹤 F01，帳號／storage 共用修正在 O03、O04。

完成條件：已知＋至少兩名未知講者交替對話，跨 45 秒窗口與長停頓仍穩定；Web／Electron 即時回填、歷史最終分離、人工修改、重開、VTT／JSON 講者一致；未登入／私有／同部門／跨部門／刪除權限均符合規則；ASR 與錄音不受分離失敗影響。保留誤配、漏配、分群錯誤及 CPU／延遲數據（V01）。

### U02 斷句速度 — 部分完成（原 7、24；關聯 15、18、19）

**目標：斷句快慢可調、字幕及時出現，又不切掉句首／句尾或把連續語句切得過碎。**

現況（2026-10-01）：逐項 VAD 滑桿已移除，收音控制側欄只保留單一「回應速度」滑桿（快／正常／慢），內部對應 `responseSpeedVadConfig` 三組預設（快 700/1200/150、正常 700/1500/250、慢 1000/2400/800）；滾動上下文 prompt 與 ASR 輸出清洗已進產品碼，Settings schema 由 `vadConfig` 收斂為 `responseSpeed`。`npm run caption:eval` 以真實收音節奏實測 Breeze-ASR-25：對話素材（前 300 秒、32 句）正常檔首筆字幕 P50 1029 ms／P95 1701 ms，「≤2500 ms」目標達成率 100%。第二輪以同場六組（BGM）＋九組（無 BGM 旁白）矩陣按「快＝延遲、慢＝CER、正常＝穩定」定案：快維持 700/1200/150（chunkMin 500 無可測收益、chunkMax 1000 漏 4/32 句）、正常維持 250（250 vs 350 產生相同 chunk 流）、慢的 `minSilence` 500→800（無 BGM 語料 CER 10.27%→8.35% 重跑同值、BGM 不回歸）。三速與各輪對照數據、淘汰依據見[字幕延遲調校報告](reports/CAPTION_LATENCY.zh-TW.md)。UI 連續 final 合併上限維持約 12 秒。

- [x] 斷句參數收斂為三速：移除設定頁 VAD 卡片 6 支滑桿與收音面板 3 支 inline 滑桿，改為收音控制面板單一「回應速度」滑桿（快／正常／慢，i18n 五語系＋無障礙標註）；`responseSpeed` 隨設定持久化，舊存檔逐項參數自動丟棄正規化。
- [x] 快速設定保留即時講者預覽、音源、語言、翻譯開關與目標語言；收音中變更於下一段音訊生效。
- [x] 量測語音開始→首段字幕與模型耗時／佇列等待：`caption:eval` 記錄逐句上屏 P50/P95、ASR 推論與排隊延遲、請求數、碎片化與逐句／語料 CER，並產出 `experiment/evaluation-reports/` JSON；正常檔 P95 1701 ms 已達成 ≤2500 ms 目標。**句尾→final（endpoint delay）指標與日文／中英混說素材仍在 V02。**
- [x] 靜音不持續送空 ASR，短停頓不過度切段，長句有上限，停止不足一段的尾音 flush；HTTP gap／重試／背壓可見。`vad:smoke` 已覆蓋起音門檻、短停頓與靜音句界。
- [ ] 收音中調整明示立即／下一段／下次開始生效，避免重建 capture 造成缺口；App／server VAD 不互相重複裁切。
  - [x] 收音中變更語言、術語或切段設定時，HTTP chunked ASR 會明示「下一段音訊生效」且不重建 capture；未定義 live-setting 協定的 WebSocket 模型會明示需下次開始，避免假稱已即時套用。

完成條件（現況）：已以 32 句對話素材完成快／中／慢三速比較，記錄首段 P50/P95、請求數、漏字與碎片化（BGM 素材、含快速對談、短停頓、長句），並以無 BGM 旁白素材（18 段）補齊三速對照；**仍缺**日文、中英混說、鍵盤噪音素材，句尾→final 指標，以及 Web／Electron 雙平台收音中調整的驗證（V02）。

### U03 翻譯模式 — 待驗收（原 3、4、5；舊 N05）

**目標：保留原策略，提供較低負載選項、即時／整句，以及範圍內自動辨識來源並產生正確方向的翻譯。**

現況：保留自動、手動、即時與整句策略，新增節流模式（每次最多送一段並延後 900 ms），即時待翻譯工作上限為 6；停止收音時，非手動模式會逐段完成尾句，不會突破上限。ASR gateway／Electron 回傳的偵測語言會正規化為中、英、日、德；選擇「自動雙向」時中文譯英文，其餘支援語言譯繁中，同語言會略過請求。仍須用 V03 評估混說與無明確語言結果時的 fallback 品質。

- [x] 保留既有策略，新增節流模式、有界 pending 與手動控制；翻譯不會無限累積或阻擋 ASR／保存。
- [x] 整句以標點／VAD 停頓累積，日文涵蓋 。！？；保留 5 秒最大等待與停止收音時的尾句完成。是否必須嚴格等完整句見 Q02。
- [x] gateway／adapter 保留並正規化 ASR 偵測語言；無回傳時才走既有 fallback。
- [x] 補限定語言配對的自動翻譯方向與同語言略過規則。
- [ ] 目標語言、模型或原文變更後，舊回應不得污染新結果；模式切換、取消、失敗重試、停止／重開狀態一致。Electron 目前取消多為忽略回應，補真正中止的可行路徑。
  - [x] 目標／來源語言、翻譯 endpoint、模型或術語變更會遞增翻譯 generation；Web 會中止仍在執行的請求，Web／Electron 的晚到回應都會因 generation 不符而被忽略，不會寫回舊設定的譯文。
  - [x] Electron 翻譯請求帶 renderer 範圍的 request ID；取消或切換設定會透過 IPC 中止 Main process 的 `AbortController`，不再只忽略晚到結果。
- [ ] Web／Electron 的 prompt 與實際模型一致，保留 HY-MT 既有適配背景但不把單一模型 prompt 當所有模型通用契約；registry 路由見 O05。

完成條件：相同音訊比較各模式請求數、等待／完成延遲、譯文完整度與錯意；手動模式零自動請求；測無標點長句、日文、混說、自動方向、最後尾句、5xx／429、取消及人工編輯後晚到結果；翻譯失敗時原文與 WAV 正常保存（V03）。

## 4. 待驗收

本章是驗證清單，不是第四組急迫需求。引用的功能若仍有缺口，先完成對應 O／F／U 項再簽核；不因已有 smoke 或 UI 就宣稱上線。

### 已有基線與證據邊界

2026-10-01 滑桿改版一輪實際通過：`typecheck`、`build`、`model-adapter:smoke`、`i18n:smoke`、`vad:smoke`、`translation-policy:smoke`、`storage:smoke`；字幕延遲基線以 `caption:eval` 實測（三速與對照組數據見[字幕延遲調校報告](reports/CAPTION_LATENCY.zh-TW.md)），原始數據在 `experiment/evaluation-reports/`。以下為更早一輪於 2026-09-26 通過的基線：`typecheck`、`build`、`git diff --check`、`storage:smoke`、`resample:smoke`、`glossary:smoke`、`model-adapter:smoke`、`translation-policy:smoke`、`summary-plan:smoke`、`summary-templates:smoke`、`i18n:smoke`。每次文件整理輪不重跑程式測試，不沿用為後續修改的通過證據。

既有文件另記錄 gateway 授權 smoke、Breeze 中文 WAV、HY-MT 英／日翻譯、本機 sherpa 靜音 WAV／原生 addon 成功；本輪未重新驗證。模型 API 有回應不代表麥克風端到端或多人辨識品質完成。字典測試只涵蓋已登錄 key；storage smoke 只涵蓋本機 adapter。每筆實機結果記版本／dirty diff、平台、模型版本、素材、設定、步驟及量測，憑證不得寫入。

| ID | 驗收範圍 | 通過條件／依賴 |
| --- | --- | --- |
| V01 | 語者與聲紋 | U01、F01 必要部分；註冊品質、混合多人、穩定匿名編號、NT、人工保護、模型不相容及共享／刪除權限；重開、匯出一致。 |
| V02 | 斷句與即時收音 | U02；30 秒真人＋固定素材，至少三段按序、尾音保留；10 秒靜音、500 ms 周邊停頓、長句、參數變更、慢模型／gap 均可重現。 |
| V03 | 翻譯策略 | U03；即時／整句／手動／低負載策略的請求數與品質比較，自動方向、取消、重試、停止、revision 及模型切換邊界。 |
| V04 | 歷史、搜尋與匯出 | 原 8、9、14、16、17、22；名稱／建立時間／時長升降冪及同值穩定性、搜尋原文／譯文／講者、編輯後更新、空／大量資料、分頁；前 40 筆以外可由全部紀錄找到。TXT／VTT／JSON／CSV／複製的選項與範圍一致；播放器 VTT、Numbers／Excel CSV 特殊字元、中文 BOM、gap 與剪貼簿失敗。 |
| V05 | 接續、重講與版本 | O06；兩平台保存→重開→選版→接續／重講→播放／匯出；長短片段、ASR 失敗、保存失敗、取消與回復舊版均不破壞其他音訊／文字。 |
| V06 | 摘要、模板與術語 | O08；歷史 … 進獨立摘要頁，模板／語言／附加翻譯生成、Markdown、複製／匯出／重生與長內容；自訂模板立即保存並跨重開，空模板／至少留一個／刪除；術語 JSON 匯入／搜尋／編輯／刪除／返回來源頁與真實 prompt 套用。 |
| V07 | Electron 安裝、身分與權限 | O04、F04；Web、Electron 開發版、打包版分開記錄；缺 gateway、逾期登入、登出、A/B 換帳號、safeStorage、舊 session 開啟與復原檔隔離；乾淨 macOS／Windows 裝置的麥克風、系統分享、浮動字幕與保存。 |
| V08 | Storage、Docker 與部署 | O03；先 fallback，再本機 MinIO／PostgreSQL／Milvus 真實 adapter，最後外部 HTTPS；CRUD、初始化／索引／schema 維度、重啟後未先搜尋就刪向量、並行 CAS／跨程序、離線恢復、配額／磁碟／權限錯誤、部分成功、遷移及備份還原。Milvus 業務欄位限制與帳號隔離成立。 |
| V09 | 長時間與故障 | O02、O09；10 分鐘慢磁碟／fixture、60 分鐘真人、2 小時 Web／Electron、4 小時／10,000 段字幕、2 GB WAV；量測 heap／RSS／queues／CPU／延遲／gap；睡眠喚醒、斷網、5xx／429、裝置拔除、背景分頁、低磁碟、強制關閉；已落盤可恢復，無無界增長或假報成功。 |
| V10 | 模型／匯入／格式 | O05、F02、F03；有 key／免 key 新增修改重開，實際所選服務一致；48k→16k、44.1k→16k、原率、長時間 offset／尾端 flush；大 WAV overlap／取消／續跑、MP3／M4A／影片 MIME／上限；WebSocket 先取得 Q03 契約再驗 partial／ACK／重連。 |
| V11 | 音源、音量與降噪 | O09；內建／USB 麥克風、系統音訊、混音、A→B→A、拒絕／取消分享、無音軌與拔除；兩個獨立 RMS dBFS 表跟隨各自來源且 WAV／ASR 仍混音，音量檢查含振幅加倍約 6 dB、靜音／過載；noiseSuppression 實際支援與品質比較。 |
| V12 | 全頁 UI 與導航 | O07、Q06；登入、字幕、歷史、摘要、匯入、模型、聲紋、設定、浮動字幕及對話框，五語系×深／淺／系統×窄／低視窗，長內容／空／錯誤／載入；鍵盤／焦點／對比、路由刷新／前進／返回／直接連結；切頁不干擾收音。 |

需保留的細部 UI 驗收條件（來源：新版需求單，不自動恢復舊版布局）：

- 模板管理：左側清單固定高度可捲動、選項固定高度，下方刪除按鈕同寬；右側預覽上緣對齊清單、下緣對齊刪除按鈕，說明文字獨立；不重複顯示灰色「已保存模板」。
- 模型對話框：註冊按鈕置中，用途與其他欄位同寬；只有由既有模型卡進入編輯才顯示刪除，切用途不意外出現刪除；低視窗可捲動。
- 字幕／側欄：側欄只在 live 出現；收合增加字幕寬度，收起 icon 可直接開對應功能，展開頂部切換，內容隨高度捲動；搜尋在小 A 左側、小 A／大 A 並排、段數集中。最終位置依 Q06。
- 歷史 … 選單具 icon、可關閉、鍵盤與焦點管理，小視窗不裁切；匯出由歷史進入，即時頁不自行恢復匯出區。載入另一筆前保護現有未保存內容。

原始 27 項覆蓋索引（主要路徑，避免已做好的功能重複開發）：

| 原編號 | 對應項目 | 原編號 | 對應項目 | 原編號 | 對應項目 |
| --- | --- | --- | --- | --- | --- |
| 1 語者分離 | U01／V01 | 2 登入 | O04／V07 | 3 翻譯減載 | U03／V03 |
| 4 自動語言 | U03／Q02 | 5 整句翻譯 | U03／V03 | 6 摘要模板 | O08／V06 |
| 7 斷句滑桿 | U02／V02 | 8 排序 | V04 | 9 複製 | O08／V04 |
| 10 Storage | O03／V08 | 11 五語系 | O07／V12 | 12 主題 | O07／V12 |
| 13 術語 | O08／V06 | 14 搜尋 | V04 | 15 降噪 | O09／V11 |
| 16 VTT | V04 | 17 講者匯出 | V01／V04 | 18 取樣率 | O09／V10 |
| 19 ASR 語言 | O05／V10 | 20 接續 | O06／V05 | 21 編輯重講 | O06／Q04 |
| 22 左側紀錄 | O07／V04／V12 | 23 選單功能欄 | O07／Q06 | 24 即時設定 | U02／Q06 |
| 25 重構 | O01 | 26 模型列表 | O05／F01 | 27 聲紋註冊 | U01／V01 |

## 5. 不確定

以下保留未定規則與方案；不阻擋可獨立完成的部分，也不推定全部需要開發。

| ID | 問題 | 已知與待決定內容 |
| --- | --- | --- |
| Q01 | 公司身份規則 | **NT 公司唯一已確認，不再詢問是否唯一／是否為真名。** 仍需 NT 大小寫／格式正規化、帳號與 NT 的綁定／改號遷移；Department 自由輸入或公司清單、如何驗證部門及修改權限、是否允許代他人註冊聲紋。一般權限不改用 NT 或前端 Department 判斷。 |
| Q02 | 自動翻譯與整句語義 | 固定目標已有；待定具體 A↔B 配對、同目標語言輸入要跳過或反向、混說與無法辨識時的 fallback、是否要繁簡輸出區分。舊需求明定整句有最大等待；嚴格整句或超時允許片段需對齊，不能自行移除五秒保護。 |
| Q03 | 模型服務與真正串流 | 現有 HTTP 作為基線；需實際版本、成功 request、格式、payload、語言／prompt／timestamps 能力及認證。WebSocket adapter 已有暫定協定，不代表服務端已驗證；需 handshake、frame／sampleRate、VAD ownership、partial/final/revision、heartbeat、ACK、replay、重連／逾期契約。Chat Completions input_audio／stream:true 僅候選，不假設可當 ASR；若驗證有效才新增獨立 adapter。模型能力自動探測、熱切換與逐詞時間戳也依服務決定。 |
| Q04 | 重講長短與版本 | 保留舊版已定。待選擇「原時間槽裁切／補靜音並提示」或「依新長度平移後續音訊字幕」；兩種都必須保證保存音訊與 ASR／文字吻合。是否保存完整文字編輯歷史需跟音檔版本規則一致。 |
| Q05 | 歷史排序與同步衝突 | 名稱／建立時間／時長已有，是否新增最後更新時間；衝突目前保留副本，待定提供合併、選版本或保留兩份的 UI；刪除同步、舊副本復活與資料保留期限需一起定義。 |
| Q06 | 側欄最終位置 | 原 23／24 要右側功能欄與右側即時設定；新版需求單記錄左側 history/settings 切換且不再恢復右側拖曳浮層，現有程式也是左側。兩份指示來源衝突，保留待定；不能直接把左側判 bug 或自行移回右側。參考圖需可取得後才做視覺比對。 |
| Q07 | 發布與企業登入 | 舊文件提未來換 TSSO，尚無協定／時程；目前簡易登入保留。正式 OS 最低版本、macOS arm64／universal、Windows x64、打包工具（舊文 Forge／builder 不一致）、簽署、網域、TLS 與模型部署版本待提供。外部配置只影響正式整合驗收。 |
| Q08 | 研究性延伸 | 獨立降噪模型／更換 VAD、字幕同步回放／變速、MP3／M4A／Word／Excel 匯出、逐字稿優化／問答、視覺摘要、語音口譯、會後第二輪重轉錄僅早期研究／候選功能，不當成已承諾需求；需確認用途與模型能力後再排。 |
| Q09 | 品質與資源門檻 | 舊文 partial P95≤2 秒、譯文≤4 秒是初始工程目標，HTTP 無 partial 不套該指標；CER／WER、講者誤配／漏配、可接受斷句延遲、heap／RSS／queue 上限與 2 小時 soak 門檻需依指定硬體及模型基線定案。驗收需提供數據，不用空白 WAV 或單句成功代替。 |

技術參考保留：[文件索引](README.md)、[架構](reference/ARCHITECTURE.zh-TW.md)、[模型契約](reference/MODEL_ADAPTER.md)、[Gateway](reference/WEB_GATEWAY.zh-TW.md)、[分離 API](reference/DIARIZATION_API.zh-TW.md)、[音訊品質](reference/AUDIO_QUALITY.zh-TW.md)、[sherpa 操作](guide/SHERPA_ONNX.zh-TW.md)、[部署備份](guide/DEPLOYMENT.zh-TW.md)、[驗收手冊](guide/VALIDATION.zh-TW.md)。[早期研究](research/PLAN.zh-TW.md) 與 [後端方案研究](research/OPEN_SOURCE_BACKENDS.zh-TW.md) 的歷史假設不覆蓋本檔決策；[K8s 擴充計畫](research/K8S_SCALE_PLAN.zh-TW.md) 屬未來規劃，不代表已交付。
