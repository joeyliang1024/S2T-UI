# Standalone native CPU CLI; local model/runtime are bundled, no install hooks.
ARG BASE_IMAGE=amd64/node:22-bookworm-slim
FROM ${BASE_IMAGE}
ARG RUNTIME_DIR=linux-x64
COPY models/nemotron-3-diarization/runtime/${RUNTIME_DIR}/ /opt/nemotron/runtime/
COPY models/nemotron-3-diarization/Nemotron-3-Diarization.q8_0.gguf /models/Nemotron-3-Diarization.q8_0.gguf
COPY docker/nemotron/ /opt/nemotron/package/
RUN echo '08456d9e22cd9a323c0364d98375f3746d6e68507ebb705cd46438c534c7a3a1  /models/Nemotron-3-Diarization.q8_0.gguf' | sha256sum -c - \
    && /opt/nemotron/runtime/bin/nemo-speech --version
ENV S2T_NEMOTRON_MODEL=/models/Nemotron-3-Diarization.q8_0.gguf
WORKDIR /data
USER 1000:1000
ENTRYPOINT ["/bin/sh", "/opt/nemotron/package/entrypoint.sh"]
CMD ["--version"]
LABEL org.opencontainers.image.title="Nemotron 3 Diarization CPU" \
      org.opencontainers.image.description="Linux native CPU runtime and Q8_0 model, offline inference" \
      org.opencontainers.image.licenses="Apache-2.0 AND OpenMDW-1.1"
