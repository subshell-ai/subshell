# SSH support: remote runtime over SSH

Revised: 2026-10-05.
Status: corrected product direction; transport design and implementation pending.
Reviewed implementation: PR #330, head `f18f168724505f840831ad3f1f494c6112716798`.

## 1. This supersedes the previous design

The user clarified the intended experience: select an SSH host, start the Subshell
runtime on that host through SSH, select a remote directory, and work there. The
remote machine has Subshell installed. SSH carries the ongoing runtime connection.

The previous document instead kept the agent on an existing node and gave it tools
for executing commands on an ordinary SSH destination. PR #330 implements that
older model. That is an architectural mismatch, not something fixed by moving the
settings page or improving its copy.

This document replaces the previous implementation mandate. A separate SSH command
runner, destination grants per agent pane, and dedicated SSH execution tools are
superseded. Earlier security reviews do not certify the replacement architecture.
Do not merge PR #330 as satisfying this revised experience. Preserve useful work
selectively; do not blindly revert the branch or delete local test data.

Current authorized work is updating this plan and the PR instructions only. The
implementation rework has not been requested in this session.

## 2. Reference experience and product contract

The [official Codex SSH documentation](https://learn.chatgpt.com/docs/remote-connections#connect-to-an-ssh-host)
describes discovering concrete aliases in `~/.ssh/config`, requiring Codex installed
and authenticated remotely, starting its app server there through SSH, and selecting
a remote project folder. It also documents managing that app server through SSH.

This is the familiarity target. The documentation establishes a workflow, not the
reliability of our implementation or Codex's precise internal transport. Do not
claim automatic installation, identical wire protocols, or identical reconnection
semantics without evidence.

### Primary user journey

1. Choose **Connect over SSH** in Subshell Client or the web UI.
2. In the desktop client, use this computer's SSH setup. In the web UI, select
   an eligible existing node to make the connection. Select a host from that
   initiating machine's existing SSH configuration.
3. Check that the remote `subshell` runtime is installed and compatible.
4. Start the runtime through SSH and choose a remote directory.
5. Choose an installed agent harness/preset or a terminal and launch it **on that
   remote machine**.
6. Work with ordinary Subshell panes and workspaces, with the remote host and
   directory clearly visible.

Saved hosts and recent directories are appropriate conveniences. A personal
Connections view may manage them. An administrative SSH configuration and grant
management workflow is not the primary experience.

There is no required **Add node**, enrollment key, daemon service installation, or
remote callback connection to the server. Internal execution-target records may
reuse node machinery without exposing fleet enrollment as a prerequisite. In our
vocabulary, the remote program is the `subshell` node/runtime binary, not the
Subshell Client desktop application.

### Confirmed scope and defaults

- Support both user-confirmed origins: Subshell Client using its local OS account,
  SSH configuration, and credentials; and the web UI using an existing node's
  account/configuration/credentials. The browser never reads laptop SSH files.
  The web flow labels the connecting machine explicitly and selects it before
  listing aliases. Only actual owners can broker through enrolled nodes; the
  built-in server node requires an admin and its existing launch/maintenance gates.
  Node sharing or an admin boost on somebody else's node does not confer use of
  that OS account's SSH credentials. Explain unavailable choices without weakening
  server-side authorization.
- Require a compatible remote runtime for the initial milestone. If missing, give
  installation guidance for the binary alone; never send users through enrollment
  or `subshell setup`. Automatic deployment/upgrades need separate signed-artifact
  handling and explicit user action, and are not assumed Codex parity.
- Agent CLIs and their authentication live on the remote host. Surface missing
  requirements honestly; never run the agent locally as a fallback or copy local
  agent credentials automatically.
- Linux/macOS destinations first. Retain the earlier keys-only baseline unless
  explicitly revised. Do not add password/key-unlock forms inside recorded panes.
- The existing control plane remains the authority for panes/workspaces; no second
  control plane is required on the destination.
- Remote directory selection and ordinary agent access to remote files are v1
  capabilities. Cross-host synchronization, conversation handoff, shared hosts,
  Windows destinations, and unattended persistent services are later scope.

## 3. Architecture requirements

### Start a remote runtime and keep SSH as the transport

Add a session-scoped mode to the existing `subshell` binary. A connection broker
in Subshell Client or an existing node starts it through SSH and carries a framed
runtime protocol over that connection.
Reuse node command executors, pane runtime, plugin detection data, and NodeLauncher
interfaces where sound. Remote files, tools, PTYs, and agent processes belong to
that environment.

The runtime must start without enrollment configuration, node bearer keys, service
installation, or inbound network listeners. SSH is the ongoing runtime transport,
not an installer for the existing outbound WebSocket daemon. An internal adapter
is appropriate; silently requiring direct remote-to-server connectivity is not.

The web path is browser → control plane → existing connecting node → SSH → remote
runtime. The existing node's authenticated link relays the session; the destination
does not enroll or create its own server connection. Desktop initiation uses the
native broker instead. Both paths share the same remote runtime and capabilities,
and both show the origin machine when it matters to connectivity or credentials.

### Preserve desktop privilege separation

`apps/client/desktop/AGENTS.md` documents that the server-loaded main window has
only `desktop_open_in_browser`; privileged actions live in trusted bundled/native
code. Keep that boundary. Local host discovery and SSH process creation must not
be exposed as arbitrary commands to server-loaded or redirected web pages.

Bind the broker connection to an explicitly selected control plane, authenticated
user, SSH host, and runtime session. An alias or runtime ID is not a credential.
Do not let an unauthenticated webpage reuse local SSH access.

### Route remote MCP and hooks through the session

The current node daemon dials `/ws/node` with enrollment credentials, while
`packages/mcp-core` calls the control plane over HTTP. The replacement must address
both assumptions. Remote pane MCP, reporter hooks, logs, lifecycle events, and
filesystem operations need an authorized path through the runtime/broker session.
No direct network route from the remote host to the control plane is required.

Preserve per-pane identities and normal permission checks. Do not put a full server
credential on the destination or introduce an unauthenticated/general-purpose proxy.
The precise broker/server authentication and callback protocol are Gate A work.

### Ordinary capabilities in a remote environment

Launch agents/terminals, browse remote directories, attach/read, interrupt, resume
where supported, and terminate through the ordinary session model. Agents use
their normal filesystem/shell tools on that host. `execute_ssh_command` is not the
required way to work in a remote project. Directory browsing is part of setup,
not an optional later file-transfer feature.

## 4. Security and lifecycle constraints

- SSH keys, authentication agents, and configuration stay on the initiating
  computer. Preserve host-key verification; never auto-accept changed keys or send
  private keys to the control plane or agent prompts.
- SSH configuration is trusted executable local configuration. Alias discovery
  should not execute it; resolution is a user-initiated action. Do not carry over
  the old server-side configuration snapshot ceremony merely because it exists.
- Support ordinary host/user/key and ProxyJump configuration. Enforce the session
  policy against unintended agent/X11 forwarding, configured port forwards, escape
  commands, local commands, and ambient control-socket reuse. Unsupported required
  settings need clear errors, not silent behavior changes.
- Scope runtime authorization to user, control plane, host, and session. Authority
  to establish a runtime does not authorize arbitrary local commands or access to
  another user's runtime.
- Use bounded framing and queues. Runtime stdout is protocol-only and stderr is
  diagnostic. Login banners, startup output, malformed frames, wrong versions, and
  oversized messages must fail safely.
- Use explicit argv and correct quoting through the remote login-shell boundary.
  Paths are data, not executable fragments.
- Preserve the existing OS-account trust boundary; SSH runtime mode is not an OS
  sandbox. Treat all remote output as untrusted data.
- Disconnect means unavailable, not successful completion. Never replay launch,
  input, or other mutating operations automatically after an uncertain result.
- Reconnect must reconcile session-owned resources, not duplicate panes or kill
  unrelated processes. Establish close/orphan behavior explicitly before promising
  process survival. Session runtime must coexist safely with any enrolled daemon
  already on the same machine, using isolated ownership/artifact namespaces.
- Bound logs, storage, reconnect work, and subprocess resources. Keep private file
  permissions and avoid credentials/command/output payloads in operational logs.
- Keep normal user/pane authorization. Removing the old destination-grant UI does
  not make remote runtimes accessible to every account or shared pane.

## 5. Disposition of PR #330

| Existing work | Required disposition |
| --- | --- |
| Admin SSH destination page and grants workflow | Replace with personal host selection, remote folder choice, and normal launch |
| Per-pane destination grants/coarse SSH-command token permission | Retire with the old product; establish runtime/session ownership instead |
| Dedicated execute/read/cancel SSH-command and open-SSH-terminal API/MCP families | Remove/replace as transport integration lands; ordinary remote panes are the primary interface |
| One-shot SSH command supervisor and independent run database | Not the replacement runtime; salvage bounded subprocess/diagnostic primitives selectively |
| SSH discovery, diagnostics, safe argv, isolated sshd fixtures | Reuse where compatible with the initiating-client architecture |
| Snapshot, grants, run tables and old routes | Inventory and retire explicitly; no dead security gates or stray reachable APIs |
| Terminal input fencing, timeout/unknown-result handling, bounded scanning | Independently useful; keep with tests or split into a focused PR |
| Presetless terminals, cursor reads, node archive transfer already on main | Keep; do not revert baseline capabilities |
| Agent-created labeling | Keep where it describes helper-pane provenance accurately |
| Old SSH docs, tests, changesets and PR description | Rewrite around the actual replacement; old passing tests do not prove alignment |

Although unreleased, branch migrations may already exist in development/test
instances. Inspect persisted state before removing/replacing migrations; never
reset databases or delete artifacts simply to make the redesign compile. Follow
the exact node-protocol version policy and release workflow. Reassess the old
protocol-16 changes instead of assuming their wire contract remains suitable.

The earlier PR UX review's state-reset and misleading-copy findings remain relevant
where code is reused. Its sidebar relocation and grants-dialog polish are no longer
a sufficient correction; the architecture is superseded.

## 6. Multi-agent delivery with a design gate

This is a corrected product contract, not a claim that the transport design is
already decision-complete. Complete Gate A before parallel implementation.

### Gate A: freeze and prove integration

The coordinator must document and validate:

1. Both initiating paths and their trusted host-selection entry points.
2. Authenticated broker/control-plane binding without relaxing remote-webview ACLs.
3. Runtime framing/version negotiation, command/event mapping, and resource IDs.
4. Remote MCP/reporter callback routing through the active SSH session.
5. Ownership, disconnect/reconnect/close behavior, and orphan cleanup.
6. Missing runtime/version UX and migration of old-model development state.

Prove a vertical slice on an SSH fixture with no enrollment configuration and no
network route from destination to control plane: connect, browse, launch a remote
terminal/agent, attach, and perform an authorized MCP round trip. Model-provider
network access is separate; blocking Subshell connectivity does not imply offline
inference. Do not bypass this gate by enrolling the destination or adding an
arbitrary tunnel. Return unresolved product choices to the user.

### Workstreams after contract freeze

| Agent | Exclusive work | Acceptance/dependencies |
| --- | --- | --- |
| Coordinator | Design, shared wire contracts, registries, migrations, protocol decisions | Gate A; assign ownership before any shared-file edits |
| Remote runtime | Session runtime mode, executor adapter, framing, remote process lifecycle | Gate A; no enrollment/service requirement |
| Connection brokers | Trusted desktop host picker/native SSH lifecycle and existing-node SSH broker handlers | Gate A; shared runtime transport, owner-only node brokerage, preserve remote-webview privilege boundary |
| Control-plane adapter | Session-owned targets, launcher/events, web-origin broker dispatch, scoped callback proxy | Gate A; ordinary permissions, no destination callback connectivity |
| UX/MCP integration | Host/folder selection, normal launch/attach, actionable errors, docs | Frozen broker/adapter API; no destination-grant ceremony |
| Verification | SSH fixtures, races, security, native/browser acceptance, compiled smoke | Fixtures after Gate A; independent integrated acceptance |

Use at most three workers plus the coordinator. Start runtime/broker/adapter work
in parallel after Gate A; follow with UX/verification and focused fixes. Only the
coordinator edits shared registries, protocol barrels, migration allocation, and
central integration files. Workers deliver changed-file lists, tests, integration
needs, and unresolved concerns. Preserve other agents' changes and unrelated
untracked acceptance artifacts.

## 7. Acceptance and release evidence

The feature matches the requested experience only when a user can select an SSH
host, start a compatible installed remote runtime, choose a remote directory, and
launch the agent there using normal Subshell panes/MCP. No node-enrollment/service
workflow, per-destination grants for another running agent, or remote-to-server
connection is required.

Verify this separately from desktop-local SSH and from a non-admin web user through
their owned existing node. In the latter flow, having a pre-existing connecting
node is intentional; enrolling the SSH destination is not. Block destinations from
contacting the control plane during both tests while permitting their necessary
agent-provider traffic.

Test missing runtime, incompatible version, missing remote harness/authentication,
invalid directory, host-key refusal, jump hosts, malformed startup output,
cross-account access, broker/webview boundaries, dropped acknowledgements,
disconnect/reconnect, duplicate prevention, stale input, quotas, and cleanup.

Use temporary SSH fixtures and the isolated e2e stack, never live :3080. Run
package scripts with `env -u SHELLOPTS -u BASHOPTS`, capture failures once, and run
type/lint/license checks. Native changes require repository Rust checks. Include
compiled-runtime and desktop packaging smoke coverage. Read
`docs/release-and-ci.md` before artifact/release work; releases remain separately
authorized.

Record a walkthrough of host selection, remote folder choice, remote agent launch,
missing-runtime guidance, and disconnect/reconnect. Review that actual journey
against this document before declaring implementation complete.

## UX revision: remote work in the ordinary launch flow (2026-10-06)

The primary tasks are starting work in a remote folder, returning to a project,
adding remote panes to a workspace, and recovering a dropped connection. A
standalone SSH wizard is not the primary navigation for those tasks.

- New subshell and workspace pane creation offer **SSH host** as a location.
  Pick a connected host or connect a new one, choose its folder, then choose an
  agent or terminal installed there. The usual launch action owns creation and
  workspace attachment. Presets change agent settings without moving the selected
  remote host or importing a path from a different filesystem.
- The connection origin is explicit: the browser uses an owned enrolled machine,
  or, for admins only, the server account subject to its launch/maintenance gates.
  The destination needs the runtime binary, not enrollment. Native desktop account
  access remains behind the bundled window's existing privilege boundary.
- Keep `/connect` as secondary **SSH connections** management, reachable from
  launch and disconnected panes; remove its primary sidebar item. Reconnection
  uses the existing adoption logic. Disconnecting keeps destination panes running
  and the confirmation must say so.
- Keep session creation separate from pane creation internally. Cancelling a
  launch after connecting leaves a reusable connection in the personal list.
  Switching locations clears machine-specific paths; no failed SSH launch may
  fall back to the server or a previously selected machine.
- Acceptance includes a non-admin SSH launch from the regular dialog, reuse from
  a workspace without navigation or another connection, a missing-runtime remedy,
  and server-origin authorization and cleanup regressions.
