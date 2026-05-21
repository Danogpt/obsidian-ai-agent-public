# Obsidian AI Agent

A right-sidebar AI agent for Obsidian with deep vault integration. Supports Anthropic Claude, OpenAI GPT, Google Gemini, and local Ollama models.

## Features

- **Vault-aware context** — the agent reads your active note, backlinks, forward links, and searches relevant vault content before answering
- **Hybrid retrieval** — BM25F + semantic sketches + graph-rank fused with RRF; optional API embeddings (OpenAI / Gemini / Ollama)
- **Smart editing** — tolerant patch-file matcher (handles whitespace, smart quotes, NBSPs); provider-specific diff formats (XML, SEARCH/REPLACE, fenced diff)
- **Plan-before-execute** — complex tasks get a JSON plan with per-step status; simple tasks run direct ReAct
- **Working memory** — structured goal/decisions/artifacts/next-steps persisted across conversation turns
- **Style profiles** — vault purpose × writing style × task profile injected into every prompt
- **Rate-limit aware** — learned token-per-minute tracking, automatic context reduction on 429/overflow
- **Desktop only** (`isDesktopOnly: true`), no heavy native dependencies

## Supported Providers

| Provider  | Models                              |
|-----------|-------------------------------------|
| Anthropic | Claude 4 Opus/Sonnet, Claude 3.5    |
| OpenAI    | GPT-5.5, GPT-4o, o3, o4-mini       |
| Gemini    | 2.5 Pro/Flash, 2.0 Flash            |
| Ollama    | any locally running model            |

## Installation

1. Build the plugin: `cd plugin && npm install && npm run build`
2. Copy `main.js`, `manifest.json`, and `styles.css` to your vault's `.obsidian/plugins/obsidian-ai-agent/`
3. Enable the plugin in Obsidian → Settings → Community Plugins
4. Add your API key(s) in the plugin settings

## Development

```bash
cd plugin
npm install
npm run dev      # watch + rebuild
npm run build    # tsc type-check + production bundle
npm run lint     # eslint
npm test         # vitest unit tests
```

## Configuration

All settings live in **Settings → AI Agent**:

| Setting | Description |
|---------|-------------|
| API Keys | OpenAI, Anthropic, Gemini; Ollama base URL |
| Model | Select from supported models or add a custom model |
| Agent mode | `suggest` (confirm writes) or `auto` (write directly) |
| Vault purpose | student / research / coding / business / … — shapes prompt style |
| Writing style | neutral / concise / formal / academic / … |
| Embedding backend | `local` (hash-sketch), `openai`, `gemini`, or `ollama` |
| LLM rerank | Enable cross-encoder reranking for vault research queries |

## Context Modes

Switch context mode via the toolbar in the agent panel:

- **Active file** — uses the currently open note as primary context
- **Selected text** — uses the editor selection
- **Manual files** — pin specific files
- **Folder** — loads all notes from a chosen folder
- **Vault** — full vault index (for broad research tasks)
- **None** — no file context

## Architecture

```text
src/
├── main.ts                  # Plugin lifecycle
├── settings.ts              # Settings UI wiring
├── settingsTypes.ts         # Settings types and defaults
├── agent/                   # Prompts, planner, post-check, shared types
├── chat/                    # Thread/message persistence
├── client/                  # Backward-compatible client exports
├── context/                 # Intent-aware context assembly + working memory
├── limits/                  # Token budgeting and rate-limit state
├── models/                  # Built-in/custom model registry
├── providers/               # OpenAI / Anthropic / Gemini / Ollama adapters
├── retrieval/               # Vault index, chunking, ranking, embeddings
├── templates/               # File templates
├── tools/                   # Vault/file tools exposed to the agent
├── views/                   # Sidebar UI and loop guards
└── __tests__/               # Vitest unit tests
```

## Release

1. Update `manifest.json` version and `minAppVersion`
2. Run `npm run version` (bumps `package.json` and `versions.json`)
3. Create a GitHub release with tag = version number
4. Attach `main.js`, `manifest.json`, `styles.css` as release assets
