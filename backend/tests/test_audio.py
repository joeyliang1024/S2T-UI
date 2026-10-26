import wave
import os
import shutil
from pathlib import Path

import pytest

from app.audio_engine import intervals, run


def test_vad_interval_hysteresis():
    assert intervals([0.9, 0.9, 0.9, 0.9, *([0.1] * 10)], 14 * 512) == [
        {"startMs": 0, "endMs": 128}
    ]
    assert intervals([0.9, 0.1, 0.9, 0.1], 2048) == []


def silence_file(tmp_path, seconds=1):
    path = tmp_path / "silence.wav"
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(16000)
        output.writeframes(b"\0\0" * (16000 * seconds))
    return path


@pytest.mark.models
def test_real_silero_runtime(tmp_path):
    models = Path(__file__).resolve().parents[2] / "models"
    if not (models / "silero-vad/silero_vad.onnx").is_file():
        pytest.skip("Silero model not mounted")
    path = silence_file(tmp_path)
    result = run("vad", str(path), str(models), {"frames": True})
    assert result["speech"] == [] and result["durationMs"] == 1000
    assert len(result["probabilities"]) == 32


@pytest.mark.models
def test_real_sherpa_embedding_and_diarizer_health():
    models = Path(__file__).resolve().parents[2] / "models"
    if not (
        models / "sherpa-onnx/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx"
    ).is_file():
        pytest.skip("Sherpa model not mounted")
    assert run("health", None, str(models), {"model": "embedding", "purpose": "embedding"})[
        "available"
    ]
    assert run("health", None, str(models), {"model": "sherpa-onnx-speaker-diarization"})[
        "available"
    ]


@pytest.mark.models
def test_real_ffmpeg_conversion(tmp_path, monkeypatch):
    root = Path(__file__).resolve().parents[2]
    binary = Path(
        os.environ.get("S2T_FFMPEG_PATH") or shutil.which("ffmpeg") or "/nonexistent-ffmpeg"
    )
    if not binary.exists():
        pytest.skip("Set S2T_FFMPEG_PATH or install FFmpeg")
    monkeypatch.setenv("S2T_FFMPEG_PATH", str(binary))
    source = silence_file(tmp_path)
    result = run("import", str(source), str(root / "models"))
    with wave.open(result["path"]) as audio:
        assert audio.getframerate() == 16000 and audio.getnframes() == 16000
    Path(result["path"]).unlink()


@pytest.mark.models
def test_real_sherpa_and_nemotron_inference(monkeypatch):
    from app.audio_engine import paths

    root = Path(__file__).resolve().parents[2]
    models = root / "models"
    files = paths(models)
    if not all(files[key].is_file() for key in ("segmentation", "embedding", "nemo", "runtime")):
        pytest.skip("Full local inference artifacts not mounted")
    monkeypatch.setenv("S2T_INFERENCE_BACKEND", "cpu")
    source = root / "tests/fixtures/speech-sample.wav"
    embedding = run("embedding", str(source), str(models))
    assert embedding["embedding"] and embedding["durationMs"] > 9000
    for model in ("sherpa-onnx-speaker-diarization", "nemotron-3-diarization"):
        turns = run("diarize", str(source), str(models), {"model": model})
        assert turns
        assert all(
            turn["speaker"].startswith("SPEAKER_") and 0 <= turn["start"] < turn["end"] <= 10
            for turn in turns
        )
