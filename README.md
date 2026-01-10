<p align="center">
  <img src="assets/wordmark-light.svg" width="220" height="44" alt="PasteGuard">
</p>

<p align="center">
  <a href="https://github.com/sgasser/pasteguard/actions/workflows/ci.yml"><img src="https://github.com/sgasser/pasteguard/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg" alt="License"></a>
</p>

<p align="center">
  Privacy proxy for LLMs. Masks personal data and secrets before sending to your provider.
</p>

<p align="center">
  <a href="#quick-start"><strong>Quick Start</strong></a> ·
  <a href="https://pasteguard.com/docs"><strong>Documentation</strong></a> ·
  <a href="https://pasteguard.com/docs/integrations"><strong>Integrations</strong></a>
</p>

<br/>

<p align="center">
  <img src="assets/demo.gif" width="720" alt="PasteGuard Demo">
</p>
<p align="center">
  <em>Your App → PasteGuard → OpenAI — PII never reaches external servers</em>
</p>

<br/>

## What is PasteGuard?

When you use LLM APIs, every prompt is sent to external servers — including customer names, emails, and sensitive business data. Many organizations have policies against sending PII to third-party AI services.

PasteGuard is an OpenAI-compatible proxy that sits between your app and the LLM API. It detects personal data and secrets before they leave your network.

**Two ways to protect your data:**

- **Mask Mode** — Replace PII with placeholders, send to your provider, restore in response. No local infrastructure needed.
- **Route Mode** — Send PII requests to a local LLM (Ollama, vLLM, llama.cpp), everything else to your provider. Data never leaves your network.

Works with OpenAI, Azure, and any OpenAI-compatible API. Just change one URL.

## Features

- **PII Detection** — Names, emails, phone numbers, credit cards, IBANs, and more
- **Secrets Detection** — API keys, tokens, private keys caught before they reach the LLM
- **Streaming Support** — Real-time unmasking as tokens arrive
- **24 Languages** — Works in English, German, French, and 21 more
- **OpenAI-Compatible** — Change one URL, keep your code
- **Self-Hosted** — Your servers, your data stays yours
- **Open Source** — Apache 2.0 license, full transparency
- **Dashboard** — See every protected request in real-time

## How It Works

```
You send:     "Write a follow-up email to Dr. Sarah Chen (sarah.chen@hospital.org)
               about next week's project meeting"

LLM receives: "Write a follow-up email to <PERSON_1> (<EMAIL_ADDRESS_1>)
               about next week's project meeting"

LLM responds: "Dear <PERSON_1>, Following up on our discussion..."

You receive:  "Dear Dr. Sarah Chen, Following up on our discussion..."
```

PasteGuard sits between your app and the LLM provider. It's OpenAI-compatible — just change the base URL.

## Quick Start

```bash
git clone https://github.com/sgasser/pasteguard.git
cd pasteguard
cp config.example.yaml config.yaml
docker compose up -d
```

Point your app to `http://localhost:3000/openai/v1` instead of `https://api.openai.com/v1`.

Dashboard: [http://localhost:3000/dashboard](http://localhost:3000/dashboard)

<img src="assets/dashboard.png" width="100%" alt="PasteGuard Dashboard">
<p><em>Every request logged with masked content preview</em></p>

For multiple languages, configuration options, and more: **[Read the docs →](https://pasteguard.com/docs/quickstart)**

## Integrations

Works with any OpenAI-compatible tool:

- OpenAI SDK (Python/JS)
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
- Env passwords
- Env secrets
- Connection strings

## Tech Stack

[Bun](https://bun.sh) · [Hono](https://hono.dev) · [Microsoft Presidio](https://microsoft.github.io/presidio/) · SQLite

## License

[Apache 2.0](LICENSE)
