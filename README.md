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

**[API Integration](https://pasteguard.com/docs/use-cases/api-integration)** — Sits between your code and OpenAI or Anthropic. Change one URL, your users' data stays protected.

## Quick Start

Run PasteGuard as a local proxy:

```bash
docker run --rm -p 3000:3000 ghcr.io/sgasser/pasteguard:en
```

Point your tools or app to PasteGuard instead of the provider:

| API | PasteGuard URL | Original URL |
|----------|----------------|--------------|
| OpenAI | `http://localhost:3000/openai/v1` | `https://api.openai.com/v1` |
| Anthropic | `http://localhost:3000/anthropic` | `https://api.anthropic.com` |

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

Route Mode sends requests containing sensitive data to a local LLM (Ollama, vLLM, llama.cpp). Everything else goes to OpenAI or Anthropic. Sensitive data stays on your network.

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

**[Coding Tools docs →](https://pasteguard.com/docs/use-cases/coding-tools)**

## Dashboard

Every request is logged with masking details. See what was detected, what was masked, and what reached the provider.

<img src="assets/dashboard.png" width="100%" alt="PasteGuard Dashboard">

[localhost:3000/dashboard](http://localhost:3000/dashboard)

## What it catches

**Personal data** — Names, emails, phone numbers, credit cards, IBANs, IP addresses, locations. Powered by [Microsoft Presidio](https://microsoft.github.io/presidio/). 24 languages.

**Secrets** — API keys (OpenAI, Anthropic, Stripe, AWS, GitHub), SSH and PEM private keys, JWT tokens, bearer tokens, passwords, connection strings.

Both detected and masked in real time, including streaming responses.

## Tech Stack

[Bun](https://bun.sh) · [Hono](https://hono.dev) · [Microsoft Presidio](https://microsoft.github.io/presidio/) · SQLite

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines on how to contribute.

## License

[Apache 2.0](LICENSE)
