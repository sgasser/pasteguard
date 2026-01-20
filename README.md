<p align="center">
  <img src="assets/wordmark-light.svg" width="220" height="44" alt="PasteGuard">
</p>

<p align="center">
  <a href="https://github.com/sgasser/pasteguard/actions/workflows/ci.yml"><img src="https://github.com/sgasser/pasteguard/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg" alt="License"></a>
</p>

<p align="center">
  Privacy proxy for LLMs. Masks personal data and secrets before sending prompts to your provider.
</p>

<p align="center">
  <a href="#quick-start"><strong>Quick Start</strong></a> ·
  <a href="https://pasteguard.com/docs"><strong>Documentation</strong></a> ·
  <a href="https://pasteguard.com/docs/integrations"><strong>Integrations</strong></a>
</p>

<br/>

<img src="assets/dashboard.png" width="100%" alt="PasteGuard Dashboard">

## What is PasteGuard?

PasteGuard is a privacy proxy that masks personal data and secrets before sending prompts to LLM providers.

```
You send:  "Email Dr. Sarah Chen at sarah@hospital.org"
LLM sees:  "Email [[PERSON_1]] at [[EMAIL_ADDRESS_1]]"
You get:   Response with original names restored
```

**Two ways to protect your data:**

- **Mask Mode** — Replace PII with placeholders, send to your provider, restore in response. No local infrastructure needed.
- **Route Mode** — Send PII requests to a local LLM (Ollama, vLLM, llama.cpp), everything else to your provider. Data never leaves your network.

Just change one URL to start protecting your data.

## Browser Extension (Beta)

An open source browser extension that brings PasteGuard protection to ChatGPT, Claude, Gemini, Copilot, and Perplexity.

- Paste customer data → PII is masked before it reaches the AI
- You see the original, AI sees `[[PERSON_1]]`, `[[EMAIL_1]]`

Open source (Apache 2.0). Built in public — early feedback shapes the product.

**[Join the Beta →](https://tally.so/r/J9pNLr)**

## Features

- **PII Detection** — Names, emails, phone numbers, credit cards, IBANs, and more
- **Secrets Detection** — API keys, tokens, private keys caught before they reach the LLM
- **Streaming Support** — Real-time unmasking as tokens arrive
- **24 Languages** — English, German, French, and 21 more
- **OpenAI** — Works with OpenAI and compatible APIs (Azure, OpenRouter, Groq, Together AI, etc.)
- **Anthropic** — Native Claude support, works with Claude Code
- **Self-Hosted** — Your servers, your data stays yours
- **Open Source** — Apache 2.0 license
- **Dashboard** — See every protected request in real-time

## Quick Start

```bash
docker run --rm -p 3000:3000 ghcr.io/sgasser/pasteguard:en
```

Point your app to PasteGuard:

| Provider | PasteGuard URL | Original URL |
|----------|----------------|--------------|
| OpenAI | `http://localhost:3000/openai/v1` | `https://api.openai.com/v1` |
| Anthropic | `http://localhost:3000/anthropic` | `https://api.anthropic.com` |

Dashboard: [http://localhost:3000/dashboard](http://localhost:3000/dashboard)

### European Languages

For German, Spanish, French, Italian, Dutch, Polish, Portuguese, and Romanian:

```bash
docker run --rm -p 3000:3000 ghcr.io/sgasser/pasteguard:eu
```

For custom config, persistent logs, or other languages: **[Read the docs →](https://pasteguard.com/docs/installation)**

## Integrations

Works with OpenAI, Anthropic, and compatible tools:

- OpenAI SDK (Python/JS)
- Anthropic SDK / Claude Code
- LangChain
- LlamaIndex
- Cursor
- Open WebUI
- LibreChat

**[See all integrations →](https://pasteguard.com/docs/integrations)**

## What It Detects

**PII** (powered by [Microsoft Presidio](https://microsoft.github.io/presidio/))
- Names
- Emails
- Phone numbers
- Credit cards
- IBANs
- IP addresses
- Locations

**Secrets**
- OpenSSH private keys
- PEM private keys
- OpenAI API keys
- AWS access keys
- GitHub tokens
- JWT tokens
- Bearer tokens

## Tech Stack

[Bun](https://bun.sh) · [Hono](https://hono.dev) · [Microsoft Presidio](https://microsoft.github.io/presidio/) · SQLite

## License

[Apache 2.0](LICENSE)
