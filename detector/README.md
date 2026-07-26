# PasteGuard Detector

The detector is a standalone FastAPI service used by PasteGuard. It combines:

- deterministic format and checksum validation for structured identifiers;
- a semantic backend for names, locations, and street addresses.

GLiNER is the only enabled and default semantic backend.

## Run Locally

```bash
cd detector
python -m venv .venv
.venv/bin/pip install -e ".[dev]"
.venv/bin/uvicorn detector.app:app --host 0.0.0.0 --port 5002
```

The default model is `urchade/gliner_multi_pii-v1`.

## Select a Model

Use a Hugging Face model ID:

```bash
DETECTOR_MODEL=urchade/gliner_small-v2.1 \
.venv/bin/uvicorn detector.app:app --host 0.0.0.0 --port 5002
```

Or use a local GLiNER checkpoint:

```bash
DETECTOR_MODEL=/models/custom-gliner \
.venv/bin/uvicorn detector.app:app --host 0.0.0.0 --port 5002
```

A local checkpoint must contain `gliner_config.json` and either
`model.safetensors` or `pytorch_model.bin`. The detector validates the model
before starting inference.

See the full documentation for [semantic backends](../docs/configuration/semantic-backends.mdx)
and [GLiNER configuration](../docs/configuration/gliner.mdx).

## Endpoints

### Health

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

### Analyze

```bash
curl http://localhost:5002/analyze \
  -H "content-type: application/json" \
  --data '{
    "text": "Mario Rossi lives in Rome.",
    "entities": ["PERSON", "LOCATION"],
    "score_threshold": 0.7
  }'
```

Offsets in the response use UTF-16 code units to match JavaScript string
indexing.

## Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `DETECTOR_BACKEND` | `gliner` | Semantic backend |
| `DETECTOR_MODEL` | `urchade/gliner_multi_pii-v1` | Hugging Face model ID or local directory |
| `GLINER_FLOOR_PERSON` | `0.95` | Person confidence floor |
| `GLINER_FLOOR_LOCATION` | `0.80` | Location confidence floor |
| `GLINER_FLOOR_ADDRESS` | `0.80` | Address confidence floor |
| `GLINER_MAX_TOKENS` | `384` | Maximum tokens per model window |

The existing `DETECTOR_MODEL_PATH`, `DETECTOR_FLOOR_*`, and
`DETECTOR_MAX_TOKENS` names remain compatibility fallbacks. Prefer
`DETECTOR_MODEL` and `GLINER_*` for new deployments.

## Development Checks

```bash
.venv/bin/python -m pytest -q
.venv/bin/ruff check .
.venv/bin/ruff format . --check
.venv/bin/pyright
```
