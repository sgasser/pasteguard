# PII Accuracy Benchmark

This benchmark measures PII detector quality, not page speed. It reports
precision, recall, F1, and F2. F2 is the headline metric because missed PII is
worse than over-masking for PasteGuard.

## Case Types

- `core` cases are regression guards. Any miss or false positive fails the run.
- `hard` cases probe edge cases and known limits. They are reported but do not
  fail the run.
- `eval` cases are generated synthetic coverage for stable trend metrics. They
  are reported but do not fail the run.

Use `split: dev` for threshold tuning and `split: test` for held-out reporting.

## Profiles

- `published` measures the capabilities advertised by the running PasteGuard
  app. In API mode, the runner reads `/info` and skips cases for unsupported
  entity types or languages. This is the default for `--mode api`.
- `extended` measures the full detector-development corpus, including entity
  types that may not be enabled in the published Docker image yet. This is the
  default for `--mode detector`.
- `all` forces every loaded case into the score. Use it only when debugging a
  capability mismatch.

This keeps the headline score honest: unsupported future coverage is reported
as out of scope instead of being counted as a product regression.

## Commands

Run against the local detector:

```bash
docker compose --profile dev up detector -d
bun run benchmark:accuracy
```

Run against the PasteGuard Docker container exposed on port 3000:

```bash
bun run benchmark:accuracy -- --mode api --target-url http://localhost:3000 --profile published --split test
```

Run the full detector-development corpus:

```bash
bun run benchmark:accuracy -- --mode detector --profile extended --split test
```

Regenerate the synthetic corpus:

```bash
python -m pip install -r benchmarks/pii-accuracy/requirements.txt
python benchmarks/pii-accuracy/generate.py
python benchmarks/pii-accuracy/generate.py --check
```
