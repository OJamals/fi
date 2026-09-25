# Agent Note: Preferred web-search routing

Status: implemented

English | [中文](2026-09-13-preferred-web-search-routing.zh.md)

## Problem

The base profile selects one web-search provider when `WebRuntime` starts. A settings write cannot replace that immutable selection. Users need to choose DeepSeek, Exa, Perplexity, Parallel, Tavily, Serper, Brave Search, or subscription-native search and manage direct-provider keys without changing the model-facing tool, duplicating OAuth, or carrying an FI patch through upstream web packages.

## Decision

`@fi/web-search-preferences` registers one stable `fi-preferred-search` provider. The FI authorization bundle replaces only the base `web` row's complete configuration, preserving `fetchProvider: http`, and disables the separately mounted base DeepSeek provider. FI Desktop lists the bundle after the upstream base and Web bundles; the public dsh package remains independent of FI. The FI router owns the existing `web-search-deepseek` settings namespace and intersects the upstream DeepSeek `Config` schema with FI fields, retaining its defaults, field names, and literal-key behavior. The upstream base bundle and provider packages remain unchanged; removing the FI layer restores `deepseek-official` against the same stored settings.

Provider construction remains in the Host-only package. `@fi/client-ui-web-search-preferences` owns the browser card as a separate client plugin. It shadows the shipped `web-search-deepseek` card at priority `-1`. The configurable-card directory reads the keyed slot's elected entries, so the replacement produces one namespace dispatch instead of duplicate cards. This generic slot-election correction is the only shared upstream-package change. The split keeps provider implementations out of a client bundle and avoids any exception to the upstream Host dependency policy.

The stable provider snapshots the settings section before asynchronous credential or authorization resolution. It then constructs the selected upstream `DeepSeekSearchProvider`, `ExaSearchProvider`, or `PerplexitySearchProvider`, an FI-local Parallel, Tavily, Serper, or Brave adapter, or the FI subscription provider for one operation. FI-local adapters implement the upstream `WebSearchProvider` request and result types, reject redirects, validate external response fields, and expose configurable credential references and endpoint bases. A settings change affects the next call. An in-flight call retains its original selection and options. The router never tries another provider after a selected-provider failure.

DeepSeek request recording retains `web/deepseek-search-llm-request`. `WebSearchProvider`, `WebRuntime`, `dsh-tool-web`, fetch selection, model-visible schemas, Session formats, and both SDK projections retain their upstream behavior.

## Credentials and authorization

The browser controller derives the active credential reference from the selected provider and current Host settings. It writes direct-provider keys through the Credentials Remote. A key write must succeed and read back as configured before a provider change commits. Credential literals do not enter settings, and read generations prevent stale responses for changed or repeated references from overwriting newer state. A failed credential-status read settles as a visible recoverable error and leaves write-only replacement available. Credential-only saves remain available when the settings document is read-only and the reference is writable. Client-plugin disposal stops the settings subscription and invalidates pending reads. Direct adapters use API-key authentication, so the card does not claim Exa, Perplexity, or Parallel MCP OAuth support.

Subscription search reuses Codex, Grok, Antigravity, or Claude grants obtained through the Models page. The search selector does not call authorization, adopt an LLM route, or change the chat provider. The Models page remains the only OAuth surface.

## Lifecycle and failures

The router combines caller cancellation with one plugin-lifecycle signal. Plugin disposal aborts every active operation, including delegate cleanup, and concurrent disposal calls await the same drain. Every configurable API-key endpoint must use HTTPS before FI resolves or sends a credential. FI-local direct adapters classify aborts from either DOM exceptions or the active signal, cancel failed response bodies, and never expose an external error body. Missing direct-provider credentials, unavailable selected providers, and incomplete subscription provider/model settings fail explicitly. No fallback obscures configuration errors or sends a query to an unselected vendor.

The FI bundle disables the original DeepSeek provider while the router is active because its upstream settings card would otherwise remain visible while editing a provider `WebRuntime` no longer selects. The FI card is the sole search preference and key UI in that composition. Its presentation consumes an injected snapshot hook and actions; the controller alone subscribes to settings and credential events.

## Consequences

FI profiles mount separate Host routing and browser presentation packages. Search selection changes without restarting `WebRuntime`; active calls remain stable. Direct-provider activation depends on a stored or launch-supplied key, while subscription selection depends on an existing Models-page grant. Upstream providers, tool schemas, Session events, dependency policy, and base bundle files remain unchanged. The shared Plugins settings directory now honors existing keyed-slot shadowing semantics.

FI Desktop packs the private authorization-bundle closure and mounts it by default. The public `@deepseek-ai/dsh` release has no FI dependency. Registry installation by package name remains unavailable until a separate publication decision assigns public names, versions, and release ownership.

## Alternatives considered

- Mutating `WebRuntime.searchProvider` after startup was rejected because the upstream runtime snapshots that field at construction.
- Editing upstream provider implementations or the base bundle was rejected because FI would carry a permanent compatibility patch across upstream updates.
- Adding Host dependency-policy exceptions for provider classes was rejected; splitting browser presentation from Host routing preserves existing duplicate-install rules.
- Replacing the native interface with a third-party search plugin was rejected for the default path because examined plugins differed in tool names, credential handling, privacy behavior, or profile patch scope. FI-local adapters preserve one upstream tool and result type while keeping vendor protocols replaceable.
- Adding direct-provider OAuth was rejected because these adapters authenticate with API keys. Parallel's OAuth-capable MCP endpoint remains a separate integration, and subscription OAuth stays owned by Models.

## Verification

Focused Host tests cover every direct adapter's wire mapping, external response validation, upstream DeepSeek field and literal-key behavior, per-call snapshots, cancellation, disposal, no-fallback failures, settings changes without re-registration, credential resolution, secret exclusion, incomplete subscription configuration, and effective base-plus-FI composition. Client tests cover all provider choices, password presentation, custom credential references, stale-response rejection, refused settings writes, subscription configuration, credential removal presentation, and one elected card when FI shadows the shipped card. Desktop tests cover the private FI package closure, required-package rejection, fixed default composition, and legacy-prefix migration. Separate Host and client package builds cover both compiler faces. The keyless subscription snapshot runs through `fi-preferred-search` and retains the recorded Session output. One live query through the production adapters returned normalized sources from Parallel, Tavily, Exa, Serper, and Brave without exposing or storing the supplied keys. A bundled Web boot rendered one search card with all provider choices and no browser errors.
