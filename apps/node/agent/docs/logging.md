# Logging: the full account

Moved verbatim from `apps/node/agent/AGENTS.md`, which keeps the operational
summary and routes here. Only cross-references into sections that moved were
repointed.

## Logging

`src/log.ts` is the node's only log surface: **LogLayer** with TWO transports, the core
`ConsoleTransport` and `CappedFileTransport` (`src/log-file.ts`), both built on what ships inside the `loglayer` package, so the compiled binary
takes on no third-party dependency for logging. `log(message)` is the common
call; `logger` is there for `withError()` / `withMetadata()` / levels.

**The file exists because the console does not answer the question.** What
happens to the node's stdout is a different thing on every platform: launchd
redirects it to a file, systemd hands it to the journal, a container sends it
nowhere in particular, which is why `collectRuntime` reports a `logHint`
telling a person to go run `journalctl`. Most nodes are headless, so "read this
machine's log" has to work from a browser, and it cannot be built on an
artifact that only exists on macOS. So the node writes one bounded file of its
own: `<configHome>/logs/agent.log`, JSON lines, 0600, capped at 200 KB and
REPLACED when full, the same everywhere, served to the plane by
`agent_log_read` and reported as `runtime.agentLogPath`. It is a deliberate
COPY of the server's `utils/log-file.ts` rather than an import: that file is
AGPL and this app is Apache-2.0, so importing the value would entangle the two
licences for sixty lines.

**Debug level is a switch, and it currently reveals nothing.** The file
transport carries a `level` (`info` by default) and `debug-logging.ts` flips it
live: off by default, persisted in `config.json` so a `service restart` does
not silently end a debug session, forced on and made read-only by
`SUBSHELL_DEBUG_LOGGING` in this node's environment (only `1`/`true` force;
`=0` is a variable somebody left behind, not the environment saying off). The
plane drives it with `set_log_level` and shows it on the node's Log card.

Two things to know before reaching for it. The node has **no `logger.debug`
call sites**, so turning it on changes what would be recorded rather than what
is: the mechanism went in ahead of the lines by decision, and the card says so
on screen. And the server's equivalent switch is not the same feature: that one
exists for `@loglayer/elysia`'s per-request lines, which is why it carries
security accounting about paths that can hold a setup key. A node serves no
HTTP and has no equivalent stream, so whoever writes the first debug line here
owns redoing that accounting for whatever it carries.

The console transport is never touched by any of this: what journald or launchd
collects stays at `info`.

**The manager's copy of that stream is 0600 too, and only because the daemon
makes it so** (`src/log-hygiene.ts`, 2026-09-18). On macOS launchd creates the
plist's `StandardOutPath` file itself, with the job's umask, 022, so
`~/Library/Logs/subshell.log` lands **0644** and nothing the node writes
afterwards changes it. It holds the same lines the node's own 0600 file holds,
so `subshell run` chmods it to 0600 at start, before the daemon loop: a
best-effort, idempotent repair in the shape of the server's
`services/pane-log-hygiene.ts`, total by construction (every outcome is a
value; a refusal is one `warn` line and the daemon starts anyway).

Three measured facts hold that up, all 2026-09-18 on this repo's own two
launchd jobs:

- **A mode set once sticks.** `~/Library/Logs/subshell-server.log` was 0600
  while `~/Library/Logs/subshell.log` was 0644 under identical plists, because
  the server's copy had first been CREATED at 0600 by Subshell Server's
  supervisor (`apps/server/desktop`'s `open_console_log`): launchd opens the
  redirect `O_APPEND|O_CREAT` and leaves an existing file's mode alone. So the
  chmod is not a thing to redo on every line, only on every start, because
  launchd re-creates a file that was deleted.
- **There is no plist lever to reach for instead.** launchd's `Umask` key was
  not adopted: whether it applies to the redirect files launchd opens BEFORE
  exec is undocumented, and measuring it means installing a real launchd job,
  which is precisely what the suite may not do. The chmod is verifiable without
  one.
- **It is a repair, not a creation.** The pass never creates the file: an
  absent log is launchd's to make on the next line, and pre-creating one would
  be this node writing into `~/Library/Logs` on machines with no service at
  all. The window that leaves (launchd creating the file 0644, the node
  chmodding it microseconds later) is accepted and is the reason the repair
  runs on every start.

The seam is `ServiceDeps.chmodFile`, **optional on purpose**: a deps object
built by hand in a suite carries none, so the pass reports `no-seam` and
touches nothing, and the production implementation carries the same under-test
refusal as `writeFile` (`assertServiceWriteUnderTest`). It is called from
`cli.ts`'s `case "run"` rather than inside `runDaemon`, because `daemon.test.ts`
calls that function directly and a repair reachable from there would aim at the
developer's real `~/Library/Logs`. Linux needs none of this: the systemd user
unit redirects nothing, so the pass answers `no-file`.

Three more things about it are deliberate:

- **The line format is unchanged** from the hand-rolled `console.log` it
  replaced (`[subshell <ISO>] <message>`, via `messageFn`). The daemon's stdout
  is read by whoever runs `subshell run` and by systemd/launchd, and launchd's
  log file stamps nothing itself.
- **`errorSerializer` flattens errors to plain strings.** Handing the console a
  raw `Error` makes Bun's inspector print source context, which inside a
  `--compile --bytecode` binary is the *whole minified bundle*, measured at
  ~25 KB in front of one stack trace. Four lines, no `serialize-error`
  dependency (the server can afford one; a downloaded artifact should not).
- **Tests never spy on `console`.** `__tests__/helpers/capture-logs.ts` swaps
  the TRANSPORT (`logger.withFreshTransports`), LogLayer's own seam. The old
  console spies asserted against which console method a level happens to call,
  so routing through LogLayer blinded eight tests at once, each still passing
  its setup and failing its assertion, with nothing naming the cause.
