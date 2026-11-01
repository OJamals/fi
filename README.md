<a id="fi"></a>

# fi: an open-source AI coding workspace

<img src="apps/web/public/fi-logo.png" alt="fi" width="88">

**Your AI subscriptions, together in one coding workspace.**

Connect subscriptions and accounts from multiple supported AI providers in fi, then choose a model for each conversation. Use local project files, terminal tools, and file-change review from the same workspace. API keys and custom endpoints can sit alongside your connected accounts.

The desktop app runs on Windows, macOS, and Linux. A browser app and headless CLI are available from source. fi builds on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), originally developed by DeepSeek AI, and [Cordis](https://github.com/cordiverse/cordis).

[Download desktop](#download) · [Get started](#get-started) · [Watch the demo](#see-fi-in-action) · [Run from source](#run-from-source) · [Contribute](.github/CONTRIBUTING.md)

## See fi in action

![fi coding demo: connect a ChatGPT subscription, choose a model, build a focus timer, and run its tests](https://raw.githubusercontent.com/OJamals/fi/refs/heads/fi-readme-assets/2026-10-17/fi-coding-demo.gif)

A recorded ChatGPT/Codex coding session: connect a subscription, choose a model, build a focus timer, and test the generated app. The clip condenses a longer session and omits account-entry screens and waiting time. [Watch or download the video](https://github.com/OJamals/fi/raw/refs/heads/fi-readme-assets/2026-10-17/fi-coding-demo.mp4).

## What you can do

- **Code in your workspace.** Use file tools, terminals, persistent conversations, planning, and subagents.
- **Connect providers together.** Keep several providers signed in and choose a model per conversation. See the [supported account list](#model-connections) and [account setup](packages/fi/client-ui-model-signin/README.md).
- **Research the web.** Choose automatic routing or a search provider in **Plugins → Preferred web search**. Automatic routing uses supported subscription search, with free Bing search otherwise. [Search setup](packages/fi/web-search-preferences/README.md).
- **Create and edit images.** Use configured Codex, Grok, or Antigravity subscription targets. Image tools require an eligible account; they do not silently switch providers or API billing. [Image setup](packages/fi/tool-image-generation/README.md).
- **Work in isolated checkouts.** Managed Git worktrees start from committed HEAD; uncommitted changes are not copied. [Worktrees](packages/api/workspace-controller/README.md#managed-worktrees).
- **Review changes.** Inspect per-turn file changes and restore supported edits. Restore data lasts for the running Host, so keep your own backups. [File review](packages/deliverables/workspace-changes/README.md).
- **Make it yours.** Adjust text, code, and terminal fonts; configure [plugins and MCP servers](packages/mcp/README.md); import supported Claude Code and Codex contributions. Imported MCP servers and hooks start disabled. [Plugin compatibility](packages/extensions/plugin-compat/README.md).

## Download

The published desktop installers below are **v1.0.0**. [Build from source](#run-from-source) to use the current `main` branch.

| Platform | v1.0.0 download | Signing |
|---|---|---|
| macOS · Apple Silicon | [DMG](https://github.com/OJamals/fi/releases/download/v1.0.0/fi-1.0.0-mac-arm64.dmg) | Signed and notarized |
| Windows · x64 | [Installer](https://github.com/OJamals/fi/releases/download/v1.0.0/fi-1.0.0-win-x64-unsigned.exe) | Unsigned |
| Linux · x64 | [AppImage](https://github.com/OJamals/fi/releases/download/v1.0.0/fi-1.0.0-linux-x64.AppImage) | Unsigned |

See [release notes and all downloads](https://github.com/OJamals/fi/releases). On macOS, open the DMG and drag fi into Applications. On Windows, run the installer. On Linux, make the AppImage executable and open it.

## Get started

1. Open fi and choose a project folder.
2. Open **Settings → Models**. Sign in with a supported subscription or add an API provider.
3. Select a model for the conversation.
4. Describe a task, review requested permissions, and inspect the resulting file changes.

Account access, models, and quotas depend on your provider. Read the [safety guide](docs/SAFETY.md) before granting tools access to local files or commands.

## Model connections

### Use multiple subscriptions together

Open **Settings → Models → Sign in with your subscription** and connect each supported provider you want to use. Complete its provider setup so its available models appear in the conversation model picker's **Subscriptions** section. Keep several providers connected, then choose which provider's model handles each conversation. You can switch to another connected model for later requests.

For example, keep ChatGPT/Codex and Claude connected and select either provider’s models for each task from the same picker. Each provider retains its own account access, credits, model availability, and quotas.

### Supported subscription and account providers

The selector offers these routes when their adapters are enabled. Some use subscription sign-in, while others use provider credits, device approval, or an account key.

| Provider/account | Setup and access notes |
|---|---|
| Claude (Anthropic) | [Subscription sign-in](packages/fi/client-ui-model-signin/README.md) |
| ChatGPT / Codex (OpenAI) | [Subscription sign-in](packages/fi/client-ui-model-signin/README.md) |
| Grok (xAI) | [Subscription sign-in](packages/fi/client-ui-model-signin/README.md) |
| Antigravity | [Antigravity account setup](packages/fi/llm-antigravity/README.md) |
| OpenCode Console | [Console sign-in, account balance, and free-tier limits](packages/fi/llm-opencode/README.md) |
| Ollama Cloud | [Cloud account and device approval](packages/fi/llm-ollama/README.md) |
| GitHub Copilot | [Copilot account setup](packages/fi/llm-subscriptions/README.md) |
| Cursor | [Cursor browser sign-in](packages/fi/llm-subscriptions/README.md) |
| Kiro | [Kiro device sign-in](packages/fi/llm-subscriptions/README.md) |
| Cline Free / Pass | [Cline account-key setup](packages/fi/llm-subscriptions/README.md) |
| Gemini Code Assist / Gemini CLI | [Configured Google OAuth client and eligible Code Assist account/project required](packages/fi/llm-subscriptions/README.md) |

A successful sign-in or model listing does not establish inference access. Provider eligibility, policies, billing, and quotas apply. [Account setup](packages/fi/client-ui-model-signin/README.md) covers the shared workflow.

### API keys and custom endpoints

Use **Settings → Models → Add model provider** to configure API-key providers or custom endpoints alongside subscription connections. See the [provider guide](docs/user/guide/providers.md).

## Updates

Stable desktop builds check published [GitHub Releases](https://github.com/OJamals/fi/releases) for updates. Use **Check for Updates** in the app menu. Preview builds follow prereleases; drafts are ignored.

## Help improve fi

Try one task in a small project and [report what worked or failed](https://github.com/OJamals/fi/issues/new?template=bug.md). Include your app version, operating system, provider, and exact model ID. Remove credentials and private project content from logs. Code, documentation, and reproducible bug reports are welcome; see [contributing](.github/CONTRIBUTING.md).

<a id="run"></a>

## Run from source

Requires Node.js `^22.19.0 || >=24.0.0` and pnpm `11.7.0`.

```sh
git clone https://github.com/OJamals/fi.git
cd fi
pnpm install
pnpm run dev:desktop
```

For the browser app, use `pnpm run dev:web`. Configure a model before sending a message. State for the headless CLI and Web app defaults to `~/.fi`; `dsh` and `DSH_*` remain the runtime configuration interface.

## Development

The plugin runtime supports model accounts, tools, workspace controls, and UI contributions. Optional capabilities depend on the active profile and plugins.

See [development](docs/development.md), [architecture](docs/architecture.md), [desktop packaging](apps/desktop/README.md), and [contributing](.github/CONTRIBUTING.md). Agents follow [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE). [Third-party notices](docs/THIRD_PARTY_NOTICES.md).
