# Claude Code Replica

A local AI coding assistant that replicates Claude Code's agentic workflow,
supporting third-party LLM APIs (OpenAI, DeepSeek, Qwen, etc.).

## Project Overview

This project implements a complete CLI-based AI coding assistant based on
reverse-engineered Claude Code architecture. It uses a provider-agnostic
design — any OpenAI-compatible API can be the backend.

## Architecture

```
CLI Entry --> Config/API Client --> System Prompt Builder --> Agent Loop --> Tools
                                      |                           |
                                (6 sections)           (query --> LLM --> tools --> loop)
```

## Key Design Decisions

1. **Tools over Bash** — Prefer dedicated tools (Read/Edit/Write/Glob/Grep) over raw shell commands
2. **Edit never rewrite** — Use precise search/replace editing
3. **Parallel independent calls** — Mutually independent tool calls execute concurrently
4. **Read-only auto-approval** — Glob, Grep, Read don't need user confirmation
5. **Context compression is essential** — Long conversations must auto-compress
6. **Tiered permissions** — Risk-level-based approval, not binary yes/no
7. **CLAUDE.md as project memory** — This file serves as persistent context

## Reference Material

- `reference/` — Claude Code decompiled source (reference implementation, gitignored)
- `Claude Code 源码架构深度分析.pdf` — architecture analysis (gitignored, kept at repo root)
- `docs/` — project documentation
  - `快速开始.md` — install / config / run / smoke-test flow
  - `项目总览.md` — architecture, module list, completion status
  - `项目评审报告.md` — source-level review with findings & fixes
  - `archive/` — historical ROADMAPs, changelogs, comparison tables (numbers may be stale)

## Implementation Phases

### Phase 1: MVP ✅
- CLI entry with argument parsing (commander)
- LLM client abstraction (OpenAI-compatible API)
- System prompt builder (6 sections)
- 3 core tools: Bash, Read, Write
- Basic agent loop (no compression)

### Phase 2: Enhanced Tools
- Edit tool (search/replace pattern)
- Glob tool (filename pattern matching)
- Grep tool (content search via ripgrep)
- Permission system (4 modes)

### Phase 3: Experience
- Context auto-compaction
- Todo tool, Task tool (sub-agents)
- WebFetch, WebSearch tools
- MCP support
- Conversation persistence

## Getting Started

```bash
# Install dependencies
npm install

# Set up your API key
cp .env.example .env
# Edit .env with your provider and API key

# Run the assistant
npm start
```

## Configuration

- `.env` — API keys and provider selection
- `.mcp.json` — MCP server configurations (optional)
- `.claude/settings.json` — Project-level Claude Code settings
