---
"@internal/client": patch
---

Move the agent's logging onto LogLayer, matching the server.

`src/log.ts` was the last hand-rolled logger in the repo — a bare `console.log`
with a manual timestamp. It is now LogLayer with the core `ConsoleTransport`,
both of which ship inside the `loglayer` package, so the compiled agent binary
gains no third-party dependency.

Output is byte-identical: `[subshell <ISO>] <message>`, still on stdout. What
changes is what the agent CAN now do — levels, `withError()`, `withMetadata()`,
and a swappable transport — none of which the previous logger allowed.

Errors are flattened to plain strings by a four-line `errorSerializer`, because
handing Bun's console a raw `Error` inside a `--compile --bytecode` binary
prints the entire minified bundle as source context (~25 KB per call).
