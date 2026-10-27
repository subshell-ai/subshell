---
"@internal/server": patch
"@internal/node": patch
"@internal/desktop-server": patch
"@internal/desktop-client": patch
---

Fix long prompts remaining unsubmitted in Codex subshells. Automated input now waits for the end of the prompt to render and allows the paste parser to settle before pressing Enter, including prompts sent by another subshell. Concurrent automated sends stay separate, and repeated prompt text no longer triggers submission before the full burst renders.
