# Node CLI implementation contracts

Command syntax and user procedures are maintained in the
[public node CLI reference](https://docs.subshell.sh/reference/node-cli).
This note records implementation and integration constraints for `src/cli.ts`,
which uses a hand-rolled parser rather than a flag library.

## Setup and identity

`setup` performs the tmux preflight, asks for the node name, calls the `enroll`
primitive, and then offers service installation. This is the installer script's
headless entry point. Prompts are injected through `RunDeps.prompt` for tests.
`enroll --json` returns `nodeId`, `serverUrl`, `name`, `dataDir`, and
`configPath`; never emit the node key.

`configure` edits an existing enrollment and preserves `nodeId` and
`controlPublicKey`. A server-address change clears `nodeWsUrl`; a key-only edit
keeps it. At least one edit is required, and a setup key beginning with `nsk_`
is refused. It neither spends a setup key nor creates a second node row.
Restart to apply changes. See [repointing](repointing.md) and
[node naming](node-name.md). There is no `--name` or `--registry-url` option.

The node owns no plugin installation commands or plugin store. Launches carry
server-built argv and detection is requested by the server. An old
`<dataDir>/plugins/` directory is inert residue: do not seed, refresh, or delete
it as part of normal startup.

## Destructive operations

`unenroll` deletes `daemon.lock` before `config.json`, with configuration last
so an interrupted operation remains resumable. It always refuses a live daemon,
even with `--yes`, because that daemon retains credentials and rewrites its lock.

Live panes require explicit consent to orphan them; the command signals none.
Use the maintenance census (`name`, ID, working directory), fail closed when
tmux cannot answer, and print the census to stderr even under `--json`, with
exit 1 on refusal. A dead lock belonging to another node remains and is reported
as `kept`. The binary, service definition, data directory, and server node row
remain after unenrollment.

`maintenance on` sets the maintenance flag before stopping panes. Without
consent it lists live panes, exits 1, and writes nothing. It does not prompt.
See [maintenance reconciliation](maintenance.md) for failure and recovery rules.

`reset` and `uninstall` require machine-name consent; noninteractive callers use
`--confirm`, not `--yes`. Reset retains the installed binary. Uninstall retains
data unless removal is separately selected. Keep these distinctions visible to
the desktop reset integration.

## Services, status, and updates

Service installation requires enrollment. It starts the service even with
`--no-autostart`; that option controls the next login. Start and stop operate
only on an installed definition. Changing autostart never changes the current
process. Restart refuses a definition that could kill live panes unless the
caller supplies `--force`. See [service-manager details](service.md).

Service status and maintenance status always exit 0; their JSON describes the
manager or local mirror respectively. Node `status` normally reads lock-file
truth. `--probe` opens a server connection and can evict a running daemon through
the newest-connection-wins rule; preserve its warning.

Update rollback is the `--rollback` flag, not a positional subcommand. Reject
incompatible target options rather than accepting an ambiguous rollback request.
See [update transaction details](update.md).

The dashboard is loopback-only and has no authentication token. It can run
without the daemon. See [dashboard boundaries](dashboard.md).

## Machine-readable paths

When configuration loads, `status --json` includes absolute `paths` fields:
`configFile`, `lockFile`, `dataDir`, `binary`, and `agentLog`, regardless of
liveness. Omit the block when unenrolled; never disclose the node key.

The desktop reset consumes these paths rather than deriving them.
`parse_delete_plan` in `apps/client/desktop/src-tauri/src/reset.rs` explicitly
selects `configFile`, `lockFile`, and `dataDir`. `binary` and `agentLog` are not
deletion targets. The capped log is retained as the record of reset. New fields
must remain inert for deletion by default; tests on both sides enforce this.

## MCP and harness reporting

`mcp` is a long-running stdio server configured through the pane's `SUBSHELL_*`
environment. `report` runs on the pane machine through the host-resolved binary;
never assume Bun or the server binary exists there.

Incomplete reporting environment and unknown report verbs or attention kinds
must silently exit 0. A hook's failure can block the user's session, and a newer
server can emit words an older node does not recognize. Required argument slots
are still checked. See `packages/mcp-core/src/report.ts`.

`turn_complete` reads stdin and suppresses completion when the payload describes
running background work or scheduled crons. `resumed` clears waiting state and
reads no stdin: its payload may be prompt text or tool input. Session reporting
reads the harness session ID from stdin.

`--version` and `-v` alias `version` only in the command slot. A flag such as
`status --version` remains an unknown flag rather than silently changing the
requested operation.
