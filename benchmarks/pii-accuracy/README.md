# PII accuracy benchmark

This benchmark targets the analyzer `/analyze` endpoint on `http://localhost:3000/analyze` by
default. The request/response contract is the analyzer contract, so the same corpus can also be
pointed at another compatible analyzer endpoint with `--url`.

The corpus only includes entities exposed by Pasteguard's default PII configuration:
`PERSON`, `EMAIL_ADDRESS`, `PHONE_NUMBER`, `CREDIT_CARD`, `IBAN_CODE`, `IP_ADDRESS`, and
`LOCATION`. Cases are not skipped dynamically; if the active runtime cannot analyze a configured
language or entity, the benchmark fails.

The corpus covers the European image language set: `en`, `de`, `es`, `fr`, `it`, `nl`, `pl`,
`pt`, and `ro`.

The runner validates the corpus before applying filters. Unknown YAML fields, unsupported
entities, unsupported languages, unknown suites, duplicate case IDs, and expected strings that do
not occur in the case text fail the run.

## Design

Cases are selected from the product behavior Pasteguard should provide, not from what the current
detector already happens to pass.

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
default. Individual cases can override this with `gate`. Analyzer errors, HTTP errors, and invalid
responses always fail the benchmark run.

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
bun run benchmark:accuracy
```

Useful filters:

```bash
bun run benchmark:accuracy --suite core,precision
bun run benchmark:accuracy --category core,precision
bun run benchmark:accuracy --languages en,de,it,pl,ro
bun run benchmark:accuracy --url http://localhost:3000/analyze --verbose
```
