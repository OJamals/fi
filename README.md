# fi

English | [中文](README.zh.md)

<img src="apps/web/public/fi-logo.png" alt="fi" width="88">

**Your models. Your workspace.**

fi is a prerelease coding agent application built on [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) and [Cordis](https://github.com/cordiverse/cordis). Use it to work on local projects, connect model subscriptions or API providers, research with your chosen search engine, and generate images alongside code. It runs in a native desktop shell or a browser connected to the local runtime.

![fi feature overview: connect model providers, research, create images, and build on DeepSeek Harness and Cordis](docs/assets/fi/feature-overview.png)

Conceptual feature graphic; not an application screenshot. Provider and model access depend on your account.

## DSH foundation, fi additions

fi retains DSH's plugin-based agent runtime: persistent sessions, file and shell tools, terminals, skills, MCP, subagents, planning, background jobs, and permission controls. Optional bundles include browser/computer use, voice input, agent teams, and scheduled tasks; availability depends on the selected profile and enabled plugins. These capabilities come from the DSH foundation, rather than being exclusive fi features. See the [user guide](docs/user/index.md) and [architecture](docs/architecture.md).

The fi layer adds account connections, provider-aware defaults, search and image tools, and a desktop experience with its own branding and update channel. It also incorporates selected upstream improvements; the comparison below describes this fork's capabilities, not a claim that current upstream DSH lacks them.

| Capability | What fi adds or adapts | Benefit |
|---|---|---|
| Model connections | A unified subscription sign-in section, provider setup, live model discovery where supported, and API-key/custom-provider configuration | Choose a provider without a mandatory DeepSeek-account welcome step |
| Native adapters | Antigravity, OpenCode Console, and Ollama Cloud alongside Claude, Codex, and Grok subscription integration | Use eligible existing accounts through the app |
| Search selection | Automatic routing, free Bing search, subscription search, and configurable API search providers | Choose how the agent researches independently of its coding tools |
| Image creation | Subscription-backed text-to-image and editing of workspace images | Create visual assets in the same project workflow |
| Isolated coding | Application-managed local Git worktrees created from committed HEAD | Give a task its own branch and checkout |
| File review | Per-turn changed-file comparisons with guarded before/after restoration | Undo or redo a file change while refusing to overwrite later edits |
| Plugin reuse | Explicit import of supported local Claude Code and Codex plugin contributions | Reuse skills, MCP servers, and hooks with separate enablement controls |
| Daily navigation | Back/forward controls, workspace/session menus, English-first onboarding, and macOS title-bar integration | Move between projects and app panels with less friction |
| Reading and configuration | Independent text/code/terminal fonts and sizes, work-detail controls, organized model selection, and plugin management | Tune the interface and inspect the tools active in your profile |

Worktrees do not copy uncommitted source changes. File comparisons and restore data are Host-lifetime state, not a permanent backup. Plugin compatibility must be enabled in the profile and supports a subset of Claude Code and Codex features; imported MCP servers and hooks start disabled. Details: [worktrees](packages/api/workspace-controller/README.md#managed-worktrees), [file review](packages/deliverables/workspace-changes/README.md), and [plugin compatibility](packages/extensions/plugin-compat/README.md).

## Connect your models

Open **Settings → Models** to add an API provider or use **Sign in with your subscription**. The committed fi integration includes Anthropic, OpenAI Codex, xAI, Antigravity, OpenCode Console, and Ollama Cloud. Sign in, add the provider, then select a model; the provider selector alone does not change the conversation model.

Ollama Cloud uses native device approval and does not require a local Ollama daemon. Antigravity requires an eligible account and an OAuth client from a local installation or explicit configuration. Model lists, account entitlements, quotas, and provider availability vary. A subscription login does not guarantee access to every model or feature. See [sign-in controls](packages/fi/client-ui-model-signin/README.md), [Antigravity](packages/fi/llm-antigravity/README.md), [OpenCode Console](packages/fi/llm-opencode/README.md), and [Ollama Cloud](packages/fi/llm-ollama/README.md).

The source also includes native integrations for GitHub Copilot, Cursor, Kiro, Cline Free / Pass, and Gemini Code Assist. They expose text and function tools with provider-specific limits; Cline requires an account API key, and Google Code Assist requires the appropriate entitlement. Their presence in the UI is not evidence of successful account access or inclusion in a published release.

## Research and create

In **Plugins → Preferred web search**, automatic routing uses native search for a supported linked subscription chat and free Bing search otherwise. Choose Bing, subscription search, DeepSeek official, Exa, Perplexity, Parallel, Tavily, Serper, or Brave Search explicitly when needed. API search providers require their own configured credentials. See [search routing](packages/fi/web-search-preferences/README.md).

The `image_gen` tool generates an image from a prompt or edits readable workspace images through configured Codex, Grok, or Antigravity targets. It requires the selected provider's subscription credentials and does not silently switch to API-key billing or another provider. Claude conversations need one of those image targets configured. See [image generation](packages/fi/tool-image-generation/README.md).

![fi preferred web search panel with automatic routing selected](docs/assets/fi/preferred-search.jpg)

Local source-build screenshot with fresh state; no provider account or inference request is shown.

<a id="run"></a>

## Run from source

Requires Node.js `^22.19.0 || >=24.0.0` and pnpm `11.7.0`.

```sh
git clone https://github.com/OJamals/fi.git
cd fi
pnpm install
pnpm run dev:desktop
```

For the browser app, run `pnpm run dev:web`. Configure a model before sending your first message. The fi CLI and Web use `~/.fi` by default; the `dsh` command and `DSH_*` settings remain the runtime's configuration interface.

Use `pnpm run build:official` for an official Web build. Desktop packaging targets include macOS and Windows; packaging, signing, and release commands are documented in [`apps/desktop`](apps/desktop/README.md).

## Updates

Production desktop builds read signed update metadata from published [fi GitHub Releases](https://github.com/OJamals/fi/releases). Preview builds follow preview prereleases; stable builds follow stable releases. Draft releases are ignored.

## Project status

This README describes source capabilities. The source package version is `0.2.0-rc.2`; desktop releases have their own versions and may contain fewer features. Choose an available build and read its notes in [fi Releases](https://github.com/OJamals/fi/releases). Local unsigned builds are not signed or notarized release artifacts.

fi is prerelease software. Expect breaking changes. Read [SAFETY.md](SAFETY.md) before use. DeepSeek AI originally developed DeepSeek Harness; fi preserves that attribution and the underlying DSH package and CLI names.

## Development

See [development](docs/development.md), [architecture](docs/architecture.md), and [contributing](CONTRIBUTING.md) docs.

`pnpm run dev:web` builds, serves, and rebuilds client bundles on source edits in one terminal, and `make help` lists the matching Make targets for Web and Desktop; the guide's application commands section owns the full table.

For agents, follow [AGENTS.md](AGENTS.md).

Brand assets: [default fi logo](apps/desktop/build/fi-logo-source.png) and [transparent white variant for dark backgrounds](apps/desktop/build/fi-logo-dark-background.png).

## License

[MIT](LICENSE). Third-party licenses: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
