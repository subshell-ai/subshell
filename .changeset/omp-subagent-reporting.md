---
"@internal/server": patch
"@internal/docs": patch
"@subshell-ai/plugin-oh-my-pi": patch
---

Oh My Pi subshells now list their running subagents beneath the parent in the sidebar. Each launch adds a companion extension that reports omp's own subagent lifecycle and progress events, so names, status, and the harness's one-line label appear as they change; opening a child stays with omp's own controls. The sidebar's subsections also sit flush with the machine dropdown instead of 12px inside it, reclaiming that width for pane names.
