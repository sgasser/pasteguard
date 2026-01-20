# PasteGuard

Privacy proxy for LLMs. Masks personal data and secrets before sending prompts to your provider (OpenAI, Anthropic, etc.).

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
├── constants/               # Shared constants
│   ├── languages.ts         # Supported languages
│   └── timeouts.ts          # HTTP timeout values
├── routes/
│   ├── openai.ts            # /openai/v1/* (chat completions + wildcard proxy)
│   ├── anthropic.ts         # /anthropic/v1/* (messages + wildcard proxy)
│   ├── dashboard.tsx        # Dashboard routes + API
│   ├── health.ts            # GET /health
│   ├── info.ts              # GET /info
│   └── utils.ts             # Shared route utilities
├── providers/
│   ├── errors.ts            # Shared provider errors
│   ├── local.ts             # Local LLM client (Ollama/OpenAI-compatible)
│   ├── openai/
│   │   ├── client.ts        # OpenAI API client
│   │   ├── stream-transformer.ts  # SSE unmasking for streaming
│   │   └── types.ts         # OpenAI request/response types
│   └── anthropic/
│       ├── client.ts        # Anthropic API client
│       ├── stream-transformer.ts  # SSE unmasking for streaming
│       └── types.ts         # Anthropic request/response types
├── masking/
│   ├── service.ts           # Masking orchestration
│   ├── context.ts           # Masking context management
│   ├── placeholders.ts      # Placeholder generation
│   ├── conflict-resolver.ts # Overlapping entity resolution
│   ├── types.ts             # Shared masking types
│   └── extractors/
│       ├── openai.ts        # OpenAI text extraction/insertion
│       └── anthropic.ts     # Anthropic text extraction/insertion
├── pii/
│   ├── detect.ts            # Presidio client
│   └── mask.ts              # PII masking logic
├── secrets/
│   ├── detect.ts            # Secret detection
│   ├── mask.ts              # Secret masking
│   └── patterns/            # Secret pattern definitions
├── services/
│   ├── pii.ts               # PII detection service
│   ├── secrets.ts           # Secrets processing service
│   ├── language-detector.ts # Auto language detection
│   └── logger.ts            # SQLite logging
├── utils/
│   └── content.ts           # Content utilities
└── views/
    └── dashboard/
        └── page.tsx         # Dashboard UI
```

Tests are colocated (`*.test.ts`).

## Modes

Two modes configured in `config.yaml`:

- **Route**: Routes PII-containing requests to local LLM (requires `local` provider config)
- **Mask**: Masks PII before sending to configured provider, unmasks response (no local provider needed)

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

**Production:**
```bash
cp config.example.yaml config.yaml
docker compose up -d
```

**Development:** Presidio in Docker, Bun locally with hot-reload:
```bash
docker compose up presidio -d
bun run dev
```

**Multi-language:** Use EU image or build custom:
```bash
PASTEGUARD_TAG=eu docker compose up -d
LANGUAGES=en,de,ja docker compose up -d --build
```

See @docker/presidio/languages.yaml for 24 available languages.

## Testing

- `GET /health` - Health check
- `GET /info` - Mode info
- `POST /openai/v1/chat/completions` - OpenAI endpoint
- `POST /anthropic/v1/messages` - Anthropic endpoint

Response header `X-PasteGuard-PII-Masked: true` indicates PII was masked.
