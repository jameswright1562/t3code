# T3 Code

T3 Code is a minimal web GUI for coding agents (currently Codex and Claude, more coming soon).

## Installation

> [!WARNING]
> T3 Code currently supports Codex, Claude, and OpenCode.
> Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`

### Run without installing

```bash
npx t3
```

### Desktop app

Install the latest version of the desktop app from [GitHub Releases](https://github.com/pingdotgg/t3code/releases), or from your favorite package registry:

#### Windows (`winget`)

```bash
winget install T3Tools.T3Code
```

#### macOS (Homebrew)

```bash
brew install --cask t3-code
```

#### Arch Linux (AUR)

```bash
yay -S t3code-bin
```

## Some notes

We are very very early in this project. Expect bugs.

We are not accepting contributions yet.

Observability guide: [docs/observability.md](./docs/observability.md)

## If you REALLY want to contribute still.... read this first

Before local development, prepare the environment and install dependencies:

```bash
# Optional: only needed if you use mise for dev tool management.
mise install
bun install .
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening an issue or PR.

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).

## Experimental macOS orchestration + durable memory fork

Work in progress on a local-first, multi-agent macOS workflow with Claude Code,
Codex, Cursor and custom OpenAI-compatible models. Goals include visible/editable
plans, native subscription efficiency, user-managed MCP servers, and **durable
source-backed memory and context checkpoints**.

- [Architecture and implementation plan](./docs/architecture/LOCAL_MACOS_AGENT_HARNESS.md)
- Initial memory persistence and recovery APIs: [apps/server/src/memory](./apps/server/src/memory)
- Additive SQLite migration: [029_AgentMemory.ts](./apps/server/src/persistence/Migrations/029_AgentMemory.ts)

**Current status:** architecture, schema, foundational repository operations and
tests are checked in on the feature branch. They are **not yet connected to the
running agent coordinator or settings UI**. The fork is behind upstream; integrate
upstream orchestration and Claude quota fixes before using as a primary client.
