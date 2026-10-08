#!/bin/sh
set -eu
if [ "${1:-}" = diarize ]; then
  shift
  if [ "$#" -eq 0 ]; then echo 'Usage: diarize /data/input.wav [--output /data/output.rttm]' >&2; exit 2; fi
  input=$1
  shift
  exec /opt/nemotron/runtime/bin/nemo-speech diarize "$input" \
    --model "$S2T_NEMOTRON_MODEL" --backend cpu \
    --diar.chunk 264 --diar.right_context 1 --diar.left_context 1 \
    --diar.fifo 0 --diar.spkcache 528 --diar.update_period 188 \
    --format rttm "$@"
fi
exec /opt/nemotron/runtime/bin/nemo-speech "$@"
