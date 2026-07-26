# PasteGuard Detector

The FastAPI detector combines deterministic checks for structured identifiers
with GLiNER for names, locations, and addresses.

## Run

```bash
cd detector
python -m venv .venv
.venv/bin/pip install -e ".[dev]"
.venv/bin/uvicorn detector.app:app --host 0.0.0.0 --port 5002
```

The default model is `urchade/gliner_multi_pii-v1`.

## Models

Set `DETECTOR_MODEL` to a Hugging Face model ID or local checkpoint:

```bash
DETECTOR_MODEL=urchade/gliner_small-v2.1 \
.venv/bin/uvicorn detector.app:app --host 0.0.0.0 --port 5002

DETECTOR_MODEL=/models/custom-gliner \
.venv/bin/uvicorn detector.app:app --host 0.0.0.0 --port 5002
```

A local checkpoint needs `gliner_config.json` and either `model.safetensors` or
`pytorch_model.bin`. Invalid models fail during startup.

See [Semantic Backends](../docs/configuration/semantic-backends.mdx) and
[GLiNER](../docs/configuration/gliner.mdx).

## Endpoints

- `GET /health` — readiness plus loaded backend and model
- `POST /analyze` — detected entities with UTF-16 offsets

```bash
curl http://localhost:5002/health
```

```json
{
  "status": "ok",
  "backend": "gliner",
  "model": "urchade/gliner_multi_pii-v1"
}
```

## Checks

```bash
.venv/bin/python -m pytest -q
.venv/bin/ruff check .
.venv/bin/ruff format . --check
.venv/bin/pyright
```
