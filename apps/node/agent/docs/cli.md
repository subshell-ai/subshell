# The CLI surface: the full account

Moved verbatim from `apps/node/agent/AGENTS.md`, which keeps the operational
summary and routes here. Only cross-references into sections that moved were
repointed.

## CLI (`src/cli.ts`, hand-rolled parser, no flag library)

```
subshell setup --server <url> --key <nsk_…> [--name <n>] [--data-dir <d>]
               [--no-service] [--yes] [--json]
                                   # THE HEADLESS ENTRY POINT (spec 2026-09-15): tmux
                                   # preflight, then the node's NAME, then `enroll`, then
                                   # the service question — run in the background and start
                                   # at login? — defaulting to yes, then the same
                                   # installService the service verb calls, then a line
                                   # naming the node's page. What the rendered install.sh
                                   # invokes. `enroll` stays a primitive beneath it for
                                   # anyone composing their own flow; this is the one a
                                   # person runs.
subshell enroll --server <url> --key <nsk_…> --name <n> [--data-dir <d>] [--json]
                                   # --json prints {nodeId,serverUrl,name,dataDir,configPath}
                                   # (never the nodeKey) so a GUI need not scrape the human line
subshell configure [--server <url>] [--key <node key>] [--json]
                                   # edit how an ALREADY-enrolled node reaches its
                                   # control plane, keeping its identity (nodeId/
                                   # controlPublicKey always survive). --server repoints;
                                   # --key stores a ROTATED node key (the value the node's
                                   # page shows once after Rotate key) IN PLACE of the
                                   # bearer secret — no second node row, no setup key
                                   # spent. The non-destructive answer to "the server
                                   # moved" and "the key was rotated", which `enroll` is
                                   # not. CLEARS nodeWsUrl when the address changes (see
                                   # `apps/node/agent/docs/repointing.md`); a --key-only
                                   # edit leaves it (the dial target
                                   # is unchanged). Restart to apply. --key REFUSES an
                                   # `nsk_` value by name — that is a SETUP key, whose verb
                                   # is `setup`/`enroll` (see configure.ts). At least one
                                   # of --server/--key is required. Takes NO --name: see
                                   # `apps/node/agent/docs/node-name.md`. NO --registry-url
                                   # either: it configured the npm
                                   # mirror the old `subshell plugin install` verbs fetched
                                   # from, and those verbs (and the whole node-side plugin
                                   # concept) are GONE — see below.
subshell unenroll [--yes] [--json] # stop being a node: deletes daemon.lock THEN
                                     # config.json (the node key's only home — config
                                     # LAST, the reset chain's resumability rule), and
                                     # NOTHING else. A LIVE DAEMON IS ALWAYS REFUSED —
                                     # `--yes` cannot buy it (the daemon holds the
                                     # config in memory and rewrites the lock; deleting
                                     # under it reports an online node as removed).
                                     # Live SUBSHELLS (listed `name · id · cwd`; the
                                     # `maintenance on` census protocol — fail-closed
                                     # on an unanswerable tmux, text even under
                                     # `--json`, exit 1 is the contract) are what
                                     # --yes accepts ORPHANING for: nothing in this
                                     # verb signals anything. A dead lock naming
                                     # ANOTHER node is left standing (`status`'s rule),
                                     # reported `kept` under `--json`. Data dir,
                                     # binary and service definition stay, and the
                                     # plane's node row stays until its owner deletes
                                     # it there.
subshell run                       # foreground daemon (what the service unit runs)
                                     # NOTE: there is no `subshell plugin` command anymore
                                     # (inversion spec 2026-09-10 §6, Task 7). The node
                                     # holds no plugins: harnesses live on the control
                                     # plane, launches carry the plane-built argv, and
                                     # binary detection is the plane's `detect` command.
                                     # A leftover <dataDir>/plugins/ directory is inert
                                     # residue — NOT seeded, NOT refreshed, NOT deleted.
subshell service install [--no-autostart]
                                   # systemd user unit / launchd agent. The service
                                     # is STARTED either way; --no-autostart decides
                                     # only the next login
                                     # (see `apps/node/agent/docs/service.md`)
subshell service uninstall         # remove it, from either location
subshell service status [--json]   # what the service MANAGER reports; always exits 0
subshell service start|stop         # drive an installed service; never installs one
subshell service restart [--force]  # --force overrides the refusal to restart a
                                     # definition that would SIGKILL live panes
subshell service autostart on|off [--json]
                                     # arm or disarm login start for an INSTALLED
                                     # service; refuses when there is no definition,
                                     # and touches nothing that is running
subshell maintenance on [--yes]    # take this node out of service (spec 2026-09-14):
                                     # it keeps answering every other command and
                                     # launches nothing. `on` STOPS every subshell
                                     # running here — so without --yes it lists them
                                     # (name · id · cwd), refuses with exit 1 and
                                     # writes NOTHING. No prompt HERE — `maintenance`
                                     # asks nothing, the same shape `service restart
                                     # --force` has. (`run()` as a whole is no longer
                                     # promptless: `setup` asks one question through
                                     # RunDeps.prompt, injected by tests.)
subshell maintenance off           # back in service
subshell maintenance status [--json] # what THIS machine's mirror says; always exits 0
subshell status [--json] [--probe] # lock-file truth; --probe DIALS the plane and
                                     # newest-wins KICKS a running node — warned loudly
subshell update [--check] [--to <v>] [--from <file>] [--force] [--yes] [--json]
                [--no-restart]     # replace THIS binary with a newer one and restart
                                     # into it. See apps/node/agent/docs/update.md. --rollback is a
                                     # FLAG rather than a subcommand: it is the same
                                     # verb pointed backwards, and a subcommand would
                                     # invite `update rollback --to 0.8.0`
subshell update --rollback [--yes] [--json]
subshell mcp                       # stdio MCP server for a subshell pane (internal;
                                     # configured purely by the SUBSHELL_* pane env)
subshell report attention turn_complete|needs_attention|resumed
subshell report session            # out-of-band reporting from a harness HOOK, which
                                     # runs on THIS machine — where the only program
                                     # guaranteed to exist is this binary. Same pane-env
                                     # contract as `mcp`, but an incomplete env is a
                                     # silent exit 0 rather than a usage error: nobody
                                     # typed this, and a hook's stderr and exit code land
                                     # in the user's own session. A `turn_complete`
                                     # report reads the hook's stdin payload and stays
                                     # silent when it names running background work or
                                     # scheduled crons — a session parked on a subagent
                                     # does not claim to be done (spec 2026-09-23).
                                     # `resumed` is the waiting CLEAR and reads NO
                                     # stdin — its payloads are the prompt text and
                                     # the tool input (2026-09-24). The verb and kind
                                     # slots are FREE BY DOCTRINE: an unknown word is
                                     # answered with a silent 0, never exit 2 — a
                                     # rejected hook blocks the pane, and a plane
                                     # newer than this binary legitimately emits words
                                     # compiled after it. Presence is still enforced.
                                     # See mcp-core report.ts
subshell version                   # also `--version` / `-v` — aliased in the
                                     # COMMAND slot only, since argv[0] IS the
                                     # command here (`status --version` stays an
                                     # unknown flag, because it is a typo)
```

`status --json` also carries a `paths` block (`{ configFile, lockFile,
dataDir, binary, agentLog }`, all absolute) beside the fields above, present
whether the node is online or offline (it names the loaded config, not
liveness). It exists so the client desktop app's reset deletes exactly what
THIS CLI names, never a path the app derived itself, the same rule
`subshell-server status --json`
follows for its own reset (design: `docs/superpowers/specs/2026-09-11-native-reset-both-desktop-apps-design.md`
§5.1). The block is absent when no config loaded (the not-enrolled branch):
there is no `dataDir` to name, and a reset with nothing enrolled has nothing to
delete. As with every other field here, the node key is never included,
`--json` or not.

**Two of those five are NOT deletion targets, and the block is read key by key
so that can be true.** `binary` is the installed CLI (spec 2026-09-15 §5.2),
and `agentLog` (2026-09-18) is the node's own capped log, reported so the
desktop can REVEAL the same file the plane's log view serves, deliberately not
deleted: it is the record of the reset itself, holds no credential, and is
bounded at 200 KB whatever happens to it. `parse_delete_plan` in
`apps/client/desktop/src-tauri/src/reset.rs` names `configFile`, `lockFile`
and `dataDir` individually rather than sweeping the block, and a test on each
side pins that, so a key added here later is inert on the reset by default,
which is the only way this field could be added at all.
