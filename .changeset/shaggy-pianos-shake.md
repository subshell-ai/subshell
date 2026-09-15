---
"@internal/node": minor
---

The agent can replace its own binary, and a refused one can be rescued from a browser.

`subshell update` installs a newer agent over this one and restarts into it —
`--check` to see what is available, `--from` to install a local file, `--to` to
pick a published release, `--rollback` to put the previous binary back. The
plane can drive the same thing with a signed `update` command.

Every install is a transaction the next process completes: the swap keeps the
old binary as `<binary>.previous` and writes a marker, and the agent that boots
either finishes it (the plane accepted this version) or reverts it (the plane
refused with 4406 — the previous binary goes back and the service manager
brings it up, on a machine nobody had to visit).

Node protocol 10, and the minimum agent version this server family talks to
rises to 0.9.0 with it. `subshell status --json` now reports the binary an
update would replace and the state of any transaction.
