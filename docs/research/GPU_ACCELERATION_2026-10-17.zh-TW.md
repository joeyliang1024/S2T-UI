# 現有模型 GPU 加速可行性（2026-10-17）

> 歷史／研究文件：以下數據、路徑與命令僅代表記錄版本，不是現行操作入口。最新操作與驗收請以 [文件入口](../README.md)、[目前結果](../reports/VALIDATION_2026-10-26.zh-TW.md) 及 [重現指南](../guide/REPRODUCE.zh-TW.md) 為準。


結論：本機模型有 GPU 路徑，但目前產品程式與隨附 runtime 都按 CPU 部署。這是初始研究快照。後續已加入環境變數控制與 H100／H200 build／部署配方，見 [GPU 部署指南](../guide/GPU.zh-TW.md)；未在本機安裝 GPU 套件、切換實際部署或完成 GPU 硬體驗收。

## 已核對的本機實作

| 工作 | 目前模型／實作 | 現況 | GPU 評估 |
| --- | --- | --- | --- |
| 語者分離 | Nemotron-3-Diarization Q8_0 GGUF、NeMo-Speech.cpp v0.2.0 | `server/nemotron-diarization.cjs` 明確傳入 `--backend cpu`；獨立 Docker entrypoint 也固定 CPU | 首要 PoC 候選；官方 v0.2.0 有 CUDA／Metal build 與 diarization component，須換相符 runtime 後實測。 |
| 語者分離 | sherpa-onnx pyannote segmentation + ERes2Net embedding | `server/sherpa-diarization.cjs` 兩者指定 `provider: cpu`；segmentation 預設為 `model.int8.onnx`（`sherpa-diarization.cjs` 的 modelPaths；可由環境變數覆寫） | CUDA 可行；Node addon 必須搭配相同版本的 GPU native libraries，不能只改一個字串。INT8／算子分派需實測，可能有 CPU fallback。 |
| 聲紋抽取 | 3D-Speaker ERes2Net ONNX | SpeakerEmbeddingExtractor 固定 CPU | 可評估 CUDA，尤其多音檔／多人並行；聲紋搜尋與 metadata 不因此自動變成 GPU。 |
| 語音活動偵測 | Silero VAD ONNX | `server/silero-vad.cjs` 固定 CPU，單執行緒 | 技術上可評估 CUDA／CoreML，但單路短 chunk 不列第一優先；傳輸、排程與初始化可能抵銷收益，需量測。 |
| ASR、翻譯、摘要與自訂遠端模型 | gateway 呼叫設定的 HTTP／WebSocket 上游 | 本 repo 未提供這些使用者模型的實際 serving runtime／權重清單 | 必須在上游模型服務啟用 GPU。只替 gateway 分配 GPU，不會加速遠端服務。 |

本機權重檔大小為 Nemotron 約 102.1 MiB、INT8 segmentation 約 1.5 MiB、ERes2Net 約 37.8 MiB、Silero 約 2.2 MiB；這些是磁碟大小，**不是 GPU 記憶體需求**。顯存還包含 activations、runtime workspace、並行及量化解碼開銷，未測量前不提供最低顯存或加速倍率。

## 實際環境讀取

目前開發機是 macOS arm64。隨附 darwin-arm64 `nemo-speech doctor --json` 回報 CPU 為 Apple M3 Pro，`accelerator_compiled=false`、`backend_cuda=false`、`backend_metal=false`、`backend_vulkan=false`，只有 CPU／Accelerate BLAS。現有二進位無法靠改成 `--backend metal` 就得到 GPU。

已安裝的 `onnxruntime-node` 執行 `listSupportedBackends()` 回報 bundled cpu／webgpu／coreml。這只證明套件包含 provider，不能證明特定 ONNX 圖已在 GPU 或 Neural Engine 執行；sherpa addon 也使用自己的 native runtime，不能由這份清單推論其能力。

`Dockerfile.web` 為 Node Debian 映像，沒有 GPU runtime 配置；目前 gateway Compose 與測試 K8s 工作負載也沒有 GPU 資源宣告。此處沒有查詢真實遠端 cluster、讀取實際 `.env`、帳號模型清單或憑證。

## Linux／NVIDIA 部署方向

1. 優先為 audio worker 建置獨立 GPU 映像；保留 Web UI／gateway 的對外 `8787`，GPU 服務在內網使用，不新增瀏覽器對外連接埠。
2. Nemotron 使用同一個已固定版本／模型，準備 CUDA diarization runtime；sherpa 使用匹配版本的 GPU native libraries 與對應 CUDA／cuDNN。各套件版本需求需分開驗證，不能直接套用歷史安裝範例的 CUDA 版本。
3. K8s GPU node 安裝 NVIDIA driver／device plugin，worker 宣告 `limits: nvidia.com/gpu: 1`，並以 node selector／affinity 排到相容節點。限制 worker 並行，避免每份 worker 重複載入模型耗盡顯存。
4. 對外只提供 CPU／CUDA 模式開關；各元件策略與 runtime 路徑由映像處理，GPU 裝置由 Docker／K8s 分配。要求 GPU 的元件若無法使用，需明確失敗，不能把 CPU 結果標成 GPU。
5. 健康資訊分開回報「模型可用」與「實際 backend／device」。現有綠燈不能當作 GPU 使用證據。

## Apple Silicon 方向

Nemotron 可準備 Metal diarization runtime，在 macOS host 原生執行，再由 Web gateway／audio service 串接；這不需要恢復 Electron 開發。CoreML 可作為 ONNX PoC，但算子支援、分區與量化相容性必須逐模型驗證；CoreML 也不等同保證全部在 GPU 執行。

一般 macOS Docker／Colima Linux 容器不能直接把 Apple Metal 當作 NVIDIA CUDA GPU 使用；Docker Desktop 的標準 `--gpus` passthrough 文件針對 Windows WSL2。若使用其他主機推論機制，需獨立整合，不能視為現有容器自然支援。

## 建議驗證順序

這是工程判斷，不是已測得的加速結果：先做 Nemotron CPU 對 CUDA／Metal 的同版本比較，再做聲紋抽取／sherpa，Silero 最後。Nemotron 現在每次透過 CLI 子程序載入，PoC 應分開記錄冷啟動、模型載入及暖推論，評估持續載入模型的 worker，而非把載入時間誤算成 GPU 推論速度。

使用相同音檔、模型 SHA256、量化、chunk geometry 與後處理，比較 30 秒／5 分鐘／60 分鐘、1／4／8 路（並行數依設備承載逐級增加）：p50／p95、RTF、排隊、冷啟動、CPU／RAM／GPU 記憶體、DER／講者數／聲紋匹配一致性。需記錄實際 backend／算子分派，不能僅以 GPU 被看見或顯存被占用判定成功。

## 官方來源

- [NeMo-Speech.cpp v0.2.0 build：CUDA／Metal 與 diar component](https://github.com/NVIDIA/NeMo-Speech.cpp/blob/v0.2.0/docs/build.md)
- [NeMo-Speech.cpp v0.2.0 CLI：backend 選擇、doctor、diarization benchmark](https://github.com/NVIDIA/NeMo-Speech.cpp/blob/v0.2.0/docs/cli.md)
- [sherpa-onnx v1.13.8 發布與 GPU artifacts](https://github.com/k2-fsa/sherpa-onnx/releases/tag/v1.13.8)
- [sherpa 維護者說明 Node addon GPU native libraries 的組合方式（歷史版本，不能直接照搬版本）](https://github.com/k2-fsa/sherpa-onnx/issues/1146)
- [ONNX Runtime Node v1.30.0 支援表](https://github.com/microsoft/onnxruntime/blob/v1.30.0/js/node/README.md)
- [ONNX Runtime CoreML provider](https://onnxruntime.ai/docs/execution-providers/CoreML-ExecutionProvider.html)
- [Silero 官方 CPU／batch／GPU 說明](https://github.com/snakers4/silero-vad)
- [Kubernetes GPU 排程與 device plugins](https://kubernetes.io/docs/tasks/manage-gpus/scheduling-gpus/)
- [Docker Desktop GPU passthrough 的平台限制](https://docs.docker.com/desktop/features/gpu/)
