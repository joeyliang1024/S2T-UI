"""Score WAVs exported by segmentation-sweep with a temporary local MLX model.

Run using an isolated mlx-whisper environment; no server or application config is changed.
"""
import argparse
import json
import subprocess
import time
from pathlib import Path

import mlx_whisper
import numpy as np

parser = argparse.ArgumentParser()
parser.add_argument('directory', type=Path)
parser.add_argument('--model', required=True)
parser.add_argument('--ffmpeg', required=True)
args = parser.parse_args()
report = json.loads((args.directory / 'segmentation.json').read_text())
results = []
bridge = subprocess.Popen(["node", "scripts/evaluation/asr-text-filter.cjs"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
for row in report['results']:
    texts, raw_texts, timings = [], [], []
    for name in row['chunks']:
        decoded = subprocess.run([args.ffmpeg, '-v', 'error', '-i', str(args.directory / name), '-f', 'f32le', '-ac', '1', '-ar', '16000', '-'], check=True, capture_output=True)
        audio = np.frombuffer(decoded.stdout, dtype=np.float32).copy()
        start = time.monotonic()
        response = mlx_whisper.transcribe(audio, path_or_hf_repo=args.model, language='zh', temperature=0, condition_on_previous_text=False, initial_prompt=(texts[-1][-60:] if texts else None))
        timings.append(round((time.monotonic()-start)*1000, 1))
        raw_texts.append(response['text'])
        bridge.stdin.write(json.dumps(response['text']) + '\n')
        bridge.stdin.flush()
        texts.append(json.loads(bridge.stdout.readline()))
    results.append({**row, 'hypothesis': ''.join(texts), 'chunkTexts': texts, 'rawChunkTexts': raw_texts, 'inferenceMs': timings})
    (args.directory / 'local-asr.json').write_text(json.dumps({'model': args.model, 'runtime': 'mlx-whisper 0.4.3 / Metal GPU / temperature 0', 'results': results}, ensure_ascii=False, indent=2))
    print(row['id'], row['maximumMs'], row['silenceMs'], ''.join(texts), flush=True)

bridge.stdin.close()
bridge.wait(timeout=5)
