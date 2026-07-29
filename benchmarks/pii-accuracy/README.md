# PII accuracy benchmark

This benchmark targets the analyzer `/analyze` endpoint on `http://localhost:3000/analyze` by
default. The request/response contract is the analyzer contract, so the same corpus can also be
pointed at another compatible analyzer endpoint with `--url`.

The corpus includes all entities exposed by Pasteguard's default PII configuration:
`PERSON`, `LOCATION`, `EMAIL_ADDRESS`, `PHONE_NUMBER`, `CREDIT_CARD`, `IBAN_CODE`, `IP_ADDRESS`,
`VAT_CODE`, `URL`, `DATE_TIME`, `ACCOUNT_NUMBER`, and `SECRET`.

The shared corpus runs against both semantic backends. GLiNER is the multilingual default. OpenAI
Privacy Filter is primarily English and adds the last four entity types above. Cases and individual
expected spans can declare their applicable `backends`; `gating_backends` changes whether a result
blocks a run without hiding it from the report.

The runner validates the corpus before applying filters. Unknown YAML fields, unsupported
entities, unsupported languages, unknown suites, duplicate case IDs, and expected strings that do
not occur in the case text fail the run.

## Design

Cases are selected from the product behavior Pasteguard should provide, not from what the current
detector already happens to pass.

Expected spans are shared ground truth. Do not create separate expected output for each model or
change expectations after seeing model output. Use `backends` only when a product capability is
intentionally backend-specific.

- `core` covers the minimum detection promise for configured entities. These are gating tests.
- `precision` covers the minimum false-positive promise for configured entities. These are gating
  tests.
- `eval` contains realistic multilingual workflow cases for quality tracking.
- `hard` contains difficult, ambiguous, or aspirational cases for configured entities.

Additional suites make the benchmark easier to read by intent:

- `multilingual-sentences` checks every configured entity in sentence form across all supported
  languages.
- `multilingual-paragraphs` checks every configured entity inside realistic multi-sentence
  workflow text across all supported languages.
- `boundaries` checks whether spans stop cleanly around punctuation, brackets, and quotes.
- `precision-paragraphs` checks longer negative controls with operational lookalike strings.

`core` and `precision` cases are gating by default. `eval` and `hard` cases are report-only by
default. Individual cases can override this with `gate`, or select `gating_backends` when the
product promise differs by backend. Analyzer errors, HTTP errors, and invalid responses always fail
the benchmark run.

Backend-specific expectations stay inside the same case:

```yaml
expected:
  - entity: PERSON
    text: Morgan Lee
  - entity: SECRET
    text: cobalt-river-seven
    backends: [openai_privacy_filter]
```

Match modes:

- `exact` requires the normalized detected text to equal the expected text.
- `contains` requires the detected span to fully cover the expected text with at most two extra
  characters on either side.
- `overlap` is reserved for deliberately loose edge cases where any span overlap is meaningful.

## Sources

- GDPR Article 4 definition of personal data:
  https://eur-lex.europa.eu/eli/reg/2016/679/oj

## Run

```bash
bun run benchmark:accuracy --backend gliner
bun run benchmark:accuracy --backend openai_privacy_filter
```

The runner checks `/health` before sending cases and fails if the active backend differs from
`--backend`. `gliner` is the default.

Validate the full corpus without loading or calling a model:

```bash
bun run benchmark:accuracy --backend gliner --validate
bun run benchmark:accuracy --backend openai_privacy_filter --validate
```

Write and review expected spans before the first model run. If calibration is needed, use only
`split: dev`; keep `split: test` frozen.

Useful filters:

```bash
bun run benchmark:accuracy --suite core,precision
bun run benchmark:accuracy --category core,precision
bun run benchmark:accuracy --languages en,de,it,pl,ro
bun run benchmark:accuracy --backend openai_privacy_filter --split dev
bun run benchmark:accuracy --url http://localhost:3000/analyze --verbose
```
