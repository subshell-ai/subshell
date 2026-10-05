# SSH remote runtime: Gate A design (contract freeze)

Revised direction from `SSH-SUPPORT.md` (2026-10-05): select an SSH host, start the
Subshell runtime on that host through SSH, choose a remote directory, and work there
with ordinary panes. This document freezes the contracts §6 requires before parallel
implementation. Supersedes the destination-execution model shipped on this branch
(PR #330's product shape); the salvage list is §5 of the plan.

## 1. Shape

```
browser -> control plane -> connecting node (enrolled, owner's machine)
        -> ssh child (policy-rendered) -> `subshell runtime-serve` on the destination
```

The runtime is a session-scoped mode of the existing `subshell` node binary. It
behaves like a node whose link is the SSH child's stdio: it drives tmux on the
destination, owns pane logs, and answers the same command/event semantics. No
enrollment config, no node key, no service, no network listener on the destination.
The SSH child dies, the session ends; the tmux server and its panes survive on the
destination (tmux outlives its clients) and the next session reconciles them.

**Both origins are covered by one broker.** The web path selects an eligible
connecting node. Subshell Client's own machine is exactly such a node, so the
laptop experience is the same flow with the client's node chosen; nothing new is
exposed to any server-loaded webview (desktop privilege separation untouched). The
Server assistant gains no SSH commands.

## 2. Framing and negotiation

Transport: the SSH child's stdin/stdout, 4-byte big-endian length prefix + one JSON
frame, `MAX_SESSION_FRAME_BYTES` = 262144, inbound queue bounded (128 frames;
overflow closes the session fail-closed). stdout is protocol-only; stderr is
diagnostic text forwarded to logs without interpretation. Login banners and
malformed leading bytes fail the open, never a silent skip.

Hello (first runtime frame): `{ type: "hello", runtimeProtocol: 1, agentVersion,
os, arch, capabilities, homeDir, dataDir, tmuxSocket, paneCount }`.
Plane refuses a major mismatch by name. `runtimeProtocol` is its own version
namespace; the node link family is unchanged in content, but the new commands and
events bump `NODE_PROTOCOL_VERSION` to 17 with `MIN_NODE_VERSION` raised in step
(exact-match gate, both sides released together).

Plane-to-runtime command frames mirror the node command bodies the runtime needs,
minus crypto: `launch` (terminal or presetless harness argv under the runtime's
tmux), `input`, `terminate`, `kill`, `capture`, `log_read`, `tail_start/stop`,
`list_dirs`, `subshells_report`, `close`. Runtime-to-plane event frames mirror
`NodeEvent`: `result{ref}`, `output`, `exit`, `subshells_report`, `rest_response`.
The runtime reuses `TmuxRunner`, `pane-log` self-invoke, exit watcher, and the
executors in `apps/node/agent/src/commands/` under a shared runtime core extracted
from the agent; the daemon keeps its own dispatch over the WS link.

## 3. Broker (connecting node)

New node command family `ssh_session_open/send/close` (protocol 17):

- `ssh_session_open { ref, target: { alias, host, port, user, identityFile? } }`:
  the agent first probes the runtime (`sh -lc "command -v subshell"`, short RPC over
  the same policy render); absent answers `SSH_RUNTIME_MISSING` with install
  guidance for the binary only. Present: spawn via the salvaged
  `buildSshInvocation` + `renderSshConfigContents` (mandatory deny-by-default
  policy, `HostKeyAlias`, ProxyJump, BatchMode, keys-only) with the remote command
  `subshell runtime-serve --session <id>` composed through the existing
  `remoteCommandLine` quoting. The child leads its process group
  (salvaged `killGroup`). Bounded pump: child stdout frames sealed into new
  `NodeEvent` arm `session_frame { ref, data_b64 }` (size-capped, backpressured by
  `bufferedAmount` like the tail pump); plane sends `ssh_session_send { ref,
  data_b64 }` for runtime stdin. The supervisor lives beside `SshRunSupervisor`
  with the same durable-accept, deadline, and boot-reconcile posture; at agent
  exit the child goes with it.
- Open result carries the parsed hello plus the real `host:port` and account.
  Identity files, config contents, and key material never enter any frame or row.

Frame routing is by `ref` (plane-minted uuid). A frame naming another node's or
another session's ref is dropped; the node keys children by ref, one SSH child per
session.

## 4. Plane: sessions as execution targets

New tables (migration 0049): `ssh_runtime_sessions` (id, owner_id,
connecting_node_id, alias, host, port, user, status `opening|active|lost|closed`,
hello facts JSON, created/last_seen/closed) and hidden `nodes` rows with
`kind = 'runtime'` (owner-only, no node key, never listed by `GET /api/nodes`,
never dialable, never enrolled). Panes keep the ordinary `subshells` row with
`nodeId` set to the runtime node, so list/detail/log/live/ws all stay normal.

`launcher-registry.ts` gains a branch: a `runtime`-kind node resolves to a new
`RuntimeSessionLauncher` implementing the existing `NodeLauncher` interface; it
serializes launch/input/tail through §3's frames instead of signed WS commands.
`RemoteLauncher` stays untouched.

Authorization: opening a session requires the caller to **own** the connecting
node (salvaged `sshNodeGate`: real owner, no admin boost, no share; `local` keeps
its admin gate in-process). The session row carries `owner_id`; every pane created
through it belongs to that user; cross-account frames are impossible because refs
resolve only within the caller's sessions. Sharing follows ordinary pane sharing,
nothing session-level.

## 5. MCP and reporter callbacks through the session

The runtime serves its panes' callbacks on a private unix socket
`<runtimeDataDir>/callback.sock` (0600, mode-pinned, no network bind): the one
listener class permitted by "no inbound network listener", inside the destination
OS-account boundary.

- `subshell mcp` on the destination detects `SUBSHELL_RUNTIME_CALLBACK_SOCK` and
  routes its single `ToolApi.req` seam over the socket to the runtime as
  `rest_request { reqId, method, path, body }` frames. The runtime forwards them
  bounded; the plane executes the path **as the pane's own subshell token**, which
  the plane minted at launch and never transmits. Only paths the pane could call
  with its own token pass (`/api/subshells/<own id>/*`, extend, identities,
  channels): a fixed allowlist of prefixes with the pane's id substituted, not a
  general proxy. Responses ride `rest_response` back.
- Exit and reporter hooks (`subshell report`, exit-hook) ride the same pipe; they
  already speak the same token.
- The token itself never leaves the plane; the destination never learns the plane
  URL as a network requirement. Blocking destination-to-plane connectivity is a
  supported configuration and must be tested.

## 6. Lifecycle

- **Disconnect**: SSH child dies (network, user, reboot) -> broker reports close,
  plane marks the session `lost` and its runtime node offline. Panes read
  `alive:0` with status intact: unavailable, not completed. No launch, input, or
  mutating frame is ever replayed; uncertain results surface as `unknown`
  (salvaged exit-255 honesty posture).
- **Reconnect**: user reopens the same destination (recent aliases are rows
  history); runtime reconciles by listing the destination tmux socket named
  deterministically per destination (`subshell-ssh-<hash of host:port:user>`), so a
  second session on the same machine finds the first session's panes; plane matches
  reported pane ids to existing rows (idempotent restore, duplicates impossible
  because pane ids come from the rows).
- **Close**: `subshell runtime-serve` exits after forwarding its final report;
  tmux server and panes keep running under the destination user. Killing panes is
  an explicit terminate, never an implicit close side effect.
- Coexistence: the runtime's tmux socket namespace, dataDir subdirectory
  (`<dest dataDir>/runtime/`), and log dir are isolated from any separately
  enrolled daemon's artifacts on the same machine.

## 7. Selection UX and the missing runtime

One personal flow, not an admin surface: **Connect over SSH** -> pick the
connecting node (labeled with its machine name and OS account) -> pick an alias
(salvaged `discoverSshAliases` on that node) -> Resolve shows the concrete
`host:port user` and Test proves reachability + runtime presence -> pick a remote
directory via `list_dirs` browsing on the live session -> launch (preset or
terminal) exactly as on any node. Saved destinations are personal conveniences.
Errors name the remedy: `SSH_RUNTIME_MISSING` prints the binary install pointer
(never `subshell setup`/enrollment), a version mismatch names the compatible
range, a host-key refusal says who must fix it. Old admin SSH page, grants
ceremony, run API, and the ssh MCP family retire in the same change that lands
the replacement (inventory in §5 of the plan; migrations 0047/0048 dropped by
0050 after inspecting dev instances; this instance base is single-user, so no
data-preservation burden, but the drop ships, it is not a silent revert).

## 8. Security invariants carried over

Keys, agents, and config stay on the connecting node; host-key verification is
mandatory (policy render unchanged); frames bounded and fail-closed; explicit
argv with per-token quoting through the login-shell boundary; remote output is
untrusted data; no server credential on the destination; per-pane token identity
for MCP preserved; authority to open a session grants nothing beyond the caller's
own panes.

## 9. Gate A proof (vertical slice, in-repo, fixture sshd)

Extend `e2e/fixtures/sshd.ts` destination: no enrollment config, plane unreachable
from the destination's network namespace expectation. Scenario: open session
through the connecting node -> list dirs -> launch a terminal pane -> attach and
type (output bytes land in the runtime pane log on the destination) -> MCP round
trip: from inside the pane, one call through `callback.sock` (a `curl --unix-socket`
in a terminal, or the runtime-side test harness) resolving as the pane's own token
-> terminate. Protocol 17 handshake assertion on the fixture link. This slice is
the acceptance gate for workstreams R/B/C; it does not require the UX.

## 10. Workstream contracts

- **R (remote runtime)**: `runtime-serve` verb on the node CLI extracting the
  shared runtime core (tmux, executors, logs, exit watcher) from `apps/node/agent`;
  framed stdio + hello + callback socket. Owns: `apps/node/agent/src/runtime/`.
- **B (broker)**: `ssh_session_*` commands, session supervisor, protocol 17.
  Owns: `packages/subshell-protocol/src/ssh-session-frames.ts`,
  `apps/node/agent/src/commands/ssh-session.ts`.
- **C (control plane)**: session tables/registry, `RuntimeSessionLauncher`,
  callback execution allowlist, retirement of old doors (routes, MCP tools,
  tables, policy scopes, docs). Owns: `apps/server/api/src/services/ssh-runtime/`,
  migrations 0049/0050, `packages/mcp-core` ssh removal.
- **U (UX/docs)**: Connect-over-SSH flow in the SPA on frozen APIs, docs rewrite.
  Only the coordinator edits shared registries (`routes.ts`, `commands/index.ts`,
  `node-frames.ts` unions, `migrate.ts`) by applying worker-supplied hunks.
