# Nemotron 獨立 CPU Docker 映像

包含 Linux x64 / ARM64 native runtime v0.2.0、Q8_0 權重與授權。無 GPU 需求，沒有 npm/pip/apt 安裝、啟動下載或音訊連外。這是獨立 CLI，不是 HTTP ASR/diarization 端點，不會自動取代 gateway 的本機掛載。

## 建置

先依專案既有安裝方式備齊 models/nemotron-3-diarization 的權重與 對應 Linux runtime。

```sh
sh docker/nemotron/build.sh s2t-nemotron:0.2.0-q8-amd64 amd64
# ARM64: sh docker/nemotron/build.sh s2t-nemotron:0.2.0-q8-arm64 arm64
```

腳本建立僅含模型/runtime/封裝文件的暫存 context，兼容 classic builder。基底 官方平台專屬 node:22-bookworm-slim 首次使用仍需 registry pull；RUN 使用 network=none。權重建置時核對 SHA256。ARM64 真實離線推論已通過。amd64 映像建置與 --version 通過，但在 ARM64 Mac 相容層實際推論出現 Illegal instruction；尚待原生 Linux x64 主機驗證。

## 執行

```sh
docker run --rm --network none s2t-nemotron:0.2.0-q8-amd64
# 音訊資料夾須對容器 UID 1000 可寫，或用 --user 指定本機 UID/GID。
docker run --rm --network none -v /path/to/audio:/data \
  s2t-nemotron:0.2.0-q8-amd64 diarize /data/input.wav \
  --recording-id recording --output /data/turns.rttm
```

預設同專案 geometry：chunk264、right/left1、fifo0、cache528、update188。原生 CLI 處理 WAV；其他媒體請先轉 PCM WAV。可用 S2T_NEMOTRON_MODEL 指向另外掛載的本機權重。

## 發布

```sh
docker tag s2t-nemotron:0.2.0-q8-amd64 ACCOUNT/REPOSITORY:0.2.0-q8-arm64
docker push ACCOUNT/REPOSITORY:0.2.0-q8-arm64
```

需指定 Docker Hub 目的 repository 並已登入。映像不含 .env、金鑰、錄音、歷史資料或其他模型。模型與 runtime 的授權全文及來源通知隨映像保存。
