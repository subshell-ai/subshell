---
"@subshell-ai/plugin-openclaw": minor
"@internal/server": minor
"@internal/node": minor
"@internal/desktop-server": patch
"@internal/desktop-client": patch
"@internal/docs": patch
---

Add the OpenClaw harness plugin: launch, detect, and install guidance ship now. The pane runs the embedded terminal UI (`openclaw chat`), and cross-subshell comms stay unwired until OpenClaw grows a per-session MCP registration path, since its registrations are Gateway-scoped.
