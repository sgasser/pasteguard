# TODOs

## Deferred runtime privacy trace/debug mode

- What: opt-in debug/trace mode showing privacy pipeline stages for a request/response: secrets detected, PII detected, placeholders inserted, provider response restored, and stream buffers flushed.
- Why: useful for future debugging, but intentionally out of scope for this refactor.
- Context: build on the shared privacy pipeline and stream restorer after this refactor lands. Keep traces opt-in and avoid logging raw sensitive values by default.
- Depends on: shared restoration and provider privacy pipeline refactor.
