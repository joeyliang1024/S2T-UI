# H100/H200 Linux x64: Python audio service/worker with native CUDA Nemotron.
# Sherpa and Silero use their Python CPU runtimes.
ARG CUDA_DEVEL_IMAGE=nvidia/cuda:12.8.1-devel-ubuntu24.04
ARG CUDA_RUNTIME_IMAGE=nvidia/cuda:12.8.1-cudnn-runtime-ubuntu24.04
FROM ${CUDA_DEVEL_IMAGE} AS native
ARG NEMO_SPEECH_REF=v0.2.0
ARG CUDA_ARCHITECTURES=90
RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates build-essential cmake ninja-build pkg-config libsentencepiece-dev \
    && rm -rf /var/lib/apt/lists/*
RUN git clone --branch "${NEMO_SPEECH_REF}" --depth 1 https://github.com/NVIDIA/NeMo-Speech.cpp.git /source
WORKDIR /source
RUN git submodule update --init llama.cpp \
    && scripts/configure.sh cuda-diar -DCMAKE_CUDA_ARCHITECTURES="${CUDA_ARCHITECTURES}" \
    && cmake --build --preset cuda-diar --parallel 4 \
    && cmake --install build/cuda-diar --prefix /opt/nemo-speech

FROM ${CUDA_RUNTIME_IMAGE}
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 \
    NODE_ENV=production BACKEND_PORT=8787 S2T_MODEL_DIR=/models S2T_DATA_DIR=/data \
    S2T_INFERENCE_BACKEND=cuda \
    LD_LIBRARY_PATH=/opt/nemo-speech/lib:/opt/nemo-speech/lib64:/usr/local/cuda/lib64:/usr/local/nvidia/lib:/usr/local/nvidia/lib64
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-venv libsndfile1 libsentencepiece0 libgomp1 libatomic1 libstdc++6 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ARG PIP_INDEX_URL
RUN python3 -m venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH
COPY backend/requirements-audio.lock /app/requirements-audio.lock
RUN pip install --no-cache-dir --require-hashes -r requirements-audio.lock
COPY --from=native /opt/nemo-speech /opt/nemo-speech
COPY backend/app /app/app
COPY backend/resources /app/resources
COPY icon /app/icon
COPY LICENSE /app/LICENSE
COPY dependencies/ffmpeg-static/ffmpeg-linux-x64 /usr/local/bin/ffmpeg
RUN chmod 0755 /usr/local/bin/ffmpeg && mkdir /data && chown 10001:10001 /data
USER 10001:10001
EXPOSE 8787
CMD ["python", "-m", "app"]
