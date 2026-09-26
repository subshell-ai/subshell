# Standalone binary and CLI: the full account. Moved verbatim from AGENTS.md ("Standalone binary & CLI"); the AGENTS.md section keeps the boot contract, the verb list, the sync-exit invariants and routes here.

### Subcommands (hand-rolled dispatch in `src/cli.ts`, no flag library)

| Command | |
| --- | --- |
| `version` | print `subshell-server <version>` and exit |
| `status` | "what WOULD this boot with": opens with the `subshell-server <version>` line byte-identical to `version` (ONE fact, ONE spelling), then config.env path/existence, layer-tagged settings, masked secret (never echoed), tmux presence, mcp entrypoint, plugin registry, port liveness, service definition on disk, and `setup` (whether the first admin account exists), so the one command an operator is told to run when something looks wrong can answer the first question they have. Reading that counts users out of the database, which is why it opens read-only and FALLS BACK to read-write with `create: false`: SQLite cannot read a WAL database without a writable `-shm` beside it, so on any instance whose sidecars are gone (a restored backup, a cleanly closed copy) a read-only open succeeds and the first query throws. It still never creates a database. Reads only, never boots. `--json` emits the same facts as a machine-readable `StatusView` (never the secret, only `set`/`missing`). Each setting carries its layer as `source`, and `default` vs `config.env`/`process env` is what lets a consumer tell "the server would boot with this" from "somebody chose this"; the desktop console seeds its form on exactly that distinction. A setting may also carry `problems`, per-entry diagnostics saying what a BROWSER will do with a value the boot accepts (a schemeless origin, a non-canonical one, a base URL that silently drops the instance's own origin). Absent when clean, never `[]`, and never a verdict: see "Why the diagnostics live in `status` and not at boot" in `apps/server/api/docs/config-env.md` |
| `init` | first run, and THE headless entry point (spec 2026-09-15; terminal model re-cut 2026-09-26, `commands/tty-input.ts`): it ACQUIRES ITS OWN TERMINAL first, and that replaces the installer script's old `exec < /dev/tty` (which could itself block, hanging piped installs before anything printed). An interactive stdin is used as-is; a piped run attaches `/dev/tty` with an O_NONBLOCK open (it can never hang) and asks its questions OFF THAT FD, because bun's `process.stdin` stays bound to the pipe description fd 0 held at process start (measured: clack starves on the replaced fd; the pty scenario `src/__tests__/init-tty-pty.test.ts` keeps the working shape green). A genuinely terminal-less run takes its defaults and PRINTS EVERY DEFAULT IT TOOK: no service, no tmux install, PATH manual instructions, so silence is impossible. The ordering is a ruling, not a detail: the tmux preflight precedes EVERY write, and a declined offer or a failed installer child ABORTS init at exit 1 with nothing on disk (see the passages below the table). Then: config home (0700), `BETTER_AUTH_SECRET` bootstrap (file value > env adoption > fresh 32 random bytes base64url), the configure flow, the PATH question (`~/.local/bin` missing from PATH is offered with default yes: `export PATH="$HOME/.local/bin:$PATH"` appended idempotently to `~/.zprofile`, the create-safe login file, and to `~/.zshrc` only where one already exists), then the service question (run in the background and start at login?), installing through the same `installService` the service verb calls, then the handoff line naming `<APP_BASE_URL>/setup`. `--yes` means EVERYTHING (operator ruling 2026-09-26): file/built-in defaults, the tmux installer, the PATH write, and the background service, each announced by a line. `--verbose` raises this run's console logging to debug (see the passage below the table). `--no-service` skips the install, `--service` is its explicit opposite, and a run with nobody to ask installs nothing and says so, naming `service install` as the add-later remedy. **The desktop app passes `--no-service`** (`control.rs` `init_args`): it installs the service itself with its own autostart checkbox, so a question here would re-ask what the assistant already answered (its `--yes` still answers the PATH question, and a tmux-less Mac gets the brew install, per the same ruling). A CANCELLED question is "not that part", not a failed init (config.env is already written and `init` is idempotent), so it exits 0 and still prints the handoff; a FAILED install fails init and prints none |
| `configure` | (re)write config.env; interactive unless `--yes`; flags `--port --host --base-url --trusted-origins --db-path --yes --verbose`. Its `applyConfig` carries three address warnings, and the third (spec 2026-09-15) was the LAN-bind trap; since 2026-09-17 it is the NAME half of it: `HOST=0.0.0.0` + a loopback base URL + loopback-only `TRUSTED_ORIGINS` still dies on a 403 "Invalid origin" naming nothing WHEN BROWSED BY NAME, because browsing by one of the machine's own IP addresses is now derived and trusted automatically (`services/lan-origins.ts`). The validator is SHARED with the dashboard's Addresses card, so the CLI and the browser cannot disagree about when this is wrong |
| `service install` | write + enable/start the per-user service (refuses before any write without a config.env; run `init` first). `--no-autostart` installs one that runs NOW but does not come back at login. On Linux it then asks logind whether the user lingers, and prints the `loginctl enable-linger` advice only when the answer is not yes; the hint used to print on every install, which told an operator who had already fixed this to go and fix it (`null`, i.e. no loginctl and no bus, still prints: unneeded advice is cheaper than a reboot that loses the server). Run ALONE it also prints the `/setup` handoff, from the same helper `init` uses so the two cannot drift |
| `service uninstall` | stop + remove the service definition (deliberately never gates on config/tmux; a stranded unit must always come down) |
| `service enable` / `service disable` | arm or disarm start-at-login, WITHOUT touching the running process. Linux: `systemctl --user enable\|disable` with no `--now`; that flag is the whole difference between a preference and an outage. macOS: the plist MOVES (see `apps/server/api/docs/service-units.md`) |
| `service status` | what the MANAGER reports: run state, pid, starts-at-login, and whether a teardown keeps live panes; `--json` for scripts. Always exits 0: a view must not make a caller distinguish "not running" from "the call failed" |
| `service start\|stop\|restart` | drive an already-installed service. Never installs one; `start` must not become a way to background a server whose config was never checked |
| `update` | install a newer `subshell-server` over this one, REVERSIBLY (spec 2026-09-15 §4.4). It replaces the binary the SERVICE DEFINITION names, never a path by convention, because writing `~/.local/bin` on a host whose unit points elsewhere is an update that reports success and changes nothing. Ten steps, nine of them refusals: a checkout, an unwritable directory, an empty release source, a downgrade, a transaction already open, a binary that will not say what it is, a restart that would close live panes. The one irreversible moment is a pair of `rename(2)`s, and even that is undone by the NEXT boot. Flags: `--check --to <v> --from <file> --force --yes --json --no-restart --rollback` |
| `backup` | `VACUUM INTO` a single-file snapshot of the database now (spec §4.1). Its own verb rather than a flag of `update`, because the reason to take one by hand is that you are NOT updating. `--json` prints the path, size and how many are kept |
| `mcp` | serve the pane-spawned stdio MCP server (the self rung of MCP resolution below); the one long-running command, spawned by harnesses, not typed by humans |
| `report attention turn_complete\|needs_attention\|resumed`, `report session` | out-of-band reporting from a harness HOOK: attention signals, and the pane's current conversation id (read from the SessionStart payload on stdin; only `session_id` is forwarded). Run by generated hook command lines, never typed. ALWAYS exits 0 and prints nothing, even on an unreachable server or an incomplete pane env; a hook's stderr and exit code land in the user's session, and a lost report costs one notification, never a turn. A `turn_complete` report reads the hook's stdin payload and stays silent when it names running background work or scheduled crons; a session parked on a subagent does not claim to be done (spec 2026-09-23). `resumed` is the waiting CLEAR and reads NO stdin (the payloads are the prompt text and the tool input): the idle watcher can only clear panes whose log it can stat, which is `local` only, so an agent-node pane had no clear path at all until its own hooks carried one (2026-09-24) |

**The tmux offer keeps a SEPARATE synchronous prompt seam**, and that is a known
divergence rather than an oversight. Its preflight is shared with
`installService`, which returns a `CliResult` rather than a promise and cannot
await; making it async ripples through every service caller to change one y/n
from a clack text box into a clack confirm. Worth doing deliberately or not at
all; do not "fix" half of it.

**The gate is three-valued since 2026-09-26** (operator ruling: `--yes` means
everything). A TTY run gets the question; an `--yes` run of `init`/`configure`
RUNS the installer with a printed line and no question; a run with neither
refuses, and on a host that has an installer the refusal gains one line naming
how to get the offer back ("re-run init in a terminal (or with --yes) to
install it"). `service install` has no `--yes`, so it keeps the plain
TTY-only rule, and `declineNotice` is deliberately unset there: the promise
must name a route the verb actually has. `makeTmuxOffer` is the one place the
`init`/`configure` shape is computed, so the two commands cannot drift.

**A declined or failed tmux install ABORTS `init` (same ruling, part 2).**
The preflight precedes every write, so the abort leaves nothing behind: exit
1, no config home, no half-asked interview, no handoff pointing at a server
that could not run panes. The abort message does the three things a person
needs: it says tmux is what runs panes, it prints the declined manager's own
manual command (`brew install tmux`, `sudo port install tmux`, or the
Homebrew URL), and it notes the binary is already installed at
`~/.local/bin/subshell-server` so the rerun after tmux exists is the whole
fix. A run with nobody to ask takes the same abort, loudly. `service
install`'s refusal is shared and unchanged: it still points at its own
`--yes`-less remedy line.

**The macOS ladder is three-way (2026-09-26)**: `brew` installs tmux,
otherwise MacPorts (`port`) does, and with neither an offer to install
Homebrew itself runs `/bin/bash -c "$(curl -fsSL <official installer URL>)"`.
That bootstrap is Homebrew's own documented installer on their
infrastructure, not a revival of the retired installer hosting here, and the
comment in `commands/tmux-install.ts` says so because the URL looks like it.
It prompts for an admin password, which decides where it may run: a `--yes`
run only when a terminal exists to answer it, and with no terminal at all it
is NEVER attempted: the command prints the URL and instructions instead. The
server's own `POST /api/setup/tmux/install` route refuses the bootstrap and
the MacPorts row by name (it has no terminal by construction, same doctrine
as its `sudo` refusal), so the widened ladder reaches the CLI only, and a
Mac with MacPorts installed keeps working: `service.ts` bakes the installing
shell's PATH into the unit/plist unchanged, so `/opt/local/bin` rides the
same rail `/opt/homebrew/bin` always did (pinned in
`__tests__/service.test.ts`).

**`--verbose` is console debug for one hand-invoked run (2026-09-26).**
After a verb (`init`, `configure`, `update`, every `service` verb) it raises
the stdout transport's level to `debug`, HTTP request lines included, for the
life of the process; LEADING the command it is the one pre-boot recognition
and boots the server the same way, because the pinned contract that a leading
flag boots still holds (the boot-path test in `__tests__/cli.test.ts` keeps
it honest). It never touches the FILE transport's level, the `debug_logging`
settings row, or the `SUBSHELL_DEBUG_LOGGING` env-forced read-only rule: the
service manager's ExecStarts carry no such flag, so a managed journal stays
clean by construction. It is refused together with `--json` on the commands
that emit JSON (`update`, `service status`): JSON on stdout and debug lines
cannot share it, and the refusal lands before the gate is raised.
`status`/`backup` keep `--json` alone: their view output must not need the
flag to stay machine-readable.

### Boot output

Boot opens with the `/subshell` wordmark, then `subshell-server <version>`.

The wordmark in `src/banner.ts` is **hand-set for the terminal**, and that is a
decision rather than an oversight. Rasterizing `brand/src/wordmark.svg` was
tried first (it would have kept the banner sourced from the master), but
Acherus is a hairline face, and at the ~12 pixel rows a banner can afford every
weight in the family thresholds into uneven, broken strokes. It reads as wrong
rather than as small. This is the 16px-favicon problem with the usual answer:
below a certain size a mark is REDRAWN for the grid, not resampled onto it.
The COLOURS are still the master's own values, since a palette is the part that
can silently drift.

It is **plain ASCII**: `#` and `+`, no block elements or box drawing. Those
depend on the font rendering them at exactly the cell box and the seams show in
a lot of terminals. The `#`/`+` split is not decoration either: it draws the
same `sub`/`shell` boundary the colour does, so the two-tone survives a
journal, a piped log, or a terminal without truecolor. Those are two
independent constants describing one edge (the characters, and `SUB_END` in the
painter), which is exactly the kind of pair that drifts silently; a test pins
them together.

It reaches stdout through a LogLayer **group** (`BANNER_GROUP` in
`utils/logger.ts`) bound to its own unprefixed `ConsoleTransport`. The pretty
transport stamps `[time] INFO` on a message's first line, which would shear the
top row off the letterforms, and writing to `console` directly would put an
unmanaged writer back into a codebase that routes everything through LogLayer.
`ungroupedBehavior: ["pretty"]` keeps ordinary logs on the prefixed transport
only; without it every line would print twice.

Colour is 24-bit ANSI, taken from the master's own fills, and is emitted **only
when stdout is a TTY**; under systemd or launchd it is not, and escape codes
written into a journal are something an operator has to read around forever.

### MCP entrypoint resolution

Every subshell create spawns `subshell mcp`; HOW it's found is the pure ladder
in `src/services/mcp-resolve.ts` (split out of `mcp-launch.ts` so the
side-effect-free CLI can import it; it touches no fs):
`SUBSHELL_MCP_COMMAND`/`_ARGS` override → SELF (the server binary IS the MCP
server: `<execPath> mcp` when compiled, `<execPath> <absolute entry> mcp`
under `bun run`/dist) → the `subshell` node CLI on PATH (`subshell mcp`:
safety net for installs whose server predates the self rung) → throw with the
`SUBSHELL_MCP_COMMAND` hint. A deployment matching NONE of these 500s on
create; `subshell-server status` prints the resolved command and its rung
(`mcp entrypoint = … (via …)`, or `UNRESOLVED`) so the gap shows up before a
user hits it.

**The harness-hook reporter shares that ladder, minus the override.**
`probeReporterLaunch` answers the same host question for `<self> report …`,
the command a harness hook runs to report attention and conversation identity.
It skips the `SUBSHELL_MCP_COMMAND` rung on purpose: that variable names an MCP
*server*, which an operator may point at a wrapper with no `report` verb, and
honouring it would turn a working MCP override into broken hooks in every pane.
Unresolved is a real answer here rather than a throw; the plugin omits its
hooks instead of baking a command the pane cannot run. For a subshell on an
agent node the reporter is composed from that node's own reported
`selfInvoke` prefix instead (`nodeSelfInvoke`), because a hook runs where the
pane runs and the control plane's own path means nothing there. The hooks used
to be `bun -e '<inlined JS>'`, which assumed a bun on the pane PATH, true of
the container image, false of every desktop install, where Claude Code opened
each session on `bun: command not found` and neither notifications nor
restart-resume identity ever worked.

(`subshell-server mcp` became possible once the entry graph was
IO-free at import (lazy `getAuth()`, purity-tested), so a long-running
subcommand can no longer drag the boot graph into side effects; the 1.3.x
companion-binary era that made a separate tiny entry necessary is retired.)

### Embedded SPA + release dance

`selectStaticPlugin` picks the static source at boot: an on-disk frontend
dist wins (so a dev run and a checkout-based service behave identically),
else the SPA baked into the
binary by `scripts/embed-web.ts` (`src/generated/embedded-web.ts`: a
TRACKED stub keeps the unconditional import legal on a fresh clone;
embedded responses carry a strong `ETag`, the tell of memory mode), else
boot fails loudly. Caveat measured on bun 1.4.0: the compiled binary bakes
its BUILD-TIME source path into `import.meta.url`, so on the build machine
the repo's own `apps/server/web/dist` shadows the embedded copy; hide that
path (e.g. a bind-mount sandbox) before asserting embedded mode is live.

From the repo root:

```bash
bunx turbo build           # 1. apps/server/web/dist must exist (embed preflight)
bun run release:cli-server # 2. = apps/server/api compile:release (src/scripts/release.ts)
```

The pipeline embeds the SPA (the generator overwrites the stub; the stub is
restored with `git checkout` in a `finally`; embedded bytes are release
noise, never a commit), builds the three `SERVER_TARGETS` triples
(`linux-x64`, `linux-arm64`, `darwin-arm64`; no darwin-x64, since Intel
Macs are not a target for any component;
`@internal/subshell-protocol` `paths.ts`); one binary per triple: the
SPA-embedded `subshell-server-cli-<triple>` (the `cli` marks it as the bare
binary, not the desktop app that wraps it; an install renames it to
`subshell-server`), which serves its own `mcp` subcommand so a server-only
host self-resolves its MCP entrypoint, each with `--bytecode` (bun ≥
1.4.0 asserted; `SUBSHELL_SERVER_RELEASE_TRIPLES` scopes a subset for CI),
darwin targets are signed + notarized first when `SUBSHELL_RELEASE_SIGN_CMD`
is set (CI sets it to `scripts/macos-sign-notarize.sh` on the darwin shards; see
root `AGENTS.md`; unset locally, so plain release runs skip the hook),
and publishes atomically (tmp + rename + `.sha256` sidecar) to
`SUBSHELL_SERVER_RELEASE_DIR`, default `<repo-root>/dist-server`, an
operator drop dir to scp/deploy, not a data-dir ladder like the node's
node artifacts. A failed target publishes NOTHING.

