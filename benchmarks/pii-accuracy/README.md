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

## Commands

Run against the local detector:

```bash
docker compose --profile dev up detector -d
bun run benchmark:accuracy
```

Run against a deployed PasteGuard API:

```bash
bun run benchmark:accuracy -- --mode api --target-url https://pasteguard.eu --split test
```

Regenerate the synthetic corpus:

```bash
python -m pip install -r benchmarks/pii-accuracy/requirements.txt
python benchmarks/pii-accuracy/generate.py
python benchmarks/pii-accuracy/generate.py --check
```
