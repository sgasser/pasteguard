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
RUN python -c "from gliner import GLiNER; GLiNER.from_pretrained('${DETECTOR_MODEL}')"

EXPOSE 5002
HEALTHCHECK --interval=10s --timeout=3s --start-period=40s --retries=5 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:5002/health').status==200 else 1)"

CMD ["uvicorn", "detector.app:app", "--host", "0.0.0.0", "--port", "5002"]
