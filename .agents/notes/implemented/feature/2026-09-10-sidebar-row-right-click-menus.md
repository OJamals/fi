# Agent Note: sidebar row right-click menus

Status: implemented

English | [中文](2026-09-10-sidebar-row-right-click-menus.zh.md)

## Problem

Sidebar Workspace and Session rows carried their row verbs (Rename/Delete, Rename/Fork/Archive) only behind the hover-revealed `...` button, so pointer users had to dwell on a row to reach them. A right-click on a row did nothing: the rows had no `contextmenu` handling, and the Electron shell's native context menu only covers editable text and selections, so the affordance the desktop platform promises was absent exactly where users expect it.

## Decision

Right-click on a row that owns a menu opens the same `Menu` items at the pointer. `ProjectRowItem` and `SessionNodeItem` (packages/client/ui-workspace/src/client/rows/Rows.tsx) attach an `onContextMenu` handler gated exactly where the `...` button renders (real Workspace rows; non-blank Session rows): it suppresses the default menu, records the pointer coordinates in a ref, and opens the existing menu. The menu's new `getAnchorRect` (an existing Menu primitive capability) supplies a zero-size `DOMRect` at the recorded point, so the portaled list is fixed at the cursor like a native context menu; the point is cleared on close and on every `...` click, so button-anchored placement is unchanged. Rows without a menu (the ungrouped bucket, blank New Session rows) attach no handler and leave the right-click to the host.

## Alternatives considered

**Reusing the Electron native menu for row verbs.** The verbs are client actions over client state (rename dialogs, fork, archive-set echoes); a main-process menu would need an IPC surface duplicating them, and the web client would still lack the affordance.

**Opening the menu anchored at the `...` button on right-click.** Same items with none of the native feel: the menu would pop at the button's position, possibly far from the pointer on a wide row.

**A dedicated context-menu component.** A second menu implementation beside the `Menu` primitive, or a page-level contextmenu broker, would duplicate anchoring, dismissal, and a11y the primitive already owns; the rows already own their item lists.

## Consequences

Row verbs are reachable without hovering in both the web client and the desktop (which renders the same client); the `...` button keeps its measured-anchor placement, and Escape/outside-pointerdown dismissal already owned by `Menu` applies to the pointer-positioned list. The Electron shell's native context menu still handles editable text and selections; because Electron emits its `context-menu` event regardless of renderer `preventDefault`, right-clicking a text selection inside a row can surface the native copy menu beside the row menu — an accepted edge case, since copy-on-selection remains useful there. Upstream merge surface: two row components, their specs, and one sentence in each README.
