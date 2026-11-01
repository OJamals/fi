<a id="fi"></a>

<div align="center">

<img src="apps/web/public/fi-logo.png" alt="fi" width="88">

# fi

**Your AI subscriptions, together in one coding workspace.**

Sign in with the AI plans you already have (Claude, ChatGPT/Codex, Grok, GitHub Copilot, Cursor, and more) and choose the model for each conversation in one open-source coding app.

[![Latest release](https://img.shields.io/github/v/release/OJamals/fi?label=release)](https://github.com/OJamals/fi/releases/latest) [![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![Platforms](https://img.shields.io/badge/platforms-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)](#download)

[Download](#download) · [Features](#features) · [Providers](#supported-providers) · [Get started](#get-started) · [Run from source](#run-from-source) · [Contribute](.github/CONTRIBUTING.md)

</div>

![fi coding demo: connect a ChatGPT subscription, choose a model, build a focus timer, and run its tests](https://raw.githubusercontent.com/OJamals/fi/refs/heads/fi-readme-assets/2026-10-17/fi-coding-demo.gif)

Connect a ChatGPT subscription, pick a model, then build and test a focus-timer app. The clip is condensed; [watch the full video](https://github.com/OJamals/fi/raw/refs/heads/fi-readme-assets/2026-10-17/fi-coding-demo.mp4).

## Features

- **Every subscription in one picker.** Keep several providers signed in and choose a model per conversation. [API keys and custom endpoints](docs/user/guide/providers.md) sit alongside them.
- **A full coding agent.** File tools, terminals, planning, subagents, and persistent conversations in your own project folder.
- **Review every change.** Inspect each turn's file edits and [restore supported changes](packages/deliverables/workspace-changes/README.md).
- **Isolated worktrees.** Run tasks in [managed Git worktrees](packages/api/workspace-controller/README.md#managed-worktrees) that start from committed `HEAD`.
- **Built-in web search.** Uses your subscription's search when available and free Bing search otherwise. [Choose a provider](packages/fi/web-search-preferences/README.md).
- **Image generation.** Create and edit images with an eligible [Codex, Grok, or Antigravity account](packages/fi/tool-image-generation/README.md).
- **Plugins and MCP.** Add [MCP servers and plugins](packages/mcp/README.md), or [import Claude Code and Codex contributions](packages/extensions/plugin-compat/README.md); imported servers and hooks start disabled.
- **Desktop, web, or CLI.** Desktop apps for macOS, Windows, and Linux with automatic updates; the browser app and headless CLI run from source.

## Supported providers

Connect them in **Settings → Models → Sign in with your subscription**.

| Provider | How you connect |
|---|---|
| Claude, ChatGPT/Codex, Grok | [Subscription sign-in](packages/fi/client-ui-model-signin/README.md) |
| GitHub Copilot, Cursor, Kiro, Cline, Gemini Code Assist | [Browser, device, or account-key sign-in](packages/fi/llm-subscriptions/README.md) |
| Antigravity | [Google account sign-in](packages/fi/llm-antigravity/README.md) |
| OpenCode Console | [Console sign-in](packages/fi/llm-opencode/README.md) |
| Ollama Cloud | [Device approval](packages/fi/llm-ollama/README.md) |

Each provider keeps its own models, credits, and quotas, and a successful sign-in does not guarantee inference access. Gemini Code Assist also needs a configured Google OAuth client and an eligible project.

## Download

| Platform | v1.0.1 download | Signing |
|---|---|---|
| macOS · Apple Silicon | [DMG](https://github.com/OJamals/fi/releases/download/v1.0.1/fi-1.0.1-mac-arm64.dmg) | Signed and notarized |
| Windows · x64 | [Installer](https://github.com/OJamals/fi/releases/download/v1.0.1/fi-1.0.1-win-x64-unsigned.exe) | Unsigned |
| Linux · x64 | [AppImage](https://github.com/OJamals/fi/releases/download/v1.0.1/fi-1.0.1-linux-x64.AppImage) | Unsigned |

On macOS, drag fi from the DMG into Applications. On Linux, make the AppImage executable. Installed apps check [GitHub Releases](https://github.com/OJamals/fi/releases) for updates; use **Check for Updates** in the app menu.

## Get started

1. Open fi and choose a project folder.
2. In **Settings → Models**, sign in with a subscription or add an API provider.
3. Pick a model for the conversation.
4. Describe a task, approve the permissions it requests, and review the file changes.

Read the [safety guide](docs/SAFETY.md) before granting tools access to local files or commands.

<a id="run"></a>

## Run from source

Requires Node.js `^22.19.0 || >=24.0.0` and pnpm `11.7.0`.

```sh
git clone https://github.com/OJamals/fi.git
cd fi
pnpm install
pnpm run dev:desktop
```

Use `pnpm run dev:web` for the browser app. The web app and headless CLI keep state in `~/.fi`; `dsh` and `DSH_*` remain the runtime configuration interface.

## Contributing

Try one task in a small project and [report what worked or failed](https://github.com/OJamals/fi/issues/new?template=bug.md) with your app version, OS, provider, and exact model ID; remove credentials and private content from logs. Code and documentation contributions are welcome: see [contributing](.github/CONTRIBUTING.md), [development](docs/development.md), [architecture](docs/architecture.md), and [desktop packaging](apps/desktop/README.md). Agents follow [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE) · [Third-party notices](docs/THIRD_PARTY_NOTICES.md). fi builds on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), originally developed by DeepSeek AI, and [Cordis](https://github.com/cordiverse/cordis).
