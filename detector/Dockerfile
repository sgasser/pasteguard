FROM python:3.11-slim

WORKDIR /srv

# CPU-only torch first, so the GLiNER dependency does not pull the CUDA build
# (keeps the image small).
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu

COPY pyproject.toml ./
COPY detector ./detector
RUN pip install --no-cache-dir .

# Bake the default model into the image so startup is fast and offline-capable.
ENV DETECTOR_MODEL=urchade/gliner_multi_pii-v1
RUN ok=""; for i in 1 2 3; do \
        python -c "import os; from gliner import GLiNER; GLiNER.from_pretrained(os.environ['DETECTOR_MODEL'])" && { ok=1; break; }; \
        echo "model fetch attempt $i failed; retrying in 10s"; sleep 10; \
    done; \
    [ -n "$ok" ] || exit 1

# Run fully offline at startup: the model is baked in, so never reach out to the
# Hugging Face Hub (required for air-gapped deployments).
ENV HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1

EXPOSE 5002
HEALTHCHECK --interval=10s --timeout=3s --start-period=40s --retries=5 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:5002/health').status==200 else 1)"

CMD ["uvicorn", "detector.app:app", "--host", "0.0.0.0", "--port", "5002"]
