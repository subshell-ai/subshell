---
"@internal/server": minor
"@internal/node": patch
---

Organize saved launch settings into agent and SSH presets. Save SSH connection choices, including authentication preferences, from the launch form or preset library. Keep recent destination suggestions and replace the personal SSH settings page with the SSH preset tab.

Validate SSH destination syntax before saving, show field-level feedback, and normalize preset names on the server.

An SSH preset update now keeps the stored alias and description when the request omits them, and refuses a failed save in plain words instead of a raw response body. The SSH preset table follows the shared preset-table layout, and a required field left empty now shows its caption as a gold requirement rather than a red error.

The `list_presets` MCP tool now says so in its own words: it lists saved agent presets, and SSH presets stay dashboard-only.
