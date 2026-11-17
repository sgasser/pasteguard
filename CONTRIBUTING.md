# Contributing to PasteGuard

Thank you for considering contributing to PasteGuard!

## Development Setup

1. Fork and clone the repository
2. Install dependencies: `bun install`
3. Copy config: `cp config.example.yaml config.yaml`
4. Start the detector: `docker compose up detector -d`
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

## Detector Dependencies

The PII detector in `detector/` is a Python project managed with
[uv](https://docs.astral.sh/uv/). `detector/uv.lock` pins every package
version. The Docker image and CI install from it with `uv sync --locked`, so the
versions CI tests are the versions the image ships. Torch comes from the
CPU-only PyTorch index configured in `detector/pyproject.toml`.

Use the uv version that CI and `docker/Dockerfile` pin (currently 0.13.8). To
work on the detector locally (Python 3.11 or later):

```bash
cd detector
uv sync --extra dev
.venv/bin/python -m pytest -q
```

To change a dependency, edit `detector/pyproject.toml`, run `uv lock` in
`detector/`, and commit both files together. CI and the Docker build fail when
`uv.lock` does not match `pyproject.toml`.

To update locked versions within the ranges in `pyproject.toml`:

```bash
cd detector
uv lock --upgrade-package transformers  # one package
uv lock --upgrade                       # every package
```

Then run the detector checks from `.github/workflows/ci.yml` and build the image
with `docker build -f docker/Dockerfile .`.

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
