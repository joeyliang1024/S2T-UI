"""A small local bridge from S2T UI's WebSocket contract to Breeze-ASR-26.

The model is batch ASR, so this server finalizes fixed windows instead of
claiming token-level streaming. It is intentionally a starting point for a
production service with VAD, batching, authentication, and observability.
"""
import asyncio
import json
import os

import numpy as np
import torch
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from transformers import AutoModelForSpeechSeq2Seq, AutoProcessor, pipeline

MODEL_ID = os.getenv("BREEZE_ASR_MODEL", "MediaTek-Research/Breeze-ASR-26")
WINDOW_SECONDS = float(os.getenv("BREEZE_ASR_WINDOW_SECONDS", "8"))
TARGET_SAMPLE_RATE = 16_000

app = FastAPI(title="S2T UI Breeze ASR bridge")
_recognizer = None


def recognizer():
    global _recognizer
    if _recognizer is None:
        device = "cuda:0" if torch.cuda.is_available() else "cpu"
        dtype = torch.float16 if device.startswith("cuda") else torch.float32
        model = AutoModelForSpeechSeq2Seq.from_pretrained(
            MODEL_ID, torch_dtype=dtype, low_cpu_mem_usage=True
        ).to(device)
        processor = AutoProcessor.from_pretrained(MODEL_ID)
        _recognizer = pipeline(
            "automatic-speech-recognition", model=model,
            tokenizer=processor.tokenizer, feature_extractor=processor.feature_extractor,
            torch_dtype=dtype, device=0 if device.startswith("cuda") else -1,
        )
    return _recognizer


def resample(audio: np.ndarray, source_rate: int) -> np.ndarray:
    if source_rate == TARGET_SAMPLE_RATE:
        return audio
    target_length = round(len(audio) * TARGET_SAMPLE_RATE / source_rate)
    if len(audio) < 2 or target_length < 2:
        return audio
    return np.interp(
        np.linspace(0, len(audio) - 1, target_length),
        np.arange(len(audio)), audio,
    ).astype(np.float32)


def transcribe(audio: np.ndarray, sample_rate: int) -> str:
    if not len(audio):
        return ""
    output = recognizer()({"array": resample(audio, sample_rate), "sampling_rate": TARGET_SAMPLE_RATE})
    return str(output.get("text", "")).strip()


async def emit_segment(websocket: WebSocket, audio: np.ndarray, sample_rate: int, index: int, start_ms: int):
    text = await asyncio.to_thread(transcribe, audio, sample_rate)
    end_ms = start_ms + round(len(audio) * 1000 / sample_rate)
    await websocket.send_text(json.dumps({
        "type": "transcript", "id": f"segment-{index}", "revision": 1,
        "status": "final", "startMs": start_ms, "endMs": end_ms,
        "sourceText": text,
    }, ensure_ascii=False))
    return end_ms


@app.websocket("/stream")
async def stream(websocket: WebSocket):
    await websocket.accept()
    sample_rate = 48_000
    pending: list[np.ndarray] = []
    pending_samples = 0
    segment_index = 0
    offset_ms = 0
    try:
        while True:
            message = await websocket.receive()
            if "text" in message and message["text"] is not None:
                control = json.loads(message["text"])
                if control.get("type") == "start":
                    if control.get("audioFormat") != "f32le" or control.get("channels") != 1:
                        await websocket.close(code=1003, reason="Expected mono f32le audio")
                        return
                    sample_rate = int(control.get("sampleRate", sample_rate))
                elif control.get("type") == "stop":
                    if pending_samples:
                        offset_ms = await emit_segment(websocket, np.concatenate(pending), sample_rate, segment_index, offset_ms)
                    await websocket.close()
                    return
            elif "bytes" in message and message["bytes"] is not None:
                chunk = np.frombuffer(message["bytes"], dtype="<f4").copy()
                pending.append(chunk)
                pending_samples += len(chunk)
                if pending_samples >= WINDOW_SECONDS * sample_rate:
                    offset_ms = await emit_segment(websocket, np.concatenate(pending), sample_rate, segment_index, offset_ms)
                    segment_index += 1
                    pending, pending_samples = [], 0
    except WebSocketDisconnect:
        return
