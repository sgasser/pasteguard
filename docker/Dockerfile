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

# =============================================================================
# Stage: bun-builder — build the Bun application
# =============================================================================
FROM oven/bun:1-slim AS bun-builder

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src
COPY tsconfig.json ./

# =============================================================================
# Stage: detector — the PII detector service (also a standalone build target)
# =============================================================================
FROM python:3.11-slim AS detector

# CPU-only torch. The CPU index serves both x86_64 and aarch64 CPU wheels, so
# pin it for every arch. (PyPI's DEFAULT index now ships CUDA builds for
# linux/arm64 too — e.g. torch 2.x+cuXXX — which would drag ~6 GB of unused
# CUDA libraries into the image; the explicit CPU index avoids that.)
RUN pip install --no-cache-dir typing-extensions \
    && pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu

# Install the detector package (pulls fastapi/uvicorn/gliner/stdnum/...).
COPY detector/pyproject.toml /srv/detector/
COPY detector/detector /srv/detector/detector
RUN pip install --no-cache-dir /srv/detector

# Bake the default model into a location the all-in-one runtime user (UID 1000)
# can also read, and force offline use at runtime (no network needed for models).
ENV DETECTOR_MODEL=urchade/gliner_multi_pii-v1
ENV HF_HOME=/opt/models
# Retry the fetch: under multi-arch (QEMU) builds a transient HF rate-limit or
# network blip should not fail the whole image build.
RUN ok=""; for i in 1 2 3; do \
        python -c "import os; from gliner import GLiNER; GLiNER.from_pretrained(os.environ['DETECTOR_MODEL'])" && { ok=1; break; }; \
        echo "model fetch attempt $i failed; retrying in 10s"; sleep 10; \
    done; \
    [ -n "$ok" ] && chown -R 1000:1000 /opt/models || exit 1
ENV HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1

EXPOSE 5002
HEALTHCHECK --interval=10s --timeout=3s --start-period=40s --retries=5 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:5002/health').status==200 else 1)"

CMD ["uvicorn", "detector.app:app", "--host", "0.0.0.0", "--port", "5002"]

# =============================================================================
# Stage: all-in-one — Bun proxy + detector under supervisord (default target)
# =============================================================================
FROM detector AS allinone

# supervisor manages both processes; curl backs the health check.
RUN apt-get update && apt-get install -y --no-install-recommends \
    supervisor \
    curl \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Copy the Bun binary from the official image (baseline build for x86_64
# compatibility on older CPUs, see https://github.com/sgasser/pasteguard/issues/70).
COPY --from=bun-builder /usr/local/bin/bun /usr/local/bin/bun
ENV PATH="/usr/local/bin:${PATH}"

# Copy the Bun application.
WORKDIR /pasteguard
COPY --from=bun-builder /app/node_modules ./node_modules
COPY --from=bun-builder /app/src ./src
COPY --from=bun-builder /app/package.json ./
COPY --from=bun-builder /app/tsconfig.json ./
COPY config.example.yaml ./

# Create a real UID-1000 user with a home dir. torch resolves its cache dir via
# getpwuid() at import, which fails on a bare numeric USER with no passwd entry.
RUN useradd --uid 1000 --create-home --home-dir /home/pasteguard pasteguard \
    && mkdir -p /pasteguard/data && chown -R 1000:1000 /pasteguard

COPY docker/supervisord.conf /etc/supervisor/conf.d/pasteguard.conf

USER 1000
ENV HOME=/home/pasteguard

# The proxy talks to the in-container detector.
ENV DETECTOR_URL=http://localhost:5002

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/pasteguard.conf"]
