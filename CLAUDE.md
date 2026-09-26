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
  - `架构分析与升级总纲-202609.md` — 2026-09 全景架构审查存档（宏观架构、
    Top10 重大问题、分部升级建议、中长期演进方向）；规划任何架构分部工作前
    先读此文件，再按附录 A 指引读 `架构审查-202609/` 下对应分册（01 核心
    引擎 / 02 LLM接入 / 03 工具系统 / 04 权限安全 / 05 TUI / 06 持久化扩展，
    含行号级证据；行号基于 v1.5.0，编辑后会漂移需 grep 重新锚定）。
    **Top10 已于 2026-09-26 全部处置完毕**（修复或经用户拍板决策保留，
    逐项状态与决策记录见总纲 §五 表格后的"修复状态标注"；#2 磁盘模板
    全部可信、#7 沙箱 best-effort 仅告警、#1 插件 MCP 免门属有意决策，
    勿再当 bug 修）
  - `architecture/` — Claude Code internals analysis (tool-call flow, agent
    loop & extended thinking, terminal status UI; with source line refs)
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
- `.claude/mcp.json` — MCP server configurations (optional; project-level
  configs pass a one-time fingerprint trust confirmation before spawn)
- `.claude/settings.json` — Project-level Claude Code settings
