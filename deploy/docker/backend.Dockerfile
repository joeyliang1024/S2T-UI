# Independent Python API; build target "audio" for persistent native workers.
FROM python:3.12-slim AS base
WORKDIR /app
ARG PIP_INDEX_URL
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 \
    NODE_ENV=production BACKEND_PORT=8787 S2T_MODEL_DIR=/models S2T_DATA_DIR=/data
COPY backend/requirements.lock /app/requirements.lock
RUN python -m pip install --no-cache-dir --upgrade pip==26.2.0 \
    && python -m pip install --no-cache-dir --require-hashes -r requirements.lock
RUN mkdir /data && chown 10001:10001 /data
EXPOSE 8787
CMD ["python", "-m", "app"]

FROM base AS api
COPY backend/app /app/app
COPY backend/resources /app/resources
COPY icon /app/icon
COPY LICENSE /app/LICENSE
USER 10001:10001

FROM base AS audio
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 libsndfile1 && rm -rf /var/lib/apt/lists/*
COPY backend/requirements-audio.lock /app/requirements-audio.lock
RUN pip install --no-cache-dir --require-hashes -r requirements-audio.lock
COPY dependencies/ffmpeg-static /opt/s2t-ffmpeg
RUN case "${TARGETARCH:-$(dpkg --print-architecture)}" in amd64) ffmpeg_arch=x64 ;; arm64) ffmpeg_arch=arm64 ;; *) exit 1 ;; esac \
    && install -m 0755 /opt/s2t-ffmpeg/ffmpeg-linux-$ffmpeg_arch /usr/local/bin/ffmpeg \
    && rm -rf /opt/s2t-ffmpeg

COPY backend/app /app/app
COPY backend/resources /app/resources
COPY icon /app/icon
COPY LICENSE /app/LICENSE
USER 10001:10001
