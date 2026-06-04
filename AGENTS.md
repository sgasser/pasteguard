# PasteGuard Agent Instructions

## Project

PasteGuard is a Bun/Hono privacy proxy for LLMs. It masks PII and secrets before forwarding requests to configured providers, then restores placeholders in responses where supported.

Primary endpoints:

- `POST /openai/v1/chat/completions`
- `POST /anthropic/v1/messages`
- `POST /codex/responses`
- `GET /health`
- `GET /info`

## Stack

- Runtime: Bun
- Web framework: Hono
- Validation: Zod
- Styling: Tailwind CSS v4
- Database: SQLite at `data/pasteguard.db`
- PII detection: Microsoft Presidio
- Formatting/linting: Biome

## Commands

- `bun run dev` - development server
- `bun run start` - production server
- `bun run build` - build to `dist/`
- `bun test` - test suite
- `bun run typecheck` - TypeScript check
- `bun run check` - Biome lint and format check
- `bun run format` - apply Biome formatting for `src/`

## Workflow

- Prefer existing route/provider/extractor patterns over new abstractions.
- Add or update tests when changing masking, provider forwarding, logging, config parsing, or public endpoints.
- Run `bun test`, `bun run typecheck`, and `bun run check` before handing off code changes.
- Update README and docs when public endpoints, provider config, or user setup steps change.
- Do not commit tracked `config.yaml` changes.
- Do not create commits or push branches unless the user explicitly asks.

## Architecture Pointers

- `src/index.ts` mounts routes and prints startup provider info.
- `src/config.ts` owns YAML config loading and defaults.
- `src/routes/` contains HTTP route handlers.
- `src/providers/` contains provider clients and stream transformers.
- `src/masking/extractors/` contains provider-specific text extraction and insertion.
- `src/services/logger.ts` owns SQLite dashboard logging.
- `docs/mint.json` registers API reference docs.
