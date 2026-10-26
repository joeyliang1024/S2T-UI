"""CPU/native operations run only in persistent, spawned worker processes."""

import hashlib
import math
import os
import platform
import json
import re
import shutil
import subprocess
import tempfile
import time
from functools import lru_cache
from pathlib import Path


def paths(root):
    root = Path(root)
    sherpa = root / "sherpa-onnx"
    nemo = root / "nemotron-3-diarization"
    system = {"Darwin": "darwin", "Linux": "linux", "Windows": "win32"}[platform.system()]
    architecture = {"aarch64": "arm64", "arm64": "arm64", "x86_64": "x64", "AMD64": "x64"}[
        platform.machine()
    ]
    runtime = Path("/opt/nemo-speech/bin/nemo-speech")
    if not runtime.exists():
        runtime = nemo / "runtime" / f"{system}-{architecture}" / "bin" / "nemo-speech"
    return dict(
        segmentation=sherpa / "sherpa-onnx-pyannote-segmentation-3-0/model.int8.onnx",
        embedding=sherpa / "3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx",
        silero=root / "silero-vad/silero_vad.onnx",
        nemo=nemo / "Nemotron-3-Diarization.q8_0.gguf",
        runtime=runtime,
    )


@lru_cache(maxsize=4)
def verified_nemotron(model, runtime, model_version, runtime_version, backend):
    state = hashlib.sha256()
    with open(model, "rb") as source:
        while chunk := source.read(8 * 1024**2):
            state.update(chunk)
    if state.hexdigest() != "08456d9e22cd9a323c0364d98375f3746d6e68507ebb705cd46438c534c7a3a1":
        raise ValueError("Nemotron 模型 SHA256 不符")
    subprocess.run([runtime, "--version"], check=True, timeout=5, capture_output=True)
    if backend not in {"cpu", "cuda"}:
        raise ValueError("Invalid inference backend")
    if backend == "cuda":
        doctor = json.loads(subprocess.check_output([runtime, "doctor", "--json"], timeout=10))
        if (
            not doctor.get("features", {}).get("backend_cuda")
            or not doctor.get("accelerator_available")
            or not doctor.get("driver_runtime_compatible")
            or not any(item.get("type") == "gpu" for item in doctor.get("devices", []))
        ):
            raise RuntimeError("Nemotron CUDA runtime／裝置不可用")
    return backend


def nemo_backend(files):
    return verified_nemotron(
        str(files["nemo"]),
        str(files["runtime"]),
        files["nemo"].stat().st_mtime_ns,
        files["runtime"].stat().st_mtime_ns,
        os.environ.get("S2T_INFERENCE_BACKEND", "cpu"),
    )


def load_wave(filename):
    import numpy as np
    import soundfile as sf
    from scipy.signal import resample_poly

    samples, rate = sf.read(filename, dtype="float32", always_2d=True)
    samples = samples.mean(axis=1)
    if not len(samples) or not np.isfinite(samples).all():
        raise ValueError("音訊不可為空或包含無效數值")
    if rate != 16000:
        factor = math.gcd(rate, 16000)
        samples = resample_poly(samples, 16000 // factor, rate // factor)
    return np.ascontiguousarray(samples, dtype="float32")


@lru_cache(maxsize=4)
def silero_session(filename, checksum):
    import onnxruntime as ort

    if hashlib.sha256(Path(filename).read_bytes()).hexdigest() != checksum:
        raise ValueError("Silero VAD 模型 checksum 不符")
    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    options.inter_op_num_threads = 1
    return ort.InferenceSession(filename, sess_options=options, providers=["CPUExecutionProvider"])


def intervals(probabilities, count, threshold=0.5, min_speech=120, min_silence=300):
    result = []
    candidate = start = silence = None
    end_threshold = threshold - 0.15
    for index, probability in enumerate(probabilities):
        begin, end = index * 32, min((index + 1) * 512, count) / 16
        if start is None:
            if probability >= (threshold if candidate is None else end_threshold):
                candidate = begin if candidate is None else candidate
                if end - candidate >= min_speech:
                    start = candidate
            else:
                candidate = None
        elif probability >= end_threshold:
            silence = None
        else:
            silence = begin if silence is None else silence
            if end - silence >= min_silence:
                result.append({"startMs": round(start), "endMs": round(silence)})
                candidate = start = silence = None
    if start is not None:
        result.append(
            {"startMs": round(start), "endMs": round(count / 16 if silence is None else silence)}
        )
    return result


@lru_cache(maxsize=4)
def extractor(filename, threads):
    import sherpa_onnx as sherpa

    config = sherpa.SpeakerEmbeddingExtractorConfig(
        model=filename, num_threads=threads, provider="cpu"
    )
    if not config.validate():
        raise ValueError("聲紋模型設定無效")
    return sherpa.SpeakerEmbeddingExtractor(config)


def embedding(samples, filename, threads):
    if len(samples) < 16000:
        raise ValueError("聲紋錄音至少需要 1 秒")
    model = extractor(filename, threads)
    stream = model.create_stream()
    stream.accept_waveform(sample_rate=16000, waveform=samples)
    stream.input_finished()
    if not model.is_ready(stream):
        raise ValueError("有效人聲不足")
    return [float(value) for value in model.compute(stream)]


@lru_cache(maxsize=2)
def diarization_runtime(segmentation, voice_model, threads):
    import sherpa_onnx as sherpa

    config = sherpa.OfflineSpeakerDiarizationConfig(
        segmentation=sherpa.OfflineSpeakerSegmentationModelConfig(
            pyannote=sherpa.OfflineSpeakerSegmentationPyannoteModelConfig(model=segmentation),
            num_threads=threads,
            provider="cpu",
        ),
        embedding=sherpa.SpeakerEmbeddingExtractorConfig(
            model=voice_model, num_threads=threads, provider="cpu"
        ),
        clustering=sherpa.FastClusteringConfig(num_clusters=-1, threshold=0.7),
        min_duration_on=float(os.environ.get("S2T_SHERPA_MIN_DURATION_ON", 0.25)),
        min_duration_off=float(os.environ.get("S2T_SHERPA_MIN_DURATION_OFF", 0.35)),
    )
    if not config.validate():
        raise ValueError("講者分離模型設定無效")
    return sherpa.OfflineSpeakerDiarization(config), config


def diarizer(segmentation, voice_model, threshold, threads):
    model, config = diarization_runtime(segmentation, voice_model, threads)
    config.clustering.threshold = threshold
    model.set_config(config)
    return model


def vad_probabilities(samples, model_paths):
    import numpy as np

    checksum = os.environ.get(
        "S2T_SILERO_VAD_SHA256", "1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3"
    )
    session = silero_session(str(model_paths["silero"]), checksum)
    state, context = np.zeros((2, 1, 128), dtype="float32"), np.zeros(64, dtype="float32")
    probabilities, frame, sr = (
        [],
        np.zeros((1, 576), dtype="float32"),
        np.array(16000, dtype="int64"),
    )
    for offset in range(0, len(samples), 512):
        frame.fill(0)
        frame[0, :64] = context
        chunk = samples[offset : offset + 512]
        frame[0, 64 : 64 + len(chunk)] = chunk
        probability, state = session.run(None, {"input": frame, "state": state, "sr": sr})
        probabilities.append(float(probability.flatten()[0]))
        context = frame[0, -64:].copy()
    return probabilities


def ffmpeg():
    path = os.environ.get("S2T_FFMPEG_PATH") or shutil.which("ffmpeg")
    if not path:
        raise RuntimeError("FFmpeg 未安裝，請設定 S2T_FFMPEG_PATH")
    return path


def convert(filename, operation):
    import resource

    extension = ".m4a" if operation == "transcode" else ".wav"
    output = str(Path(filename).with_suffix(extension + ".converted"))
    args = [
        ffmpeg(),
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-y",
        "-i",
        filename,
        "-map",
        "0:a:0",
        "-vn",
    ]
    if operation == "transcode":
        args += ["-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", "-f", "mp4"]
    else:
        if operation == "normalize":
            args += ["-af", "dynaudnorm=f=150:g=15:p=0.9:m=10"]
        args += ["-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "wav"]

    def constrain():
        resource.setrlimit(resource.RLIMIT_FSIZE, (2 * 1024**3, 2 * 1024**3))

    try:
        subprocess.run(
            args + [output],
            check=True,
            timeout=600,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            preexec_fn=constrain,
        )
        return {"path": output, "size": Path(output).stat().st_size}
    except BaseException:
        Path(output).unlink(missing_ok=True)
        raise RuntimeError("音訊轉換失敗或超過容量／時間上限") from None


def run(operation, filename, root, options=None):
    import numpy as np

    options = options or {}
    model_paths = paths(root)
    started = time.monotonic()
    threads = int(os.environ.get("S2T_SHERPA_INFER_THREADS", 2))
    if operation in {"import", "transcode", "normalize"}:
        return convert(filename, operation)
    if operation == "health":
        model = options.get("model", "silero-vad")
        if model == "silero-vad":
            checksum = os.environ.get(
                "S2T_SILERO_VAD_SHA256",
                "1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3",
            )
            silero_session(str(model_paths["silero"]), checksum)
        elif "nemotron" in model.lower():
            return {"available": True, "backend": nemo_backend(model_paths)}
        elif options.get("purpose") == "embedding":
            extractor(str(model_paths["embedding"]), threads)
        else:
            diarizer(str(model_paths["segmentation"]), str(model_paths["embedding"]), 0.7, threads)
        return {"available": True, "backend": "cpu"}
    samples = load_wave(filename)
    duration = len(samples) / 16000
    if operation == "vad":
        probabilities = vad_probabilities(samples, model_paths)
        result = {
            "sampleRate": 16000,
            "durationMs": round(duration * 1000),
            "speech": intervals(probabilities, len(samples)),
            "processingMs": (time.monotonic() - started) * 1000,
        }
        if options.get("frames"):
            result["probabilities"] = [
                {
                    "startMs": index * 32,
                    "endMs": min((index + 1) * 32, result["durationMs"]),
                    "probability": probability,
                }
                for index, probability in enumerate(probabilities)
            ]
        return result
    if operation == "embedding":
        rms = float(20 * np.log10(max(float(np.sqrt(np.mean(samples**2))), 1e-8)))
        if options.get("enroll") and (
            duration < 3 or rms < -45 or float(np.mean(np.abs(samples) >= 0.995)) > 0.02
        ):
            raise ValueError("聲紋需至少 3 秒清楚人聲，音量不可過低或削波")
        return {
            "embedding": embedding(samples, str(model_paths["embedding"]), threads),
            "durationMs": round(duration * 1000),
            "rmsDbfs": round(rms, 1),
        }
    if operation == "speaker-embeddings":
        matching = options.get("matching")
        if matching and os.environ.get("S2T_VOICEPRINT_AUDIO_VAD") != "0":
            voiced = (
                sum(
                    item["endMs"] - item["startMs"]
                    for item in intervals(vad_probabilities(samples, model_paths), len(samples))
                )
                / 1000
            )
            if voiced < float(
                os.environ.get("S2T_VOICEPRINT_AUDIO_VAD_MIN_SEC", 10)
            ) and voiced / duration < float(
                os.environ.get("S2T_VOICEPRINT_AUDIO_VAD_MIN_RATIO", 0.05)
            ):
                return {}
        groups, accepted_samples = {}, {}
        maximum_samples = int(float(os.environ.get("S2T_VOICEPRINT_MAX_SPEECH_SEC", 45)) * 16000)
        for turn in options.get("turns", []):
            begin, end = (
                max(0, int(turn["start"] * 16000)),
                min(len(samples), int(turn["end"] * 16000)),
            )
            if end > begin:
                piece = samples[begin:end]
                if matching:
                    if len(piece) / 16000 < float(
                        os.environ.get("S2T_VOICEPRINT_MIN_SEGMENT_SEC", 1.5)
                    ):
                        continue
                    rms = 20 * np.log10(max(float(np.sqrt(np.mean(piece**2))), 1e-8))
                    if rms < float(os.environ.get("S2T_VOICEPRINT_MIN_BLOCK_DBFS", -45)):
                        continue
                remaining = maximum_samples - accepted_samples.get(turn["speaker"], 0)
                if remaining <= 0:
                    continue
                piece = piece[:remaining]
                groups.setdefault(turn["speaker"], []).append(piece)
                accepted_samples[turn["speaker"]] = accepted_samples.get(turn["speaker"], 0) + len(
                    piece
                )
        result = {}
        for speaker, pieces in groups.items():
            joined = np.concatenate(pieces)
            if matching and len(joined) / 16000 < float(
                os.environ.get("S2T_VOICEPRINT_MIN_SPEECH_SEC", 8)
            ):
                continue
            block_samples = max(
                16000, int(float(os.environ.get("S2T_VOICEPRINT_MAX_BLOCK_SEC", 15)) * 16000)
            )
            maximum_samples = int(
                float(os.environ.get("S2T_VOICEPRINT_MAX_SPEECH_SEC", 45)) * 16000
            )
            minimum_samples = (
                int(float(os.environ.get("S2T_VOICEPRINT_MIN_BLOCK_SEC", 5)) * 16000)
                if matching
                else 16000
            )
            maximum_blocks = int(os.environ.get("S2T_VOICEPRINT_MAX_BLOCKS", 3))
            blocks = [
                joined[index : min(index + block_samples, maximum_samples)]
                for index in range(0, min(len(joined), maximum_samples), block_samples)
            ][:maximum_blocks]
            vectors = []
            for block in blocks:
                if len(block) < minimum_samples:
                    continue
                if matching and os.environ.get("S2T_VOICEPRINT_VAD") == "1":
                    voiced = (
                        sum(
                            item["endMs"] - item["startMs"]
                            for item in intervals(vad_probabilities(block, model_paths), len(block))
                        )
                        * 16
                    )
                    if voiced / len(block) < float(
                        os.environ.get("S2T_VOICEPRINT_VAD_MIN_RATIO", 0.6)
                    ):
                        continue
                vectors.append(embedding(block, str(model_paths["embedding"]), threads))
            if vectors:
                result[speaker] = vectors
        return result
    if operation != "diarize":
        raise ValueError("Unknown audio operation")
    model = (
        options.get("model")
        or os.environ.get("S2T_DIARIZATION_MODEL")
        or "sherpa-onnx-speaker-diarization"
    )
    if model in {"nemotron-3-diarization", "nvidia/Nemotron-3-Diarization"}:
        import soundfile as sf

        with tempfile.TemporaryDirectory(prefix="s2t-nemo-") as directory:
            source, output = Path(directory) / "input.wav", Path(directory) / "turns.rttm"
            sf.write(source, samples, 16000, subtype="PCM_16")
            backend = nemo_backend(model_paths)
            args = [
                str(model_paths["runtime"]),
                "diarize",
                str(source),
                "--model",
                str(model_paths["nemo"]),
                "--backend",
                "cuda:0" if backend == "cuda" else "cpu",
                "--diar.chunk",
                "264",
                "--diar.right_context",
                "1",
                "--diar.left_context",
                "1",
                "--diar.fifo",
                "0",
                "--diar.spkcache",
                "528",
                "--diar.update_period",
                "188",
                "--format",
                "rttm",
                "--recording-id",
                "recording",
                "--output",
                str(output),
            ]
            subprocess.run(
                args,
                check=True,
                timeout=min(1800, 60 + 0.4 * duration),
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                env={
                    key: value
                    for key, value in os.environ.items()
                    if not key.startswith("NEMO_SPEECH_")
                },
            )
            turns = []
            for line in output.read_text().splitlines():
                fields = line.split()
                if not fields:
                    continue
                if (
                    len(fields) < 8
                    or fields[0] != "SPEAKER"
                    or not re.fullmatch(r"speaker_[1-8]", fields[7])
                ):
                    raise ValueError("Nemotron RTTM 格式無效")
                start, length = float(fields[3]), float(fields[4])
                if not (
                    math.isfinite(start)
                    and math.isfinite(length)
                    and 0 <= start < duration + 0.001
                    and length > 0
                ):
                    raise ValueError("Nemotron RTTM 格式無效")
                turns.append(
                    {
                        "start": start,
                        "end": min(duration, start + length),
                        "speaker": f"SPEAKER_{int(fields[7][8:]):02}",
                    }
                )
            return sorted(turns, key=lambda turn: (turn["start"], turn["end"]))
    if model != "sherpa-onnx-speaker-diarization":
        raise ValueError("本機講者分離模型無效")
    threshold = float(
        os.environ.get("S2T_SHERPA_CLUSTERING_THRESHOLD")
        or (0.7 if duration <= float(os.environ.get("S2T_SHERPA_SHORT_AUDIO_SEC", 60)) else 0.8)
    )
    model = diarizer(
        str(model_paths["segmentation"]), str(model_paths["embedding"]), threshold, threads
    )
    return [
        {
            "start": float(item.start),
            "end": float(item.end),
            "speaker": f"SPEAKER_{item.speaker:02}",
        }
        for item in model.process(samples).sort_by_start_time()
    ]
