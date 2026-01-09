# PasteGuard Presidio Analyzer
# Multi-language PII detection with configurable language support
#
# Build with specific languages:
#   docker build --build-arg LANGUAGES=en,de,fr -t presidio-analyzer .
#
# Or via docker-compose:
#   LANGUAGES=en,de docker-compose build presidio-analyzer

ARG LANGUAGES="en"

# =============================================================================
# Stage 1: Generate configuration files from language selection
# =============================================================================
FROM python:3.11-slim AS generator

WORKDIR /build

# Install PyYAML for config generation
RUN pip install --no-cache-dir pyyaml

# Copy registry and generator script
COPY languages.yaml /build/
COPY scripts/generate-configs.py /build/

# Generate configs for selected languages
ARG LANGUAGES
RUN python generate-configs.py \
    --languages="${LANGUAGES}" \
    --registry=/build/languages.yaml \
    --output=/output

# =============================================================================
# Stage 2: Final Presidio Analyzer image
# =============================================================================
FROM mcr.microsoft.com/presidio-analyzer:latest

# Copy generated configuration files
COPY --from=generator /output/nlp-config.yaml /usr/bin/presidio_analyzer/conf/default.yaml
COPY --from=generator /output/recognizers-config.yaml /usr/bin/presidio_analyzer/conf/default_recognizers.yaml
COPY --from=generator /output/analyzer-config.yaml /usr/bin/presidio_analyzer/conf/default_analyzer.yaml

# Copy and run model installation script
COPY --from=generator /output/install-models.sh /tmp/
RUN chmod +x /tmp/install-models.sh && /tmp/install-models.sh && rm /tmp/install-models.sh

# Use --preload to load models once in master process (shared via copy-on-write)
# Timeout 300s for initial model loading, workers start fast after preload
CMD ["/bin/sh", "-c", "poetry run gunicorn -w $WORKERS -b 0.0.0.0:$PORT --timeout 300 --preload 'app:create_app()'"]
