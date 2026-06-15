# PasteGuard — All-in-One Image
# Single container running the Bun proxy + the PII detector (deterministic
# regex/checksum + multilingual GLiNER) under supervisord.
#
# Build: docker build -f docker/Dockerfile -t pasteguard:latest .
# Run:   docker run -p 3000:3000 \
#          -v ./config.yaml:/pasteguard/config.yaml:ro \
#          -v ./data:/pasteguard/data \
#          pasteguard:latest
#
# For local development the detector can be run on its own (see detector/ and
# docker-compose.yml); this image is the self-contained deployment artifact.

# =============================================================================
# Stage 1: Build the Bun application
# =============================================================================
FROM oven/bun:1-slim AS bun-builder

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src
COPY tsconfig.json ./

# =============================================================================
# Stage 2: Final combined image (Python detector + Bun proxy)
# =============================================================================
FROM python:3.11-slim

# supervisor manages both processes; curl backs the health check.
RUN apt-get update && apt-get install -y --no-install-recommends \
    supervisor \
    curl \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# CPU-only torch first so the GLiNER dependency does not pull the CUDA build.
# On x86_64 the CUDA build lives on the default index, so pin the CPU index; the
# aarch64 wheels on PyPI are already CPU-only, so install those directly.
ARG TARGETARCH
RUN if [ "$TARGETARCH" = "arm64" ]; then \
        pip install --no-cache-dir torch; \
    else \
        pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu; \
    fi

# Install the detector package (pulls fastapi/uvicorn/gliner/stdnum/...).
COPY detector/pyproject.toml /srv/detector/
COPY detector/detector /srv/detector/detector
RUN pip install --no-cache-dir /srv/detector

# Bake the default model into a location the runtime user (UID 1000) can read,
# and force offline use at runtime so the container needs no network for models.
ENV DETECTOR_MODEL=urchade/gliner_multi_pii-v1
ENV HF_HOME=/opt/models
RUN python -c "from gliner import GLiNER; GLiNER.from_pretrained('${DETECTOR_MODEL}')" \
    && chown -R 1000:1000 /opt/models
ENV HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1

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
