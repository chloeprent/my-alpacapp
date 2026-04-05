# Local AI Setup Guide

> For installing local AI tools on any Apple Silicon Mac.
> Alpuca (Mac mini M4 24GB) is already set up — this guide covers both Alpuca and additional machines.

## What's Installed on Alpuca (192.168.1.200)

| Component | Version | Location |
|-----------|---------|----------|
| msty | Latest | `/Applications/msty.app` |
| Ollama | v0.20.0-rc0 | `brew services` (auto-starts on boot) — manually upgraded binary for Gemma 4 support |
| Gemma 4 26B (MoE, Q4) | 17 GB | Primary model — MoE architecture (3.8B active params), 256K context, vision, thinking mode |
| glm-ocr | 2.2 GB | OCR model for document text extraction |

Ollama API: `http://192.168.1.200:11434` (accessible from LAN)

---

## Recommended Setup

| Component | What it does | Install |
|-----------|-------------|---------|
| **Ollama** | Model runner — serves AI models via API | `brew install ollama` |
| **msty** | Beautiful desktop chat UI — connects to Ollama, Claude, OpenAI, etc. | [msty.app](https://msty.app) (free) |

**Why msty over Atomic Chat?** msty has a polished native UI, supports multiple providers (local + cloud), conversation branching, knowledge bases, and prompt templates. Free tier is generous. Atomic Chat still works but msty is the better daily driver.

---

## Recommended Models (March 2026)

| Model | Size | Min RAM | Best for |
|-------|------|---------|----------|
| **Gemma 3 12B (Q4)** | 8.1 GB | 16 GB | General chat, coding, summarization — Google's best small model |
| **Gemma 3 27B (Q4)** | 17 GB | 24 GB | Near-frontier reasoning at local speed — best bang for RAM |
| **Qwen 3.5 9B (Q8)** | 10 GB | 24 GB | Tool-calling, structured output, multilingual (201 languages) |
| **Qwen 3.5 9B (Q4)** | 5.6 GB | 16 GB | Same as above, lighter quantization — good for constrained RAM |
| **Qwen 3 14B (Q4)** | 9.3 GB | 24 GB | Heavy reasoning, math, logic |
| **DeepSeek R1 7B** | 4.7 GB | 16 GB | Chain-of-thought reasoning — shows its work |

### Quick picks

- **16GB MacBook Air**: Gemma 3 12B (Q4) + Qwen 3.5 9B (Q4)
- **24GB+ Mac (like Alpuca)**: Gemma 3 27B (Q4) + Qwen 3.5 9B (Q8)
- **Coding focus**: Qwen 3.5 9B is strongest for structured output and tool use
- **General chat**: Gemma 3 is more natural and conversational

---

## Install on MacBook Air (or any Mac)

### Step 1: Install Ollama

```bash
brew install ollama
brew services start ollama
```

### Step 2: Pull Models

For **16GB RAM** MacBook Air:

```bash
# Primary — Google Gemma 3, excellent general model
ollama pull gemma3:12b

# Secondary — Qwen for coding and structured output
ollama pull qwen3.5:9b
```

For **24GB+ RAM** — match Alpuca's setup:

```bash
# Primary — Gemma 3 27B, near-frontier quality
ollama pull gemma3:27b

# Secondary — higher fidelity quantization
ollama pull qwen3.5:9b-q8_0

# Reasoning model
ollama pull qwen3:14b
```

### Step 3: Install msty

1. Download from [msty.app](https://msty.app) — free, native macOS app
2. Open msty, go to Settings > Providers
3. Add **Ollama** provider — it auto-detects `http://localhost:11434`
4. Your pulled models appear automatically in the model picker

### Step 4: Verify

```bash
ollama list
ollama run gemma3:12b "Hello, what model are you?"
```

---

## Model Comparison: Gemma 3 vs Qwen 3.5

| | Gemma 3 12B | Gemma 3 27B | Qwen 3.5 9B |
|---|---|---|---|
| **Maker** | Google | Google | Alibaba |
| **Conversation** | Natural, fluid | Excellent | Good, more structured |
| **Coding** | Good | Very good | Best at this size |
| **Tool calling** | Basic | Good | Excellent |
| **Multimodal** | Yes (text + image) | Yes (text + image) | Yes (text + image + video) |
| **Languages** | 35+ | 35+ | 201 |
| **Context** | 128K tokens | 128K tokens | 128K tokens |
| **License** | Gemma (permissive) | Gemma (permissive) | Apache 2.0 |

**TL;DR**: Use Gemma 3 for chat and general tasks, Qwen 3.5 for coding and API backends.

---

## Use Cases

### As OpenClaw Backend (Alpuca)
Point OpenClaw edge functions at `http://192.168.1.200:11434/v1/chat/completions` (OpenAI-compatible endpoint). Zero token cost.

### Claude Max Overflow
When you hit your Claude subscription cap, switch to msty with a local model as a fallback.

### Airplane / Offline (MacBook Air)
Works fully offline after model download. Great for language lessons, writing, code review.

### Big File Processing
Feed large docs into the 128K context window for summarization, analysis, extraction.

---

## msty Tips

- **Knowledge Bases**: Drag files/folders into msty to create searchable knowledge bases. Great for codebase Q&A.
- **Prompt Templates**: Save common prompts (code review, summarization, translation) as reusable templates.
- **Provider Switching**: Mid-conversation, switch between local Ollama and cloud providers (Claude, OpenAI) without losing context.
- **Conversation Branching**: Fork a conversation to explore different approaches.

---

## Ollama Useful Commands

```bash
ollama list                     # Show installed models
ollama run gemma3:27b           # Interactive chat (Alpuca)
ollama run gemma3:12b           # Interactive chat (MacBook Air)
ollama run qwen3.5:9b           # Switch to coding model
ollama ps                       # Show loaded models (RAM usage)
ollama stop gemma3:27b          # Unload from RAM
brew services stop ollama       # Stop background service
brew services start ollama      # Start background service
```

## Ollama API Examples

```bash
# Simple completion
curl http://localhost:11434/api/generate -d '{
  "model": "gemma3:12b",
  "prompt": "Explain recursion in one sentence",
  "stream": false
}'

# OpenAI-compatible chat endpoint (for app integrations)
curl http://localhost:11434/v1/chat/completions -d '{
  "model": "gemma3:12b",
  "messages": [{"role": "user", "content": "Hello"}]
}'
```

---

## Network Access (Alpuca as LAN AI Server)

By default, ollama binds to `localhost`. To serve other machines on LAN:

```bash
# Set in ~/.zshrc or launchctl env:
export OLLAMA_HOST=0.0.0.0

# Then restart:
brew services restart ollama
```

After this, any device on the network can use `http://192.168.1.200:11434` as an AI API.

---

*Updated 2026-03-28. msty + Ollama, Gemma 3 + Qwen 3.5 models.*
