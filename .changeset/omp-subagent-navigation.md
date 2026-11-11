---
"@internal/server": patch
"@internal/docs": patch
"@subshell-ai/plugin-oh-my-pi": patch
---

Oh My Pi subagent rows in the sidebar now switch the parent terminal to the selected child, and the header follows agent changes made inside omp. The selected child's row carries the focus ring instead of the parent. Subagent tooltips render beside the row they explain instead of over the parent above it, and no longer intercept clicks. Clicking a subagent's parent row returns the shared view to the main agent instead of collapsing the child rows.
