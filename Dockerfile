ARG LANGUAGES="en"

# Stage 1: Generate Presidio configs
FROM python:3.11-slim AS generator

WORKDIR /build

RUN pip install --no-cache-dir pyyaml

COPY docker/presidio/languages.yaml /build/
COPY docker/presidio/scripts/generate-configs.py /build/

ARG LANGUAGES
RUN python generate-configs.py \
    --languages="${LANGUAGES}" \
    --registry=/build/languages.yaml \
    --output=/output

# Stage 2: Build Bun app
FROM oven/bun:1-slim AS bun-builder

WORKDIR /app

# Install dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Copy source
COPY src ./src
COPY tsconfig.json ./

# Stage 3: Final image
FROM mcr.microsoft.com/presidio-analyzer:latest

ARG LANGUAGES

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    supervisor \
    curl \
    unzip \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Rust required for Japanese tokenizer
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

# Copy Presidio config
COPY --from=generator /output/nlp-config.yaml /usr/bin/presidio_analyzer/conf/default.yaml
COPY --from=generator /output/recognizers-config.yaml /usr/bin/presidio_analyzer/conf/default_recognizers.yaml
COPY --from=generator /output/analyzer-config.yaml /usr/bin/presidio_analyzer/conf/default_analyzer.yaml

# Install spaCy models
COPY --from=generator /output/install-models.sh /tmp/
RUN chmod +x /tmp/install-models.sh && /tmp/install-models.sh && rm /tmp/install-models.sh

# Copy app
WORKDIR /app
COPY --from=bun-builder /app/node_modules ./node_modules
COPY --from=bun-builder /app/src ./src
COPY --from=bun-builder /app/package.json ./
COPY --from=bun-builder /app/tsconfig.json ./

# Default config with build-time languages
COPY config.example.yaml ./config.yaml
RUN pip install --no-cache-dir pyyaml && python3 << EOF
import yaml
languages = "${LANGUAGES}".split(",")
with open("/app/config.yaml") as f:
    config = yaml.safe_load(f)
config["pii_detection"]["languages"] = languages
with open("/app/config.yaml", "w") as f:
    yaml.dump(config, f, default_flow_style=False, sort_keys=False)
EOF

RUN mkdir -p /app/data

# Copy Docker support files
COPY docker/supervisord.conf /etc/supervisor/conf.d/pasteguard.conf
COPY docker/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

ENV PRESIDIO_URL=http://localhost:5002
ENV PORT=5002
ENV WORKERS=1
ENV START_APP=true

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

ENTRYPOINT ["/app/entrypoint.sh"]
