# H100／H200 執行模式

只需一個應用程式環境變數：

```dotenv
S2T_INFERENCE_BACKEND=cuda
```

`cpu`（預設）使用既有 CPU 路徑；`cuda` 使用 H100／H200 配置：Nemotron 走 CUDA，sherpa 分離／聲紋與 Silero 依內建策略保留 CPU。這是固定配置，不會假裝所有模型都在 GPU 執行。修改後重新啟動 worker。

GPU 由 Docker／K8s 分配，應用程式使用第一個可見裝置；不需要設定 GPU index。CUDA image 內的 native runtime 自動從 `/opt/nemo-speech/bin/nemo-speech` 載入，CPU image 仍用 models 目錄內的既有 runtime，不需要設定路徑。要求 CUDA 卻沒有相符 runtime、裝置或 driver 時會報錯，不會退回 CPU。

本設定只控制 repo 內的本機音訊推論；遠端 ASR／翻譯／摘要由上游服務控制。Electron 專屬開發仍暫停。

## Docker

先在 Linux NVIDIA 環境建置 CUDA image。`Dockerfile.web.cuda` 使用 CUDA 12.8.1、NeMo-Speech.cpp v0.2.0 與 `cuda-diar`，目標架構為 H100／H200 的 compute capability 9.0；保留現有 Q8_0 權重。[NVIDIA 硬體表](https://github.com/NVIDIA/cutlass)。

```bash
docker build --platform linux/amd64 -f Dockerfile.web.cuda \
  --build-arg NPM_REGISTRY="$NPM_REGISTRY" \
  -t s2t-ui:h100-h200-cuda .

# .env 只增加／修改 S2T_INFERENCE_BACKEND=cuda。
docker compose -f docker-compose.gateway.yml -f docker-compose.gpu.yml up -d --no-build
```

主機需有相容的 NVIDIA driver 與 NVIDIA Container Toolkit。GPU overlay 配給一張 GPU，沿用既有資料 volume、模型掛載與 `S2T_AUTH_SECRET`，對外仍只有 `8787`；`--no-build` 避免基底 Compose 把 GPU image 重建成 CPU image。

建置會下載 CUDA／Node 基底、APT 套件及固定 tag 的官方 source/submodule，需使用核准的 registry／網路。模型權重仍從 `models` 掛載，不包進 image。原本獨立 CPU CLI 的 `Dockerfile.nemotron` 不受影響。

## Kubernetes

只把 GPU image 配給真正執行推論的 audio-service／audio-worker，沿用原有內部服務與 token：

```yaml
resources:
  limits:
    nvidia.com/gpu: 1
env:
  - name: S2T_INFERENCE_BACKEND
    value: cuda
```

由 NVIDIA device plugin 與 node affinity 排到 H100／H200，保留模型 volume；不要覆寫 device plugin 的裝置映射。每張 GPU 先用 1 個 heavy worker，再依量測調整並行。API gateway 不需 GPU，也不增加對外 port。[Kubernetes GPU 排程](https://kubernetes.io/docs/tasks/manage-gpus/scheduling-gpus/)。

## 驗證

在目標容器／Pod 執行：

```bash
nvidia-smi
/opt/nemo-speech/bin/nemo-speech doctor --json
node scripts/benchmarks/gpu-diarization.cjs --audio /path/to/fixture.wav
```

`doctor` 需確認 CUDA 已編入、GPU 可見且 driver 相容。驗收腳本使用明確的 `cuda:0`，包含 CLI 模型載入成本；需另以 GPU profiling 與同音檔 CPU 結果比較效能和講者品質。

開發機沒有 H100／H200。CPU／mock、CPU-only runtime 拒絕路徑已驗證；GPU image 建置、完整 Compose 執行與實際 GPU 推論尚未驗證。目前只完成 overlay YAML 語法解析，本機沒有 Compose plugin。
