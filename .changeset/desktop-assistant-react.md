---
"@internal/desktop-server": patch
---

The assistant window is rebuilt in React. The hand-built DOM render (wizard.ts and the assistant/ modules) is replaced by components over the same pure decision modules, with every string, gate and latch carried over as it was; the shared Frame now lives in `@internal/assistant`, and the screens compose the shadcn kit the client assistant uses. Behavior is unchanged: first run, recovery, update, reset and permissions work as before.
