# fi

<img src="apps/web/public/fi-logo.png" alt="fi" width="88">

**Your models. Your workspace.**

An all-in-one coding agent for Windows, macOS, and Linux. Sign in with your supported AI subscriptions or connect API providers, then edit code, research the web, and create images in one workspace. A browser app is also available for local development.

[Download v1](https://github.com/OJamals/fi/releases/tag/v1.0.0) · [Get started](#get-started) · [User guide](docs/user/index.md) · [Run from source](#run)

![fi coding demo: connect a ChatGPT subscription, choose a model, build a focus timer, and run its tests](https://raw.githubusercontent.com/OJamals/fi/refs/heads/fi-readme-assets/2026-10-17/fi-coding-demo.gif)

A real ChatGPT/Codex session: connect a subscription, select GPT-6.1-Sol, build a focus timer, and pass all eight tests. Six scenes from one local run on October 17, 2026, condensed into 24 seconds; account-entry screens and waiting time are omitted. The last scene shows the generated app running in a browser. [Watch or download the video](https://github.com/OJamals/fi/raw/refs/heads/fi-readme-assets/2026-10-17/fi-coding-demo.mp4).

## Download

| Platform | v1.0.0 download | Signing |
|---|---|---|
| macOS · Apple Silicon | [DMG](https://github.com/OJamals/fi/releases/download/v1.0.0/fi-1.0.0-mac-arm64.dmg) | Signed and notarized |
| Windows · x64 | [Installer](https://github.com/OJamals/fi/releases/download/v1.0.0/fi-1.0.0-win-x64-unsigned.exe) | Unsigned |
| Linux · x64 | [AppImage](https://github.com/OJamals/fi/releases/download/v1.0.0/fi-1.0.0-linux-x64.AppImage) | Unsigned |

See [release notes and all downloads](https://github.com/OJamals/fi/releases). On macOS, open the DMG and drag fi into Applications. On Windows, run the installer. On Linux, make the AppImage executable and open it.

## Get started

1. Open fi and choose a project folder.
2. Open **Settings → Models**. Sign in with a supported subscription or add an API provider.
3. Select a model for the conversation. Adding a provider alone does not select a model.
4. Describe a task, review requested permissions, and inspect the resulting file changes.

Account access, models, and quotas depend on your provider. Read the [safety guide](docs/SAFETY.md) before granting tools access to local files or commands.

## What you can do

- **Code in your workspace.** Use file tools, terminals, persistent conversations, planning, and subagents.
- **Choose your models.** Connect supported subscription accounts, API keys, or custom providers. See [account setup](packages/fi/client-ui-model-signin/README.md).
- **Research the web.** Choose automatic routing or a search provider in **Plugins → Preferred web search**. Automatic routing uses supported subscription search, with free Bing search otherwise. [Search setup](packages/fi/web-search-preferences/README.md).
- **Create and edit images.** Use configured Codex, Grok, or Antigravity subscription targets. Image tools require an eligible account; they do not silently switch providers or API billing. [Image setup](packages/fi/tool-image-generation/README.md).
- **Work in isolated checkouts.** Managed Git worktrees start from committed HEAD; uncommitted changes are not copied. [Worktrees](packages/api/workspace-controller/README.md#managed-worktrees).
- **Review changes.** Inspect per-turn file changes and restore supported edits. Restore data lasts for the running Host, so keep your own backups. [File review](packages/deliverables/workspace-changes/README.md).
- **Make it yours.** Adjust text, code, and terminal fonts; manage plugins; import supported Claude Code and Codex contributions. Imported MCP servers and hooks start disabled. [Plugin compatibility](packages/extensions/plugin-compat/README.md).

## Updates

Stable desktop builds check published [GitHub Releases](https://github.com/OJamals/fi/releases) for updates. Use **Check for Updates** in the app menu. Preview builds follow prereleases; drafts are ignored.

<a id="run"></a>

## Run from source

Requires Node.js `^22.19.0 || >=24.0.0` and pnpm `11.7.0`.

```sh
git clone https://github.com/OJamals/fi.git
cd fi
pnpm install
pnpm run dev:desktop
```

For the browser app, use `pnpm run dev:web`. Configure a model before sending a message. Source CLI and Web state defaults to `~/.fi`; `dsh` and `DSH_*` remain the runtime configuration interface.

## Development

fi builds on [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness), originally developed by DeepSeek AI, and [Cordis](https://github.com/cordiverse/cordis). It retains their plugin runtime and adds model-account connections, search and image tools, workspace controls, and its own desktop branding and update channel. Optional capabilities depend on the active profile and plugins.

See [development](docs/development.md), [architecture](docs/architecture.md), [desktop packaging](apps/desktop/README.md), and [contributing](.github/CONTRIBUTING.md). Agents follow [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE). [Third-party notices](docs/THIRD_PARTY_NOTICES.md).
