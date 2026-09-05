---
"@internal/server": patch
"@internal/client": patch
---

Make the running version answerable everywhere it is asked.

- `subshell --version` / `-v` now work. They alias the `version` subcommand,
  but only in the command slot: argv[0] IS the command in this parser, so
  `subshell status --version` remains an unknown flag, because it is a typo
  rather than a request for the version.
- The server LOGS its version as the first line of boot, before anything can
  fail. After a restart, which build came up decides how to read every line
  beneath it — and the service manager restarts whatever binary sits at the
  unit's ExecStart path, which is not always the one you assume.
- `subshell-server status` opens with the same `subshell-server <version>`
  line the `version` subcommand prints. "Which build is this host running?"
  is the question that decides whether the rest of the output is even
  relevant, and status could not answer it.
- `GET /api/meta/status` reported a hardcoded `appVersion: "1.0.0"` while the
  server was at 1.5.0. It now derives from `SERVER_VERSION`, with a test that
  compares the two so the drift cannot recur.
- `GET /api/settings/public` gains `serverVersion`, and Preferences gains an
  About section showing it beside the bundle build id. The two version
  independently, and a bug report needs the pair.

No `--version` flag on `subshell-server`: a leading `-` there is the boot path
by contract (svc.sh and systemd pass flags, never subcommand words), so the
flag would have to carve an exception out of the one rule that keeps the
service deployment byte-identical. `subshell-server version` and now `status`
both answer instead.
