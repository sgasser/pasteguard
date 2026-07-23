# syntax=docker/dockerfile:1

# PasteGuard — Docker image (multi-stage, single source of truth)
#
# Two build targets share ONE detector definition (the `detector` stage):
#   * detector  — the PII detector alone (uvicorn on :5002). Used by the
#                 docker-compose `detector` dev service so the proxy can run from
#                 source against it.
#                 Build: docker build -f docker/Dockerfile --target detector -t pasteguard-detector .
#   * (default) — the all-in-one deployment image: Bun proxy + detector under
#                 supervisord. This is the published artifact.
#                 Build: docker build -f docker/Dockerfile -t pasteguard:latest .
#
# Run the all-in-one:
#   docker run -p 3000:3000 \
#     -v ./config.yaml:/pasteguard/config.yaml:ro \
#     -v ./data:/pasteguard/data \
#     pasteguard:latest

ARG BUN_IMAGE=oven/bun:1-slim@sha256:d56a2534ffd262e92c12fd3249d3924d296d97086da773f821d7d0477435ea04
ARG PYTHON_BUILD_IMAGE=cgr.dev/chainguard/python:latest-dev@sha256:967409cf4148210d7c1bb872ffdda42a8b73cfc738f95eae7413045d0d6c30ee
ARG PYTHON_RUNTIME_IMAGE=cgr.dev/chainguard/python:latest@sha256:2c6a2e8bdeb1336cd8545d3586d1c1e5b4f7564ef00924b0447ebfbe57a549ee

# =============================================================================
# Stage: bun-builder — build the Bun application
# =============================================================================
FROM ${BUN_IMAGE} AS bun-builder

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src
COPY tsconfig.json ./

# =============================================================================
# Stage: detector-builder — install the detector and download its model
# =============================================================================
FROM ${PYTHON_BUILD_IMAGE} AS detector-builder

USER root

RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:${PATH}"

# The explicit CPU index prevents PyPI from pulling unused CUDA libraries.
RUN pip install --no-cache-dir typing-extensions \
    && pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu

RUN pip install --no-cache-dir setuptools==83.0.0

ENV PIP_DEFAULT_TIMEOUT=120
ENV PIP_RETRIES=5

COPY detector/pyproject.toml /srv/detector/
COPY detector/detector /srv/detector/detector
RUN pip install --no-cache-dir supervisor==4.3.0 /srv/detector \
    && pip check \
    && pip uninstall -y pip

ENV DETECTOR_MODEL=urchade/gliner_multi_pii-v1
ENV HF_HOME=/opt/models
RUN --mount=type=cache,target=/tmp/huggingface \
    ok=""; for i in 1 2 3; do \
        HF_HOME=/tmp/huggingface python -c "import os; from gliner import GLiNER; GLiNER.from_pretrained(os.environ['DETECTOR_MODEL'])" && { ok=1; break; }; \
        echo "model fetch attempt $i failed; retrying in 10s"; sleep 10; \
    done; \
    [ -n "$ok" ] \
    && mkdir -p /opt/models \
    && cp -a /tmp/huggingface/. /opt/models/ \
    && mkdir -p /tmp/empty-data \
    || exit 1

# =============================================================================
# Stage: detector — the standalone PII detector runtime
# =============================================================================
FROM ${PYTHON_RUNTIME_IMAGE} AS detector

COPY --from=detector-builder /opt/venv /opt/venv
COPY --from=detector-builder --chown=65532:65532 /opt/models /opt/models
COPY --from=detector-builder --chown=65532:65532 /tmp/empty-data /pasteguard/data

ENV PATH="/opt/venv/bin:${PATH}"
ENV DETECTOR_MODEL=urchade/gliner_multi_pii-v1
ENV HF_HOME=/opt/models
ENV HF_HUB_OFFLINE=1
ENV TRANSFORMERS_OFFLINE=1
ENV HOME=/home/nonroot

EXPOSE 5002
HEALTHCHECK --interval=10s --timeout=3s --start-period=40s --retries=5 \
    CMD ["python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:5002/health').status==200 else 1)"]

USER 65532
ENTRYPOINT []
CMD ["uvicorn", "detector.app:app", "--host", "0.0.0.0", "--port", "5002"]

# =============================================================================
# Stage: all-in-one — Bun proxy + detector under supervisord (default target)
# =============================================================================
FROM detector AS allinone

# Copy the Bun binary from the official image (baseline build for x86_64
# compatibility on older CPUs, see https://github.com/sgasser/pasteguard/issues/70).
COPY --from=bun-builder /usr/local/bin/bun /usr/local/bin/bun

# Copy the Bun application.
WORKDIR /pasteguard
COPY --from=bun-builder /app/node_modules ./node_modules
COPY --from=bun-builder /app/src ./src
COPY --from=bun-builder /app/package.json ./
COPY --from=bun-builder /app/tsconfig.json ./
COPY config.example.yaml ./

COPY docker/supervisord.conf /etc/supervisord.conf

# The proxy talks to the in-container detector.
ENV DETECTOR_URL=http://localhost:5002

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD ["python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:3000/health').status==200 else 1)"]

CMD ["/opt/venv/bin/supervisord", "-c", "/etc/supervisord.conf"]
