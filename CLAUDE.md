# PasteGuard

OpenAI-compatible proxy with two privacy modes: route to local LLM or mask PII for upstream.

## Tech Stack

- Runtime: Bun
- Framework: Hono (with JSX for dashboard)
- Validation: Zod
- Styling: Tailwind CSS v4
- Database: SQLite (`data/pasteguard.db`)
- PII Detection: Microsoft Presidio (Docker)
- Code Style: Biome (see @biome.json)

## Architecture

```
src/
├── index.ts                 # Hono server entry
├── config.ts                # YAML config + Zod validation
├── routes/
│   ├── proxy.ts             # POST /openai/v1/chat/completions
│   ├── dashboard.tsx        # Dashboard routes + API
│   ├── health.ts            # GET /health
│   └── info.ts              # GET /info
├── views/
│   └── dashboard/
│       └── page.tsx         # Dashboard UI
└── services/
    ├── decision.ts          # Route/mask logic
    ├── pii-detector.ts      # Presidio client
    ├── llm-client.ts        # OpenAI/Ollama client
    ├── masking.ts           # PII mask/unmask
    ├── stream-transformer.ts # SSE unmask for streaming
    ├── language-detector.ts # Auto language detection
    └── logger.ts            # SQLite logging
```

Tests are colocated (`*.test.ts`).

## Modes

Two modes configured in `config.yaml`:

- **Route**: Routes PII-containing requests to local LLM (requires `local` provider + `routing` config)
- **Mask**: Masks PII before upstream, unmasks response (no local provider needed)

See @config.example.yaml for full configuration.

## Commands

- `bun run dev` - Development (hot reload)
- `bun run start` - Production
- `bun run build` - Build to dist/
- `bun test` - Run tests
- `bun run typecheck` - Type check
- `bun run lint` - Lint only
- `bun run check` - Lint + format check
- `bun run format` - Format code

## Setup

**Production:** `docker compose up -d`

**Development:**
```bash
cp config.example.yaml config.yaml
docker compose up presidio-analyzer -d
bun install && bun run dev
```

**Dependencies:**
- Presidio (port 5002) - required
- Ollama (port 11434) - route mode only

**Multi-language PII:** Build with `LANGUAGES=en,de,fr docker compose build`. See @presidio/languages.yaml for 24 available languages.

## Testing

- `GET /health` - Health check
- `GET /info` - Mode info
- `POST /openai/v1/chat/completions` - Main endpoint

Response header `X-PasteGuard-PII-Masked: true` indicates PII was masked.
