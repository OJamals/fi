---
kind: upgrade-guide
description: "fi Desktop no longer provides the bundled dsh terminal command or its management menu."
---

# Desktop terminal command removal

English | [中文](guide.zh.md)

## Change

fi Desktop no longer ships its terminal launchers or **Manage dsh Command…** menu. Existing terminal registrations pointing into the application stop working after upgrading. The shared profile runtime remains available to the Desktop Host. Sessions, settings, credentials, and standalone CLI installations are unchanged.

## Migration

1. Before upgrading, open the old application's **Manage dsh Command… → Remove** dialog to unregister its terminal command and restore any displaced launcher.
2. Use the standalone [CLI](../../../../apps/cli/README.md) for terminal workflows. Manage Desktop plugins through the application's Plugins page.
3. After upgrading, confirm Desktop opens existing sessions and the application menu no longer offers command management. If upgrading before unregistering the old command, inspect its target before removing any stale link or PATH entry; do not remove another installation or its saved backup.
