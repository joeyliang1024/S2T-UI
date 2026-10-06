#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
architecture=${2:-amd64}
case "$architecture" in
  amd64) runtime=linux-x64; base=amd64/node:22-bookworm-slim ;;
  arm64) runtime=linux-arm64; base=arm64v8/node:22-bookworm-slim ;;
  *) echo 'Supported architectures: amd64, arm64' >&2; exit 2 ;;
esac
context=$(mktemp -d)
trap 'rm -rf "$context"' EXIT HUP INT TERM
mkdir -p "$context/models/nemotron-3-diarization/runtime" "$context/docker"
cp -R "$root/models/nemotron-3-diarization/runtime/$runtime" "$context/models/nemotron-3-diarization/runtime/"
cp "$root/models/nemotron-3-diarization/Nemotron-3-Diarization.q8_0.gguf" "$context/models/nemotron-3-diarization/"
cp -R "$root/docker/nemotron" "$context/docker/"
cp "$root/Dockerfile.nemotron" "$context/Dockerfile"
docker build --network=none --platform "linux/$architecture" --build-arg "RUNTIME_DIR=$runtime" --build-arg "BASE_IMAGE=$base" -t "${1:-s2t-nemotron:0.2.0-q8-$architecture}" "$context"
