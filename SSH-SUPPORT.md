# SSH support: design and multi-agent implementation plan

Date: 2026-10-04. Status: proposed; not implemented.
Baseline: `main` at `a55c5f5d`, after terminal sessions (#328), terminal exec
(#319), and node-to-node archive transfer (#317).

This is the implementation handoff and security design for the feature. Public
user procedures belong in `apps/docs/content/docs/` when the feature ships.
Historical specs describe earlier decisions; this document changes the terminal
execution and agent-access decisions explicitly. It does not claim those changes
already exist.

## 1. Outcome and settled scope

An agent running in Subshell can operate a Linux or macOS destination over SSH
without installing Subshell or an agent CLI there. A human configures a private
connection, grants selected agent panes access, inspects results, and can take
control of an interactive terminal.

V1 includes saved connections through existing nodes, existing SSH keys and
certificates, connection testing, structured commands, incremental output,
cancellation, and interactive terminals in the server SPA. The same SPA serves
browser and desktop-client users; this requires no new privileged command in the
desktop window that displays the control plane.

Decisions confirmed by the user:

- Reuse credentials on the connecting node; do not build credential storage.
- Keep connections private in v1.
- Support Linux/macOS destinations and POSIX command syntax first.
- Put remote file operations in the next milestone.
- Require human-issued grants for individual agent panes and connections.
- Require key-based authentication in v1. Passwords, MFA entry, key unlocking,
  and host-trust setup occur outside Subshell on the connecting node.

Also deferred: Windows destinations, connection sharing, persistent remote
sessions, remote agent launch, and conversation handoff. Ordinary interactive
applications remain possible, but a terminal is not a private secret-entry form.

Codex provides the UX reference: discover SSH hosts and select a remote project.
Its documented workflow requires Codex installed and authenticated remotely;
this design keeps the agent on an existing node instead. See the
[official SSH workflow](https://learn.chatgpt.com/docs/remote-connections#connect-to-an-ssh-host).

### Existing features to keep

Keep the terminal plugin, presetless terminal launches, `create_subshell.harness`,
catalog entries in `list_presets`, byte-cursor log reads, raw input, lifecycle
tools, encrypted agent channels, and enrolled-node `transfer_files`. The harness
field and catalog now serve presetless terminal discovery; earlier suggestions
to remove them no longer apply.

Rename the visible "Cross-agent comms" grouping to **Agent-created**. Keep its
provenance flag, silent creation, and cleanup responsibility. No database-column
rename is required. Correct MCP instructions that describe every pane as an
agent. The obsolete preset-name launch instruction was already fixed on main.

## 2. Security model and required protections

The existing [security model](docs/security.md) is the baseline. The controls
below protect Subshell APIs; they do not sandbox a process that already runs as
the connecting OS account. Such a process may independently run SSH or read that
account's files. Compromised OS accounts, malicious administrators, and a
compromised control plane remain outside the existing trust boundary.

The destination account determines command permissions. A remote working
directory is not a filesystem restriction. Arbitrary remote shell access also
permits network access and privilege use available to that account.

| Design risk | Required mitigation |
| --- | --- |
| Every existing agent silently gains access to SSH credentials | Explicit SSH token permission plus a human-issued per-pane, per-connection grant; no legacy permission fallback |
| Generic pane APIs bypass connection permissions | One SSH authorization policy used by all REST, WebSocket, preview, log, lifecycle, and sharing surfaces |
| Human takeover is mistaken for confidential input | State that takeover controls input, not historical secrecy; defer in-app SSH secret entry |
| SSH config starts local helpers, forwards ports, or reuses ambient connections | Human-only resolution followed by an approved normalized configuration and mandatory runtime restrictions |
| Commands are repeated after an ambiguous disconnect | Durable acceptance before spawn, request binding, reconciliation, and no automatic replay |
| A quiet pane is mistaken for an idle shell | Keep terminal exec explicitly heuristic; use supervised SSH processes for structured commands |
| Output floods memory or disk | Bound accumulation, reads, retention, concurrency, and aggregate storage; drain excess output |
| Remote output impersonates trusted UI | Render output as data and keep authoritative identity/control outside terminal text |

### Ownership and explicit grants

A connection is a resource, not an enrolled node. Only the node owner may
configure connections through an enrolled node. An administrator may configure a
private connection through the server's built-in node, subject to its existing
launch-enabled and maintenance rules. Admin status does not bypass those rules
or grant API access to another user's private connection.

Human configuration, discovery, grants, and control changes require a cookie
session. Validate request origin/CSRF on these writes explicitly; do not assume
cookie authentication alone is sufficient. Machine credentials cannot call them.

A grant binds a connection revision to a pane ID and its current credential
generation (the issued API-key identity). It records the granting human and
revocation state. It permits that pane to read/use that connection, not configure
it. Both a coarse `ssh` permission and this row-level grant are required. Old
tokens receive no grandfathering; a human can restart a pane to obtain a current
token and then grant it access. Child panes and restarted panes inherit nothing.

MCP lists only the connections granted to the caller. Every operation rechecks
the token, pane lifecycle, owner, grant, connection revision, and node eligibility.
Inaccessible resource IDs use the existing non-enumerating 404 convention.

### Generic pane surfaces and revocation

Managed SSH panes remain private even though their rendering and lifecycle reuse
ordinary panes. Gate list previews, detail reads, logs, captures, live updates,
attach-token minting and redemption, input, exec, prompt injection, restart,
termination, deletion, and sharing through the connection policy. Sharing SSH
panes is refused in v1. Same-owner sibling panes need their own grants.

Do not mint MCP credentials or inject Subshell credentials into SSH processes.
Existing machine-minted attach tokens retain their caller identity and are
rechecked against SSH grants and control state when redeemed. Active subscriptions
must also be closed or filtered when permission/control changes.

Revocation prevents new dispatch, rejects queued input, closes affected streams,
and cancels runs/terminals initiated under that grant where reachable. Human-owned
sessions and work initiated under other valid grants are not cancelled. Bind each
resource to its initiating grant/credential so this distinction is enforceable.
Offline cancellation stays pending and is dispatched before new work on reconnect.
Terminating SSH never guarantees remote descendants died.

### Authentication and trust

All managed SSH invocations use noninteractive key/certificate authentication,
including interactive shell sessions. An already-unlocked authentication agent
may be used. Password, MFA, key-unlock, and unknown-host requirements produce
actionable instructions to configure the connecting account outside Subshell.
There is no host-key acceptance endpoint in v1.

Require existing verified host trust. Unknown, changed, and revoked keys fail
closed. Keep certificate/revocation checks and secure algorithm defaults. A key
scan is not identity verification and must never become an automatic trust step.

### Configuration is executable, not passive data

OpenSSH supports local helper execution, forwarding, and multiplexed connections;
see the [OpenSSH configuration reference](https://man.openbsd.org/ssh_config).
Discover aliases by bounded parsing of the account's config and includes; omit
wildcard-only entries, detect include cycles, and allow manual aliases. Discovery
returns names, not config file contents. Resolution/testing is a human action and
must disclose that trusted configuration such as `Match exec` can run locally.

Persist an approved normalized snapshot after resolution. Agent requests accept
only connection IDs, never raw hosts, usernames, ports, SSH options, environment
overrides, config paths, or proxy commands. Render runtime config from an explicit
allowlist; do not let runtime SSH reread ambient user/system configuration.

Supported resolved settings are destination host/user/port, identity and
certificate references, authentication-agent reference, host-trust references
and host-key alias, and a bounded `ProxyJump` chain. Normalize every hop under the
same restrictions. Preserve referenced trust files and their revocation/CA
semantics. Defer arbitrary `ProxyCommand`, dynamic known-host commands, provider
commands, and other required settings that cannot be represented safely; refuse
with a named limitation rather than silently changing connection semantics.

Mandatory runtime policy applies to every hop: strict host checking, no
agent/X11 forwarding, no configured local/remote/dynamic forwards or tunnels, no
local commands or SSH escape commands, and no ambient control sockets or
multiplexing. Do not import `RemoteCommand`, `SendEnv`, or `SetEnv`. Unsupported
client options fail setup rather than silently omitting a protection. Validate
this policy on supported Linux and macOS OpenSSH versions.

Configuration edits create a new revision and invalidate grants. Refuse edits
while work is active; the human must stop or finish it first. Trusted local OS
changes to referenced keys/trust files remain inside the OS trust boundary.

Spawn using explicit argv and a minimal environment: no app secrets, Subshell
credentials, preset environment, loader overrides, shell startup overrides, or
askpass hooks. Allow an authentication-agent socket only from trusted connecting
account setup. Reject option-like aliases/control characters; quote remote
directory arguments as POSIX data. Only `command` is intentional shell code.

## 3. Product behavior and execution contracts

### Connection UI

Add **SSH connections** to user settings: select connecting node, choose/enter
alias, review resolved destination and connecting OS account, set optional
absolute remote directory, test, save, then grant selected panes separately.

Always show the route, for example **Staging · deploy@app-02 · via Laptop**.
Distinguish remote paths from connecting-node paths. Remote OSC titles cannot
replace the trusted destination label. Show connecting-node unavailability
separately from destination/authentication errors. File uploads to SSH terminals
are disabled until remote file operations exist.

### Structured commands

Path: SPA/MCP → server authorization → signed/encrypted node command → shared SSH
runtime → destination. The server-hosted node uses the same runtime directly.

Each command uses a supervised non-PTY SSH process and independent shell context.
Directory/environment mutations do not persist between commands. Keep stdout and
stderr separate. A failed directory change must prevent command execution.
Structured commands do not scrape interactive shell prompts or completion markers.

Start returns a run ID promptly. Read returns bounded incremental output and
status; browser closure or read timeout does not cancel execution. Connection
testing uses a fixed benign probe, not caller-supplied command text.

Use lifecycle states `accepted`, `running`, `completed`, and `unknown`, plus
separate cancellation/deadline facts. `completed` carries an observed remote exit
status; unknown must not masquerade as failed or successful. Retain local SSH
exit/signal information separately. OpenSSH's 255 status is ambiguous between
transport error and remote status; do not claim a confirmed remote result from
that number alone. See [SSH exit status](https://man.openbsd.org/ssh#EXIT_STATUS).

Cancellation stops locally supervised SSH/helper processes with a bounded grace
period. Report remote termination as unconfirmed. Commands can daemonize or
otherwise survive the connection; no UI label should imply otherwise.

### Durable dispatch and storage

Allocate run IDs server-side and bind them to owner, initiating grant/credential,
connection revision, and a digest of the complete request. The connecting runtime
durably records acceptance before spawning. Duplicate delivery returns existing
state; a different payload under the same ID is refused. A crash between acceptance
and spawn produces unknown state, not automatic permission to try again.

Reconcile known IDs after reconnect. Unknown or expired IDs are not reusable start
requests. Persist deduplication records for the full accepted-request lifetime;
deleting output must not delete replay protection. Validate signed command expiry
and reject stale starts after reconnect. Do not queue new execution while offline.

Use opaque IDs for filesystem names, 0700 directories, and 0600 files. Refuse
symlinks/path escapes during creation, reads, and cleanup. Store output on the
connecting runtime and relay it through authorized reads; the server stores run
metadata, not a second unbounded output copy.

| Limit | Default |
| --- | --- |
| Execution deadline | 5 minutes, caller-selectable up to 1 hour |
| Active structured runs | 4 per owner per connecting node; 16 total per connecting node |
| SSH terminals | 4 per owner per connecting node |
| Retained output per structured run | 10 MiB combined stdout/stderr |
| Aggregate SSH output storage | 1 GiB per connecting node, including managed SSH terminal logs |
| Completed-run retention | 7 days |
| Output response window | At most 256 KiB |
| Read long poll | At most 30 seconds |
| Connection/setup probe | 30-second overall deadline, no automatic execution retry |

Bound partial lines, pending buffers, and in-flight responses. Keep draining after
capture limits and report truncation. Under disk pressure evict completed output
first; if still full, reject new work. Active SSH terminal logs need bounded
rotation with an explicit cursor-expired/reset result, never silent cursor reuse.
Use log generation plus byte offset where rotation occurs. Do not silently change
the existing non-SSH byte-cursor contract.

Command text and output can contain secrets: keep them out of operational logs,
audit metadata, and notifications. Audit actor/resource IDs, connection revisions,
grant/control changes, destinations, and lifecycle outcomes. Render output as
text/xterm data, never HTML. No automatic link opening or clipboard access; retain
explicit human clipboard interaction.

### Interactive terminals and input control

Reuse rendering, geometry, short-lived attach tokens, and pane lifecycle. SSH is
the foreground process; its exit ends the pane with no connecting-node shell
fallback. Restart creates a new SSH session and rechecks authorization. Neither
local tmux nor an SSH reconnect guarantees remote-session persistence.

Human-opened terminals start in human control; agent-opened ones start in agent
control. Humans can take over immediately. Only humans return control to agents.
Human mode blocks agent reads and writes on every API/stream, but recorded output
can become visible after return to agent control. Explain that ordinary terminal
history is not confidential secret storage.

### Existing `exec_in_terminal`

Keep its combined-output, POSIX-marker contract as a terminal convenience. Add
execution IDs, persistent outstanding state, and a read-only status operation.
Enforce input ownership across every write path, including restart prompts and
nudges. A caller's wait timeout leaves the reservation active; continue bounded
marker observation. A late marker can complete it; lost observation/restart makes
it unknown. An explicit human takeover invalidates the result and fences stale
queued input using the node-enforced input generation.

Quiet output is only a heuristic; it cannot detect a silent program waiting on
stdin. Document unsupported interactive commands/shell syntax clearly and never
upgrade marker text into a security decision. Do not use this helper on managed
SSH terminals. Keep its report-only timeout behavior: no automatic Ctrl-C.
After observation becomes unknown, refuse further automated exec until human
recovery or pane restart; do not monitor or reserve unbounded memory indefinitely.

## 4. Shared interfaces and compatibility

These contracts must be landed by workstream A before parallel implementation.
Agents may not invent incompatible alternate shapes in their own modules.

### Persistence

- Connections: owner, connecting node, display name, normalized config snapshot,
  remote-directory default, revision, and timestamps; no credential contents.
- Grants: connection revision, pane ID, API-key identity, human grantor, timestamps,
  and revocation; unique active binding for that tuple.
- SSH runs: run ID, connection snapshot/revision, owner, initiating grant/credential,
  request digest, lifecycle/cancellation facts, observation and exit information.
- Pane association: SSH connection revision, initiator, control owner/generation,
  and log generation; no implicit grants via ordinary pane ownership.
- Terminal exec records: execution ID, pane incarnation, initiator, input generation,
  observation state, and bounded-result metadata.

Register migrations in both the migration directory and static boot provider.
Connection deletion is refused while work is active. Retained run history keeps
an immutable destination snapshot after the connection is deleted.

### REST and MCP surface

REST uses camelCase bodies and the existing authenticated service pattern. Define
schemas once server-side and validate all node wire responses with shared parsers.

| REST family | Capability | Caller |
| --- | --- | --- |
| `/api/ssh/discovery` | List aliases on a selected eligible node | Human cookie only |
| `/api/ssh/connections` | CRUD and fixed connection test | Human cookie for writes; granted pane for filtered reads |
| `/api/ssh/connections/:id/grants` | Grant/revoke individual pane access | Owning human cookie only |
| `/api/ssh/runs` | Start, get/read output, request cancellation | Owning human or explicitly granted pane |
| `/api/ssh/terminals` | Create managed SSH pane | Owning human or explicitly granted pane |
| Existing pane routes plus control/status operations | Attach/input/lifecycle, human takeover/return, terminal exec status | Shared pane + SSH policy where applicable |

No trust-acceptance, credential-upload, arbitrary-option, or arbitrary-host API.
Run/terminal IDs are scoped by authorization, never bearer capabilities themselves.

MCP adds `list_ssh_connections`, `execute_ssh_command`, `read_ssh_command`,
`cancel_ssh_command`, and `open_ssh_terminal`, plus `get_terminal_execution` for
recovering an existing `exec_in_terminal` result. Existing pane tools operate SSH
terminals through the additional policy; do not add duplicate SSH input/log tools.

Node wire commands cover human config discovery/resolution, test, run start/status/
read/cancel, SSH terminal launch, and input-control generation transitions. Reuse
the existing encrypted/signed command transport and exact protocol version policy.
The baseline is protocol 15; the coordinator selects the next unused version at
integration and performs one coordinated bump for these changes. No capability
negotiation or old-node fallback. Short RPCs start work; long tasks are not held
inside the existing RPC response deadline.

The shared runtime lives in the permissive packages; server repositories and
authorization stay under `apps/server/`. Do not move AGPL implementation into
packages or introduce runtime imports from Apache packages into server code.

## 5. Multi-agent work breakdown

This section authorizes a future implementation coordinator to delegate the work.
Writing this plan does not start implementation or authorize a release.
Use at most three workers alongside the coordinator in a four-slot session.
Read each app's `AGENTS.md` before its code and the relevant rules/deep dives.

### Ownership and handoff rules

- Assign one owner to each shared file. Do not concurrently edit a registry,
  migration provider, barrel, manifest, lockfile, or central service.
- Workers own their modules and tests. They return exact integration changes for
  coordinator-owned files instead of editing those files opportunistically.
- Coordinator owns `SSH-SUPPORT.md`, shared protocol/error contracts, root/package
  dependency edits, migration numbering/provider, central route registration,
  central auth/token wiring, launcher integration, and protocol version bump.
- Workstream C owns `subshells.service.ts` and generic pane/WS authorization edits;
  workstream D calls C's policy interface rather than also editing those files.
- Workstream E owns `packages/mcp-core/src/server.ts` and MCP registration. UI
  workers do not edit that registry.
- Use separate worktrees when available. Otherwise use the exclusive file map
  below and report collisions before editing. Do not reset another agent's work.
- A worker handoff includes changed files, contracts consumed/provided, tests and
  captured results, known limitations, and unresolved integration issues.
- Tests passing inside one workstream do not establish integrated security.

### Workstreams

| ID / agent | Ownership | Deliverables and acceptance | Dependencies |
| --- | --- | --- | --- |
| A — coordinator/contracts | Shared protocol/types/errors, integration registries, migration allocation, this plan | Freeze request/result and authorization/control contracts; define test fixtures; coordinated protocol bump; no ambiguous ownership | First |
| B — SSH runtime | New `packages/pane-runtime/src/ssh/` modules and node SSH command handlers/tests | Normalized safe config, all-hop policy, probes, supervised runs, durable deduplication, bounded storage, cancellation; real isolated sshd tests | A |
| C — pane control | Terminal execution service, generic pane routes/WS gates, input generation plumbing and tests | All writers fenced; timeout/late completion/restart recovery; comprehensive SSH gate hook; no fallback local shell; bounded SSH terminal history | A; B for final SSH lifecycle integration |
| D — SSH backend | New server SSH repositories, services, API schemas/routes and tests | Connection revisions, grants, runs, authorization, revocation/reconciliation, audit/retention orchestration; deny-by-default policy implementation | A; B for runtime adapters; C for pane hooks |
| E — MCP | `packages/mcp-core` tools, registration, instructions and tests | New tools, honest errors/results, explicit grants, status recovery, no automatic retries, existing-tool compatibility | A and frozen D/C APIs |
| F — SPA | New SSH settings/hooks/views and existing terminal control UI/tests | Human setup/grants, clear route identity, error states, run output, takeover, private SSH panes, no uploads/auth-secret forms | A and frozen D/C APIs |
| G — verification/docs | Isolated e2e SSH fixtures, adversarial integration tests, public docs/security updates | Cross-path bypass/race coverage, compiled smoke tests, security accounting, acceptance evidence | Can prepare fixtures after A; final execution after B–F |

### Scheduling with four slots

1. **Gate A: contracts.** Coordinator lands shared shapes and ownership assignments.
   Workers may inspect and prepare fixtures, but do not build against guessed APIs.
2. **Wave 1: B + C + D.** Runtime, pane control, and backend proceed concurrently
   using contract fixtures. Coordinator integrates shared files and resolves
   disagreements without weakening authorization or failure semantics.
3. **Gate B: backend integration.** Demonstrate one authorized command, a denied
   ungranted pane, durable duplicate rejection, and takeover fencing using real
   SSH fixtures. Incomplete security paths remain unreachable from public APIs.
4. **Wave 2: E + F + G.** MCP and SPA implement the frozen integrated API while
   verification exercises it independently. Runtime/backend owners are recalled
   as needed for focused fixes, within the concurrency limit.
5. **Gate C: end-to-end security review.** Coordinator and verifier audit the full
   authorization matrix, races, resource bounds, protocol behavior, and docs.
   Integrate fixes and rerun affected checks, then complete the release checklist.

Do not ship partially wired generic pane access while SSH gates are still stubs.
Do not merge a placeholder authorization helper that returns success. Refusals are
the default until the full policy is installed.

### Copyable assignment template

> Implement workstream [ID] from SSH-SUPPORT.md. Read its dependencies and relevant
> app instructions first. Edit only assigned files; coordinator-owned integration
> files require a handoff request. Preserve the settled security and scope decisions.
> Add the specified tests, capture one run's output, and report changed files,
> integration needs, results, and limitations. Do not publish, release, touch the
> live instance, or change another worker's files. Escalate contract conflicts to
> the coordinator rather than adding fallback behavior.

## 6. Verification and completion gates

Use an isolated SSH fixture with temporary accounts, keys, trust files, and config.
Never use the live instance or a developer's SSH configuration. Bind test services
to loopback, track their processes, and clean up only resources the fixture owns.
Read `e2e/AGENTS.md` before adding browser/stack coverage.

### Security acceptance matrix

| Area | Required cases |
| --- | --- |
| Grants | Wrong owner, same-owner ungranted pane, child/restarted pane, old token, revoked token, changed revision, disabled account |
| Alternate paths | Generic list/detail previews, logs, captures, live updates, attach mint/redeem, input, prompts, restart/terminate/delete, sharing |
| Races | Revoke or takeover against queued input, dispatch, token redemption, active streams, offline cancellation, and reconnect |
| SSH policy | Unknown/changed/revoked keys, certificates, config includes, jump hosts, ambient forwards, control sockets, proxy/local commands, askpass, SendEnv/SetEnv |
| Injection | Option-like aliases, control characters, quoted directories, shell metacharacters as data, symlink/path escapes in runtime storage |
| Execution | Duplicate IDs/payload mismatch, crash before/after spawn, ambiguous acknowledgement, exit 255, timeout, cancellation, no automatic replay |
| Resource limits | Infinite output, oversized partial line, stalled client, quota exhaustion, excessive concurrent starts/probes, bounded log rotation |
| Terminal control | Every input writer, stale generation, late marker, restart recovery, human takeover, no local-shell fallback, no secret-privacy claims |
| Untrusted output | HTML/ANSI/OSC, clipboard requests, malicious links/titles, spoofed completion; identity and permissions remain authoritative |
| Compatibility | Existing terminals/presets/cursors/transfers, protocol mismatch, static migration registration, compiled CLIs, licence checks |

Run affected package `test` scripts with `env -u SHELLOPTS -u BASHOPTS`; capture
output once and inspect failures from the file. Focused single-file runs are fine
while editing. Run type checking and relevant lint/design/license checks, then
isolated e2e and compiled-binary smoke tests. No Rust change is anticipated; if
scope introduces one, run the repository Rust checks too. Do not use live :3080.

Final documentation work updates public SSH/MCP guidance, app routing notes, and
security accounting. Use changesets for the server and node apps and docs when
applicable; the server ships SPA changes. Do not hand-edit changelogs or write
changesets for ignored packages. Read `docs/release-and-ci.md` before artifact or
release work; releases remain separately authorized workflow actions.

### Definition of done

- A human can save a supported SSH connection and grant one live agent pane access.
- That pane can run a command, recover its result by ID, and open an SSH terminal.
- An ungranted pane cannot use generic APIs to recover the same access.
- Human takeover and revocation fence subsequent input and streams at every path.
- SSH credentials remain on the connecting account; no in-app secret entry or trust bypass exists.
- Disconnects and crashes never cause command replay or false success reports.
- Runtime/output resources are bounded and cleanup is safe.
- Existing MCP terminal and node-transfer workflows still pass their tests.
- Security verification evidence is recorded; no tests or implementation touched the live instance.

## 7. Follow-up milestones

Remote browsing, transfers, and structured file edits come next. Reuse existing
transfer semantics where appropriate, but node archive commands require enrolled
nodes and cannot operate an ordinary SSH destination directly. Design the SSH
transport and authorization before extending `transfer_files`.

Persistent remote sessions, connection sharing, private authentication flows,
Windows support, remote agent launch, and conversation handoff each need explicit
designs. Do not smuggle them into v1 through arbitrary SSH options or shell wrappers.
