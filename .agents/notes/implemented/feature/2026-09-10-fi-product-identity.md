# Agent Note: fi product identity

Status: implemented

English | [中文](2026-09-10-fi-product-identity.zh.md)

## Problem

Official builds exposed several unrelated product identities: desktop packaging and recovery windows used the DeepSeek Harness name, browser chrome and install metadata used DSH branding, and the browser UI rendered fish artwork. Replacing only one location left installed applications, new-session presentation, and update artifacts inconsistent.

## Decision

The official product name is `fi`. The official client build environment supplies that browser title, `dsh-client-ui-brand-official` fills the sidebar and conversation-hero slots with the self-lettered fi artwork, and the Web manifest, favicon, and framework-free boot page use the same artwork. The sidebar renders only the artwork, without adjacent fi text or a build-version badge. The first-run notice also names fi.

Desktop packaging uses `fi` for the product, executable, application bundle, and artifact filename. Its PNG and ICNS files derive from `apps/desktop/build/fi-logo-source.png`, while the browser consumes the size-appropriate copy at `apps/web/public/fi-logo.png`. `apps/desktop/build/fi-logo-dark-background.png` is the transparent brand variant for dark surfaces; it preserves the cyan and purple accents and replaces the source artwork's dark fill with white. The size-appropriate browser copy at `apps/web/public/fi-logo-dark-background.png` replaces the default artwork in the framework-free boot page, conversation hero, sidebar, and dark browser chrome when the shared theme owner activates dark mode. Install and operating-system application icons remain the default artwork because they do not follow the running application's theme.

On macOS, the main BrowserWindow uses Electron's `hiddenInset` title-bar style and positions native traffic lights 16px from the top in a 32px draggable application row. AppFrame continues the sidebar fill beneath the controls and the main background across the remaining row. The startup document provides the same draggable height before the application renderer loads; auxiliary windows retain standard native chrome. The expanded sidebar places a 40px brand mark at an 18px frame coordinate, a 4px optical inset from the traffic lights and New Session border. Equal 4px padding above and below the mark plus the trailing 8px margin preserves 12px clearance from both neighboring control groups. The collapsed rail keeps its 24px mark.

The desktop application ID is the source-owned `com.fi.app`; release environments cannot replace it. Packaged application metadata uses `fi` as its package name, which also owns electron-builder's `fi-updater` cache directory. Production packages embed electron-builder's GitHub provider with the explicit source-owned repository `OJamals/fi`. Published GitHub releases are the official update source; preview installations follow published preview prereleases, stable installations follow published stable releases, and drafts remain invisible. Test packages keep a separate generic HTTPS feed and COS upload path. The macOS release pipeline first asks electron-builder for a signed directory while automatic publication is disabled, a combination that skips electron-builder's standard updater-config writer. The Desktop `afterPack` hook therefore writes the resolved provider, version-derived channel, and builder-owned cache directory to `Contents/Resources/app-update.yml` before signing; a missing write fails packaging. fi prereleases use public labels `fi Preview 01`, `fi Preview 02`, and so on, with matching package versions `0.1.0-preview.1`, `0.1.0-preview.2`, and so on. The first public fi prerelease uses release title `fi Preview 01` and electron-builder's `preview` update channel. It publishes signed and notarized macOS arm64 artifacts only, and its update metadata references only that architecture.

Other compatibility and implementation-origin identifiers remain unchanged. The `dsh` command, `$DSH_HOME`, remaining `DSH_*` environment variables, `@deepseek-ai/dsh-*` package names, SDK wire identities, and references to the underlying DeepSeek Harness implementation keep their existing values. Package repository metadata names the fi repository while the license and root documentation retain upstream attribution.

## Alternatives considered

**Rename every DSH and DeepSeek Harness identifier.** This would break package resolution, profiles, stored paths, automation, and wire consumers without improving the product-facing identity. The application ID is different: it identifies the installed fi application and therefore belongs to fi.

**Replace only desktop packaging.** This would leave the browser title, install metadata, sidebar, conversation hero, and onboarding notice presenting older brands inside an application named fi.

## Consequences

Users see one fi identity across startup, installed application chrome, and the official browser UI. Native macOS controls belong to the application surface instead of a separate title bar. Brand changes must update the checked-in source artwork and regenerate its desktop and Web derivatives together. Installations and updater metadata use `com.fi.app`; the first public artifacts use package version `0.1.0-preview.1` and public version `fi Preview 01`. Internal tooling and external integrations continue to use their stable DSH identifiers.
