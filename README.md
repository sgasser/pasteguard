# 🛡️ PasteGuard

[![CI](https://github.com/sgasser/pasteguard/actions/workflows/ci.yml/badge.svg)](https://github.com/sgasser/pasteguard/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

Privacy proxy for LLMs. Masks personal data before sending to your provider (OpenAI, Azure, etc.), or routes sensitive requests to local LLM.

<img src="docs/dashboard.png" width="100%" alt="PasteGuard Dashboard">

## Mask Mode (Default)

Replaces personal data with placeholders before sending to LLM. Unmasks the response automatically.

```
You send:              "Email john@acme.com about the meeting with Sarah Miller"
OpenAI receives:       "Email <EMAIL_1> about the meeting with <PERSON_1>"
OpenAI responds:       "I'll contact <EMAIL_1> to schedule with <PERSON_1>..."
You receive:           "I'll contact john@acme.com to schedule with Sarah Miller..."
```

- No local GPU needed
- Supports streaming with real-time unmasking

## Route Mode

Requests with personal data go to local LLM. Everything else goes to your provider.

```
"Help with code review"              → OpenAI (best quality)
"Email john@acme.com about..."       → Ollama (stays on your network)
```

- Requires local LLM (Ollama, vLLM, LocalAI)
- Full data isolation - personal data never leaves your network

## What It Detects

| Type | Examples |
|------|----------|
| Names | John Smith, Sarah Miller |
| Emails | john@acme.com |
| Phone numbers | +1 555 123 4567 |
| Credit cards | 4111-1111-1111-1111 |
| IBANs | DE89 3704 0044 0532 0130 00 |
| IP addresses | 192.168.1.1 |
| Locations | New York, Berlin |

Additional entity types can be enabled: `US_SSN`, `US_PASSPORT`, `CRYPTO`, `NRP`, `MEDICAL_LICENSE`, `URL`.

**Languages**: 24 languages supported (configurable at build time). Auto-detected per request.

Powered by [Microsoft Presidio](https://microsoft.github.io/presidio/).

## Quick Start

### Docker (recommended)

```bash
git clone https://github.com/sgasser/pasteguard.git
cd pasteguard
cp config.example.yaml config.yaml

# Option 1: English only (default, ~1.5GB)
docker compose up -d

# Option 2: Multiple languages (~2.5GB)
# Edit config.yaml to add languages, then:
LANGUAGES=en,de,fr,es,it docker compose up -d
```

### Local Development

```bash
git clone https://github.com/sgasser/pasteguard.git
cd pasteguard
bun install
cp config.example.yaml config.yaml

# Option 1: English only (default)
docker compose up presidio-analyzer -d

# Option 2: Multiple languages
# Edit config.yaml to add languages, then:
LANGUAGES=en,de,fr,es,it docker compose build presidio-analyzer
docker compose up presidio-analyzer -d

bun run dev
```

Dashboard: http://localhost:3000/dashboard

**Usage:** Point your app to `http://localhost:3000/openai/v1` instead of `https://api.openai.com/v1`.

## Language Configuration

By default, only English is installed to minimize image size. Add more languages at build time:

```bash
# English only (default, smallest image ~1.5GB)
docker compose build

# English + German
LANGUAGES=en,de docker compose build

# Multiple languages
LANGUAGES=en,de,fr,it,es docker compose build
```

**Available languages (24):**
`ca`, `zh`, `hr`, `da`, `nl`, `en`, `fi`, `fr`, `de`, `el`, `it`, `ja`, `ko`, `lt`, `mk`, `nb`, `pl`, `pt`, `ro`, `ru`, `sl`, `es`, `sv`, `uk`

**Language Fallback Behavior:**
- Text language is auto-detected for each request
- If detected language is not installed, falls back to `fallback_language` (default: `en`)
- Dashboard shows fallback as `FR→EN` when French text is detected but only English is installed
- Response header `X-PasteGuard-Language-Fallback: true` indicates fallback was used

Update `config.yaml` to match your installed languages:

```yaml
pii_detection:
  languages:
    - en
    - de
```

See [presidio/languages.yaml](presidio/languages.yaml) for full details including context words.

## Configuration

**Mask mode:**

```yaml
mode: mask
providers:
  upstream:
    type: openai
    base_url: https://api.openai.com/v1
masking:
  placeholder_format: "<{TYPE}_{N}>"  # Format for masked values
  show_markers: false                  # Add visual markers to unmasked values
```

**Route mode:**

```yaml
mode: route
providers:
  upstream:
    type: openai
    base_url: https://api.openai.com/v1
  local:
    type: ollama
    base_url: http://localhost:11434
    model: llama3.2                   # Model for all local requests
routing:
  default: upstream
  on_pii_detected: local
```

**Customize detection:**

```yaml
pii_detection:
  score_threshold: 0.7        # Confidence (0.0 - 1.0)
  entities:                   # What to detect
    - PERSON
    - EMAIL_ADDRESS
    - PHONE_NUMBER
    - CREDIT_CARD
    - IBAN_CODE
```

**Logging options:**

```yaml
logging:
  database: ./data/pasteguard.db
  retention_days: 30           # 0 = keep forever
  log_content: false           # Log full request/response
  log_masked_content: true     # Log masked content for dashboard
```

**Dashboard authentication:**

```yaml
dashboard:
  auth:
    username: admin
    password: ${DASHBOARD_PASSWORD}
```

**Environment variables:** Config values support `${VAR}` and `${VAR:-default}` substitution.

See [config.example.yaml](config.example.yaml) for all options.

## API Reference

**Endpoints:**

| Endpoint | Description |
|----------|-------------|
| `POST /openai/v1/chat/completions` | Chat API (OpenAI-compatible) |
| `GET /openai/v1/models` | List models |
| `GET /dashboard` | Monitoring UI |
| `GET /dashboard/api/logs` | Request logs (JSON) |
| `GET /dashboard/api/stats` | Statistics (JSON) |
| `GET /health` | Health check |
| `GET /info` | Current configuration |

**Response headers:**

| Header | Value |
|--------|-------|
| `X-Request-ID` | Request identifier (forwarded or generated) |
| `X-PasteGuard-Mode` | `route` / `mask` |
| `X-PasteGuard-PII-Detected` | `true` / `false` |
| `X-PasteGuard-PII-Masked` | `true` / `false` (mask mode) |
| `X-PasteGuard-Provider` | `upstream` / `local` |
| `X-PasteGuard-Language` | Detected language code |
| `X-PasteGuard-Language-Fallback` | `true` if fallback was used |

## Development

```bash
docker compose up presidio-analyzer -d    # Start detection service
bun run dev                               # Dev server with hot reload
bun test                                  # Run tests
bun run check                             # Lint & format
```

## Benchmarks

PII detection accuracy benchmark with test cases for multiple languages:

```bash
# Start Presidio with all benchmark languages
LANGUAGES=en,de,fr,it,es docker compose up presidio-analyzer -d

# Run all tests
bun run benchmarks/pii-accuracy/run.ts

# Run specific languages only
bun run benchmarks/pii-accuracy/run.ts --languages de,en

# Verbose output
bun run benchmarks/pii-accuracy/run.ts --verbose
```

Test data in `benchmarks/pii-accuracy/test-data/` (one file per language).

## License

[Apache 2.0](LICENSE)
