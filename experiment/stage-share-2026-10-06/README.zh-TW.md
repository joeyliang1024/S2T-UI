# 首字延遲時間占比

同一張 Grafana 總覽新增一張甜甜圈圖：上方時間選擇器範圍內，各階段累計耗時／所有六階段累計耗時。這是耗時占比，並非當下有幾個使用者／請求卡在哪裡。

六個階段為 VAD 語音確認、音訊累積／切段、瀏覽器排隊、音訊前處理、ASR 往返（含 server 容量等待／模型／重試）、字幕畫面呈現。所有分片來自同一批成功呈現首字且時間線有效的樣本；六個區間無重疊，總和等於該筆首字延遲。後續字幕及翻譯不放進分母，也不把 server 內部指標再疊到 ASR 往返；更不把不同步驟的 p95 加總。

原本所有字幕段的各階段計數不同，直接作餅圖會偏差，因此補獨立 `s2t_first_word_stage_duration_seconds` family，固定六個 stage，啟動零基線。沒有語音起點、時間線倒序或超過 300 秒的樣本不進入占比。telemetry 上限仍為 128 個測量，但丟棄完整樣本批次，避免只留下部分步驟。服務端驗證和原有 metric allowlist 保留。

PromQL 使用同一族 _sum 的 increase[$__range]（跟隨時間選擇器），分母是全部步驟之和；query 為 instant，沒有樣本時 No data，不回填虛構比例。圖例使用中文名稱與百分比，5 秒刷新。沿用 VAD／雙 RAF 的語音起點和呈現估計限制。

驗證：純函式測試時間守恆、拒絕無起點／倒序／過期、server family 與未知 stage；TypeScript；八個 Chrome 假麥克風實際收音，每個首字六個區間與端到端值一致。結果及截圖保存在 results/。圖表採 [Grafana Pie chart](https://grafana.com/docs/grafana/latest/visualizations/panels-visualizations/visualizations/pie-chart/) 原生 donut。

修復 No data：分子按 stage 分組，分母為不帶 stage 的單一向量，PromQL 預設 label matching 得到空結果。分母已改 scalar(sum(...))，六個步驟比值才會返回。圖表改跟隨上方時間選擇器，方便無新收音時仍查看剛才的實驗結果；空的選擇區間仍維持 No data。首次瀏覽器測試期間 UI port-forward 的 SPDY 連線中斷，已恢復 forward 並延長假麥克風 WAV，重跑 8 個 Chrome 成功取得 24 筆完整樣本，逐筆六段之和與首字時間相等。Prometheus 包含首次測試的 8 筆，共 32 筆／每 stage，同族百分比精確加總 100%；targets 全數正常。

最終 Chrome 檢查已顯示中文圖例與百分比、沒有頁面錯誤。30 分鐘所選視窗的測量占比約：累積／切段 61.008%、ASR 往返 30.499%、VAD 確認 6.621%、畫面呈現 1.777%、前處理 0.092%、瀏覽器排隊 0.003%。小數四捨五入後可能有微小差異；原始比值總和為 100%。這是本次 mock API／假麥克風樣本，並非真實模型能力。
