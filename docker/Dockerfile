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
ARG PYTHON_BUILD_IMAGE=cgr.dev/chainguard/python:latest-dev@sha256:7a568bcee42666f73f041645a41c913ce1d442f4c24cf6019bc543a90820e531
ARG PYTHON_RUNTIME_IMAGE=cgr.dev/chainguard/python:latest@sha256:a0365f7b90bf7b78a5e35f2709efb7c9263acf9c7b1905e0ec4c3e943c88e64d
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.13.8@sha256:5cc1805e2426484abca4ad46ea783bab281fdb225fd82d8ce6d66a81254bac85

# =============================================================================
# Stage: uv — installs the detector from detector/uv.lock (build-time only)
# =============================================================================
FROM ${UV_IMAGE} AS uv

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

COPY --from=uv /uv /usr/local/bin/uv

# Install exactly the versions locked in detector/uv.lock into /opt/venv, with
# the image's own Python. The lock takes torch from the CPU-only PyTorch index,
# so no CUDA libraries are pulled in. --locked fails the build if uv.lock does
# not match pyproject.toml. uv does not install pip into the venv.
ENV UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_PYTHON_DOWNLOADS=never \
    UV_COMPILE_BYTECODE=1 \
    UV_NO_CACHE=1 \
    UV_LINK_MODE=copy \
    UV_HTTP_TIMEOUT=120 \
    UV_HTTP_RETRIES=5

WORKDIR /srv/detector
COPY detector/pyproject.toml detector/uv.lock ./
# Dependencies first, so a detector source change does not reinstall torch.
RUN uv sync --locked --no-dev --no-install-project --group image --python /usr/bin/python
COPY detector/detector ./detector
RUN uv sync --locked --no-dev --no-editable --group image --python /usr/bin/python \
    && uv pip check --python /opt/venv/bin/python
ENV PATH="/opt/venv/bin:${PATH}"

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
# ONNX Runtime 1.29.0 (required by GLiNER 0.2.28 in 0.9.3) crashes during import
# when telemetry is on and /bin/sh is absent. GLiNER 0.2.29 made ONNX Runtime
# optional; keep telemetry off in case a dependency pulls it in again.
ENV ORT_DISABLE_TELEMETRY=1

EXPOSE 5002
HEALTHCHECK --interval=10s --timeout=3s --start-period=40s --retries=5 \
    CMD ["python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:5002/health').status==200 else 1)"]

USER 65532
# Exercise startup and inference in the offline, nonroot runtime, not the builder.
RUN ["python", "-X", "faulthandler", "-m", "detector.smoke"]
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
