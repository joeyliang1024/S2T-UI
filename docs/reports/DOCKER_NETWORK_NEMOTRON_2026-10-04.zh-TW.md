# Docker 連外盤點與 Nemotron 映像

2026-10-04，依 Dockerfile、compose、server 與目前 .env 檢查。這是程式與設定盤點，未對完整 gateway 工作階段抓封包。

| 階段/功能 | 連線來源 | 現況 |
|---|---|---|
| 基底映像 | Docker registry | node:22-bookworm-slim，首次拉取或更新時需要 |
| 套件 | NPM_REGISTRY | npm ci --ignore-scripts；xlsx 與 Linux FFmpeg 已隨專案提供 |
| ASR | submissions-enter-audit-workstation.trycloudflare.com | 真實辨識與 /models 健康探測會連外 |
| 翻譯 | penetration-garcia-wise-usual.trycloudflare.com | 翻譯與 /models 健康探測會連外 |
| 摘要/遠端講者 | 設定的服務端點 | 目前環境端點為空；模型管理自訂端點可新增連線 |
| WebSocket 模型 | 使用者設定端點 | 選用該 adapter 時會連線 |
| 儲存 | Postgres/MinIO/Milvus 設定位置 | 目前主 gateway 使用 local；若切換 remote，會連指定主機，是否外網視目的地而定 |
| 登入 | 本機儲存、bcrypt/JWT | 目前沒有外部登入請求 |
| Nemotron/Silero/FFmpeg | 本機 runtime、權重及執行檔 | 目前程式沒有啟動下載流程 |
| Docker Hub 發布 | registry 認證與 layer upload | push 本身需網路 |

Docker 套件 hooks 已停用，因此 Electron、onnxruntime-node、ffmpeg-static 不會在 npm install 階段自行從外站抓二進位檔。Nemotron 原生工具可能有其他可下載模型的指令；本次 entrypoint 明確指定已內建的本機模型，diarize 路徑已用禁止網路方式驗證。容器 runtime 仍不能只靠程式盤點宣稱任何任意指令都不會連外。

## Nemotron 成果

新增 Dockerfile.nemotron、Dockerfile.nemotron.dockerignore、docker/nemotron/build.sh、entrypoint.sh、使用說明與授權/來源通知。

- Linux ARM64 CPU，native runtime 0.2.0，Q8_0 權重約102 MiB。
- 獨立 CLI 映像約188 MB，不需要 GPU；尚未提供 HTTP 服務，也未改現有 gateway 掛載設定。
- build script 隔離 context，僅包含模型、該平台 runtime 與封裝文件；不包含專案 .env、錄音、資料庫。
- 建置 RUN 使用 network=none，核對權重 SHA256 與 runtime --version。
- docker run --network none，使用 tests/fixtures/speech-sample.wav 實測，成功輸出非空 RTTM（1列）。不代表已驗證長時間、多講者準確度。
- 僅 ARM64 實測，amd64 runtime 尚未取得與驗證。
- 已沿用 Docker 登入帳號發布 joeyliang1024/s2t-nemotron:0.2.0-q8-amd64。

模型授權： https://openmdw.ai/license/1-1/ 。runtime 的 Apache-2.0 與第三方 notices 隨原 runtime 保留。

## Linux x64 補充

官方 v0.2.0 linux-x86_64-cpu 發布包已下載、SHA256 核對通過：f396057150f1b774935c7414fd32ebc04195a795a34120d78d8c9ecefa1b7507。

runtime 已放入 models/nemotron-3-diarization/runtime/linux-x64，符合 Node process.arch=x64 的現有路徑規則。build.sh 預設改為 amd64，可用第二參數 arm64 建立原 ARM64 映像。

映像 s2t-nemotron:0.2.0-q8-amd64：架構 amd64，188633551 bytes；建置權重 SHA256 與 runtime --version 通過。ARM64 Mac/Colima 的 amd64 相容層執行实际 WAV 推論報 Illegal instruction，因此本次 x64 推論未通過；無 RTTM 驗證成果，尚需原生 Linux x64 主機確認。不能將此測試當成原生 x64 效能或正確性證據。

Docker Hub push 成功，digest：sha256:3a9f7ab45fc4a9325ed21bae90dfb50a946125e81a0c3739fad0304fa270e78e。原生 Linux x64 推論仍待驗證。
