---
"@internal/server": minor
"@internal/node": patch
"@internal/docs": patch
---

Add preset and node notes to cross-agent discovery, with recommended starting directories for nodes. Agents can read this guidance and preset launch defaults through MCP before choosing where and how to start a subshell. Notes are limited to 8,000 characters in the dashboard, API, and preset imports. Directory suggestions don't change access permissions.

Clarify MCP cleanup instructions: collect results and delete completed temporary helpers, or terminate them when their history needs to be retained.
