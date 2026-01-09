# Contributing to PasteGuard

Thank you for considering contributing to PasteGuard!

## Development Setup

1. Fork and clone the repository
2. Install dependencies: `bun install`
3. Copy config: `cp config.example.yaml config.yaml`
4. Start Presidio: `docker compose up presidio-analyzer -d`
5. Run dev server: `bun run dev`

## Code Quality

Before submitting a PR, ensure:

```bash
# Type checking passes
bun run typecheck

# Linting and formatting pass
bun run check

# Format code if needed
bun run format
```

## Pull Request Process

1. Create a feature branch from `main`
2. Make your changes
3. Ensure all checks pass
4. Submit a PR with a clear description

## Code Style

- Use TypeScript strict mode
- Follow existing code patterns
- Keep functions focused and small
- Add JSDoc comments for public APIs

## Reporting Issues

When reporting issues, please include:
- Steps to reproduce
- Expected behavior
- Actual behavior
- Environment (Bun version, OS)
