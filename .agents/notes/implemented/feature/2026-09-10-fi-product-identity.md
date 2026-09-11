# Agent Note: fi product identity

Status: implemented

English | [中文](2026-09-10-fi-product-identity.zh.md)

## Problem

Official builds exposed several unrelated product identities: desktop packaging and recovery windows used the DeepSeek Harness name, browser chrome and install metadata used DSH branding, and the browser UI rendered fish artwork. Replacing only one location left installed applications, new-session presentation, and update artifacts inconsistent.

## Decision

The official product name is `fi`. The official client build environment supplies that browser title, `dsh-client-ui-brand-official` fills the sidebar and conversation-hero slots with the self-lettered fi artwork, and the Web manifest, favicon, and framework-free boot page use the same artwork. The sidebar shows complete build metadata beneath the artwork and suppresses redundant adjacent fi text. The first-run notice also names fi.

Desktop packaging uses `fi` for the product, executable, application bundle, and artifact filename. Its PNG and ICNS files derive from `apps/desktop/build/fi-logo-source.png`, while the browser consumes the size-appropriate copy at `apps/web/public/fi-logo.png`.

On macOS, the main BrowserWindow uses Electron's `hiddenInset` title-bar style and positions native traffic lights in a 20px draggable application row. AppFrame continues the sidebar fill beneath the controls and the main background across the remaining row. The startup document provides the same draggable height before the application renderer loads; auxiliary windows retain standard native chrome.

The desktop application ID is the source-owned `com.fi.app`; release environments cannot replace it. Production packages embed electron-builder's GitHub provider with the explicit source-owned repository `OJamals/fi`. Published GitHub releases are the official update source; alpha installations follow published alpha prereleases, stable installations follow published stable releases, and drafts remain invisible. Test packages keep a separate generic HTTPS feed and COS upload path. The first public fi prerelease resets the product release line at `0.1.0-alpha.1`, uses the release title `fi alpha 1`, and selects electron-builder's alpha update channel. It publishes signed and notarized macOS arm64 artifacts only, and its update metadata references only that architecture.

Other compatibility and provenance identifiers remain unchanged. The `dsh` command, `$DSH_HOME`, remaining `DSH_*` environment variables, `@deepseek-ai/dsh-*` package names, SDK wire identities, and references to the underlying DeepSeek Harness implementation keep their existing values. Package repository metadata names the fi repository while the license and root documentation retain upstream attribution.

## Alternatives considered

**Rename every DSH and DeepSeek Harness identifier.** This would break package resolution, profiles, stored paths, automation, and wire consumers without improving the product-facing identity. The application ID is different: it identifies the installed fi application and therefore belongs to fi.

**Replace only desktop packaging.** This would leave the browser title, install metadata, sidebar, conversation hero, and onboarding notice presenting older brands inside an application named fi.

## Consequences

Users see one fi identity across startup, installed application chrome, and the official browser UI. Native macOS controls belong to the application surface instead of a separate title bar. Brand changes must update the checked-in source artwork and regenerate its desktop and Web derivatives together. Installations and updater metadata use `com.fi.app`; the first public artifacts use version `0.1.0-alpha.1`. Internal tooling and external integrations continue to use their stable DSH identifiers.
