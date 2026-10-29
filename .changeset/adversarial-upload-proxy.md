---
"@internal/server": patch
"@internal/desktop-server": patch
---

Refuse workspace links that redirect local uploads or Git-ignore updates to unrelated files. Strip X-Sendfile directives from preview responses before an outer proxy can interpret them.
