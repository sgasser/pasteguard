# PasteGuard - All-in-One Image
# Single container with Proxy + PII Detection
#
# Build: docker build -f docker/Dockerfile --build-arg LANGUAGES=en -t pasteguard:en .
# Run:   docker run -p 3000:3000 -v ./config.yaml:/app/config.yaml -v ./data:/app/data pasteguard:en

ARG LANGUAGES="en"

# =============================================================================
# Stage 1: Generate Presidio configuration files
# =============================================================================
FROM python:3.11-slim AS generator

WORKDIR /build

RUN pip install --no-cache-dir pyyaml

COPY docker/presidio/languages.yaml /build/
COPY docker/presidio/generate-configs.py /build/

ARG LANGUAGES
RUN python generate-configs.py \
    --languages="${LANGUAGES}" \
    --registry=/build/languages.yaml \
    --output=/output

# =============================================================================
# Stage 2: Build Bun application
# =============================================================================
FROM oven/bun:1-slim AS bun-builder

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src
COPY tsconfig.json ./

# =============================================================================
# Stage 3: Final combined image
# =============================================================================
FROM mcr.microsoft.com/presidio-analyzer:latest

ARG LANGUAGES

# Install supervisor for process management
RUN apt-get update && apt-get install -y --no-install-recommends \
    supervisor \
    curl \
    unzip \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Install Rust only if Japanese is included
RUN if echo "${LANGUAGES}" | grep -q "ja"; then \
        apt-get update && apt-get install -y --no-install-recommends build-essential \
        && curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y \
        && apt-get clean \
        && rm -rf /var/lib/apt/lists/*; \
    fi
ENV PATH="/root/.cargo/bin:${PATH}"

# Install Bun
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

# Copy Presidio configuration
COPY --from=generator /output/nlp-config.yaml /usr/bin/presidio_analyzer/conf/default.yaml
COPY --from=generator /output/recognizers-config.yaml /usr/bin/presidio_analyzer/conf/default_recognizers.yaml
COPY --from=generator /output/analyzer-config.yaml /usr/bin/presidio_analyzer/conf/default_analyzer.yaml

# Install spaCy models
COPY --from=generator /output/install-models.sh /tmp/
RUN chmod +x /tmp/install-models.sh && /tmp/install-models.sh && rm /tmp/install-models.sh

# Copy Bun application
WORKDIR /app
COPY --from=bun-builder /app/node_modules ./node_modules
COPY --from=bun-builder /app/src ./src
COPY --from=bun-builder /app/package.json ./
COPY --from=bun-builder /app/tsconfig.json ./
COPY config.example.yaml ./

# Create data directory
RUN mkdir -p /app/data

# Copy supervisor configuration
COPY docker/supervisord.conf /etc/supervisor/conf.d/pasteguard.conf

# Environment defaults
ENV PRESIDIO_URL=http://localhost:5002
ENV PORT=5002
ENV WORKERS=1
ENV START_APP=true
ENV PASTEGUARD_LANGUAGES=${LANGUAGES}

EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/pasteguard.conf"]
