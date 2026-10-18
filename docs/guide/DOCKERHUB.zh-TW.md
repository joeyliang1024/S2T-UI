# Docker Hub Linux x64 發布

`Dockerfile.web.hardened` 用於 Linux `amd64` 發布，基底為固定 digest 的 Wolfi，
安裝時更新 OS 套件；包含 Node 26、curl、wget、jq、bash 與系統 ffmpeg。
以非 root 執行，正式相依不包含 npm 安裝器、Electron 或其他開發工具。

## 建置

先產生與 lockfile 一致的 Web bundle，再建置 x64 runtime：

```bash
npm ci --ignore-scripts
npm run build:web
docker build --platform linux/amd64 -f Dockerfile.web.hardened -t s2t-ui:release .
```

前端輸出不包含處理器架構相關程式；可在原生建置主機產生，避免以 QEMU 執行
前端 bundler。最終映像的 OS、Node、正式套件與 native runtime 必須全部驗證為 x64。

映像只啟動此 repo 的 gateway，包含前端與必要執行相依，不封裝其他服務或額外原始碼壓縮檔。
完整映像（包含模型）的未壓縮大小不超過 2,000,000,000 bytes 時一併放入模型；
超過上限則不包含模型，改由 `/models` 唯讀掛載。版本發布紀錄應註明是否含模型。

## 執行

先在部署環境設定有效的 ASR／翻譯／摘要服務與金鑰，並在 `.env` 設定：

- 固定且妥善保存的 `S2T_AUTH_SECRET`。
- 首次管理員的 `S2T_BOOTSTRAP_ADMIN_USERNAME` 與至少 12 字元的 `S2T_BOOTSTRAP_ADMIN_PASSWORD`。

```bash
docker run -d --name s2t-ui --platform linux/amd64 \
  -p 8787:8787 --env-file .env -e DATA_DIR=/data \
  -v s2t-data:/data joeyliang1024/s2t-ui:latest-amd64
```

新資料卷使用映像的非 root 身分。既有 root 所有的資料目錄需先完成備份及權限遷移，
不要重新產生認證金鑰或用空資料目錄取代既有目錄。

映像中的本機模型用於講者分離、聲紋與 VAD，不包含遠端 ASR／翻譯／摘要服務。
是否能產生真實字幕仍取決於部署環境的上游服務連線。

## 發布驗證

- npm audit：包含開發相依也必須沒有已知漏洞。
- 最終映像以 Trivy 同時掃描 OS 與應用套件的全部嚴重程度；不忽略未修補項目。
- 實際啟動 x64 映像，驗證 readiness、前端／prompt、curl、ffmpeg 與本機模型載入。
- 附上掃描器版本、資料庫時間、映像 digest 與大小。零已知 CVE 只代表當次掃描結果，
  不保證未來新漏洞或掃描器涵蓋範圍以外的程式碼不存在問題。
- S3 儲存使用 AWS SDK；新增契約測試涵蓋串流、分頁、權限失敗與帳號隔離。
