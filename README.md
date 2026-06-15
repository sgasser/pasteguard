<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/wordmark-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="assets/wordmark-light.svg">
    <img src="assets/wordmark-light.svg" width="220" height="44" alt="PasteGuard">
  </picture>
</p>

<p align="center">
  <a href="https://github.com/sgasser/pasteguard/actions/workflows/ci.yml"><img src="https://github.com/sgasser/pasteguard/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg" alt="License"></a>
  <a href="https://github.com/sgasser/pasteguard/releases"><img src="https://img.shields.io/github/v/release/sgasser/pasteguard" alt="Release"></a>
</p>

<p align="center">
  <strong>AI gets the context. Not your secrets.</strong><br>
  Automatically hides names, emails, and API keys before you send prompts to AI.
</p>

<p align="center">
  <a href="#quick-start"><strong>Quick Start</strong></a> ·
  <a href="#chat"><strong>Chat</strong></a> ·
  <a href="#coding-tools"><strong>Coding Tools</strong></a> ·
  <a href="https://pasteguard.com/docs"><strong>Documentation</strong></a>
</p>

<br/>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/comparison-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="assets/comparison.png">
  <img src="assets/comparison.png" width="100%" alt="PasteGuard — Without vs. With: masks names, emails, and API keys before they reach AI">
</picture>

<p align="center">
  Detects 30+ types of sensitive data across 24 languages.<br>
  Your data never leaves your machine.
</p>

## Works Everywhere

**[Chat](https://pasteguard.com/docs/use-cases/chat)** — Masks PII and secrets when you paste into ChatGPT, Claude, and Gemini. You see originals, AI sees placeholders.

**[Apps](https://pasteguard.com/docs/use-cases/apps)** — Open WebUI, LibreChat, or any self-hosted AI setup. Optionally routes sensitive requests to a local model.

**[Coding Tools](https://pasteguard.com/docs/use-cases/coding-tools)** — Cursor, Claude Code, Copilot, Windsurf — your codebase context flows to the provider. PasteGuard masks secrets and PII before they leave.

**[API Integration](https://pasteguard.com/docs/use-cases/api-integration)** — Sits between your code and OpenAI-compatible or Anthropic APIs. Change one URL, your users' data stays protected.

## Quick Start

Run PasteGuard as a local proxy:

```bash
docker run --rm -p 3000:3000 ghcr.io/sgasser/pasteguard:en
```

Point your tools or app to PasteGuard instead of the provider:

| Target | PasteGuard URL | Original URL |
|----------|----------------|--------------|
| OpenAI | `http://localhost:3000/openai/v1` | `https://api.openai.com/v1` |
| Anthropic | `http://localhost:3000/anthropic` | `https://api.anthropic.com` |
| Codex CLI | `http://localhost:3000/codex` | `https://chatgpt.com/backend-api/codex` |

```python
# One line to protect your data
client = OpenAI(base_url="http://localhost:3000/openai/v1")
```

<details>
<summary><strong>European Languages</strong></summary>

For German, Spanish, French, Italian, Dutch, Polish, Portuguese, and Romanian:

```bash
docker run --rm -p 3000:3000 ghcr.io/sgasser/pasteguard:eu
```

For custom config, persistent logs, or other languages: **[Read the docs →](https://pasteguard.com/docs/installation)**

</details>

<details>
<summary><strong>Route Mode</strong></summary>

Route Mode sends requests containing sensitive data to a local LLM (Ollama, vLLM, llama.cpp). Everything else goes to the configured cloud provider. Sensitive data stays on your network.

**[Route Mode docs →](https://pasteguard.com/docs/concepts/route-mode)**

</details>

## Chat

Open-source browser extension for ChatGPT, Claude, and Gemini.

- Paste customer data → masked before it reaches the AI
- AI responds with placeholders → you see the originals
- Works with the same detection engine as the proxy

Currently in beta. Apache 2.0.

**[Join the Beta →](https://tally.so/r/J9pNLr)** · **[Chat docs →](https://pasteguard.com/docs/use-cases/chat)**

## Coding Tools

Protect your codebase context and secrets when using AI coding assistants.

**Claude Code:**

```bash
ANTHROPIC_BASE_URL=http://localhost:3000/anthropic claude
```

**Cursor:** Settings → Models → Enable "Override OpenAI Base URL" → `http://localhost:3000/openai/v1`

**Codex CLI:** Configure a custom provider with `base_url = "http://127.0.0.1:3000/codex"`. See the coding tools docs for the full snippet.

**[Coding Tools docs →](https://pasteguard.com/docs/use-cases/coding-tools)**

## Dashboard

Every request is logged with masking details. See what was detected, what was masked, and what reached the provider.

<img src="assets/dashboard.png" width="100%" alt="PasteGuard Dashboard">

[localhost:3000/dashboard](http://localhost:3000/dashboard)

## What it catches

**Personal data** — Names, organizations, addresses, and locations (multilingual), plus emails, phone numbers, credit cards, IBANs, and IP addresses (international). Country-specific national IDs are added on top — currently Italian (Codice Fiscale, Partita IVA) and German (Steuernummer, USt-IdNr), and more can be added. Detection is language-agnostic.

**Secrets** — API keys (OpenAI, Anthropic, Stripe, AWS, GitHub), SSH and PEM private keys, JWT tokens, bearer tokens, passwords, connection strings.

Both detected and masked in real time, including streaming responses.

## PII detection

Detection runs as a small service that speaks the `/analyze` HTTP contract, so it is a drop-in for the `presidio_url` setting (PasteGuard needs no code changes). It combines two layers:

- **Deterministic** — regex candidates gated by checksum/format validation ([`python-stdnum`](https://arthurdejong.org/python-stdnum/), [`python-codicefiscale`](https://github.com/fabiocaccamo/python-codicefiscale), [`phonenumbers`](https://github.com/daviddrysdale/python-phonenumbers)). International by default: IBAN (any country), credit card, email, IP, phone. Plus country-specific national IDs, currently Italian (Codice Fiscale, Partita IVA) and German (Steuernummer, USt-IdNr) — extensible to other countries. Every match is validated, not guessed.
- **Fuzzy** — multilingual [GLiNER](https://github.com/urchade/GLiNER) NER for person, location, organization, and address, in one language-agnostic pass (verified across EN/DE/IT/FR/ES/NL/PT and more). A national ID inside text written in another language is found regardless of the request language.

Source, Docker image, and tests: [`detector/`](detector/). Apache-2.0; bundles GLiNER (Apache-2.0) and the `urchade/gliner_multi_pii-v1` model (Apache-2.0), with `python-stdnum` (LGPL-2.1), `python-codicefiscale` (MIT), and `phonenumbers` (Apache-2.0) as dependencies.

## Tech Stack

[Bun](https://bun.sh) · [Hono](https://hono.dev) · [GLiNER](https://github.com/urchade/GLiNER) + [python-stdnum](https://arthurdejong.org/python-stdnum/) ([`detector/`](detector/)) · SQLite

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines on how to contribute.

## License

[Apache 2.0](LICENSE)
