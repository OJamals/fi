# Agent Note: Security-patched documentation toolchain

Status: implemented

English | [中文](2026-09-25-security-patched-doc-toolchain.zh.md)

## Problem

The documentation toolchain resolved Mermaid, DOMPurify, and Browserslist through versions with published security advisories. A broad override would affect unrelated applications and could hide compatibility failures outside the documentation build.

## Decision

Root and website Mermaid use 11.16.1, the first version release that resolves the [Mermaid advisories](https://github.com/advisories/GHSA-c4c3-pg64-4m4v) and [Mermaid architecture advisory](https://github.com/advisories/GHSA-3rrr-jr9j-h3q3). Workspace overrides force every transitive DOMPurify and Browserslist instance to 3.4.13 and 4.28.7, matching the first patched release named by the [DOMPurify advisory](https://github.com/advisories/GHSA-55q2-fjhq-7xh7) and [Browserslist advisory](https://github.com/advisories/GHSA-c83g-rgw3-j3cx). The website's own Vite dependency moves from the `^5.4.14` range to the exact `6.4.3`, and a matching `vitepress@1.6.4>vite` workspace override narrows only VitePress's declared Vite 5 peer to that version; VitePress 1.6.4 has not yet widened its peer range. The Vite 6 migration is reviewed for the website's static build and dev server only; no Vite override applies to other packages. The lockfile is refreshed by pnpm, never hand-edited.

## Alternatives considered

- **Use a global Vite override.** Rejected: it would change application and test bundlers outside the website.
- **Move to VitePress 2 prerelease.** Rejected: the stable VitePress 1 line is sufficient for this patch and does not justify a documentation-framework migration.
- **Run a blanket audit fix.** Rejected: it can introduce unrelated majors and bypasses review of the affected dependency paths.

## Consequences

The website needs build and dev-server smoke coverage against Vite 6. The narrow peer override remains until VitePress widens its stable peer range; future dependency refreshes must recheck the named advisories and the website smoke path.
