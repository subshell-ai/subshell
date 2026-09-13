# Subshell — Node Protocol Reference

The wire contract between the control plane and an enrolled **node** (another
machine that runs harnesses on the control plane's behalf). This describes the
protocol as implemented; [`architecture.md` §9](architecture.md#9-nodes-remote-execution-hosts)
covers where it sits in the system, and [`security.md`](security.md) covers what
it does and does not defend against.

The contract itself lives in `@internal/subshell-protocol`:
`node-frames.ts` (frames + validators), `node-signing.ts` (the JWS envelope),
`node-results.ts` (result payload shapes), `versions.ts` (the version gates).
Both sides import the same module — there is no second copy to drift.

- [1. Shape of the link](#1-shape-of-the-link)
- [2. Enrollment](#2-enrollment)
- [3. Connect and the two gates](#3-connect-and-the-two-gates)
- [4. Command envelope and replay defense](#4-command-envelope-and-replay-defense)
- [5. Commands](#5-commands)
- [6. Events](#6-events)
- [7. Dispatch ordering and results](#7-dispatch-ordering-and-results)
- [8. Terminal attach over a node](#8-terminal-attach-over-a-node)
- [9. Offline semantics](#9-offline-semantics)
- [10. Close codes](#10-close-codes)
- [11. Versioning](#11-versioning)

---

## 1. Shape of the link

One websocket per node, **dialed out by the agent** — the control plane never
connects to a node. This is the whole reason nodes work behind NAT and on
laptops: nothing has to be reachable except the control plane.

```
node host                                     control plane
┌──────────────────────────┐                 ┌────────────────────────────┐
│ subshell run (daemon)    │                 │ /ws/node                   │
│                          │  ws, bearer     │  node-ws-handler.ts        │
│  ──────── dials ─────────┼────────────────▶│  node-registry.ts (sockets)│
│                          │                 │  node-rpc.ts   (dispatch)  │
│  commands  ◀── signed ───┼─────────────────┤                            │
│  events    ─── plain ────┼────────────────▶│                            │
│                          │                 └────────────────────────────┘
│  └─ tmux ─ harness pane  │
└──────────────────────────┘
```

Asymmetric by design:

- **Commands (control → agent) are signed.** The agent verifies every envelope
  before executing anything. It holds the control plane's public key from
  enrollment, so a compromised relay cannot forge work for it.
- **Events (agent → control) are not signed.** The bearer node key on the socket
  is the authentication; events inherit exactly the node key's trust and nothing
  more. Signing them would prove nothing extra — the same key already authorized
  the connection.

Both directions cap frames at `NODE_MAX_FRAME_BYTES` (1 MiB). Bun's
`maxPayloadLength` is global to the server, so each handler enforces the ceiling
by byte length itself rather than trusting server config.

## 2. Enrollment

A node is enrolled once, with a **single-use setup key**.

1. An operator mints one under Settings → Nodes. It is `nsk_…`, valid 24 h,
   shown once, stored only as a hash, revocable, and its creation is audited.
2. The agent generates its own identity keypair, then `POST /api/nodes/enroll`
   with the setup key, a name, and its public key. This is the one node route
   with **no auth guard** — the setup key *is* the credential.
3. The response carries, exactly once:
   - `nodeKey` — the node's long-lived bearer key (only its hash is stored),
   - `controlPublicKey` — the control plane's command-signing public key, which
     the agent pins,
   - the assigned `nodeId`.
4. The agent writes all of it to `config.json` (0600). That file is the node
   key's only home; `subshell status` never echoes it, not even `--json`.

The route peeks the setup key's state before consuming it, so an
invalid/expired/spent key gets a specific error rather than a generic failure.
Consumption is a transaction; steps after it are not atomic, so a failure past
that point reports that the key is spent and a new one is needed.

**A node key can do nothing on REST.** The auth guard rejects `kind: "node"`
keys outright and permanently — its entire blast radius is "open `/ws/node` as
this node."

## 3. Connect and the two gates

The agent dials `/ws/node` with `Authorization: Bearer <nodeKey>`. The upgrade
hook authenticates and stashes the identity; a socket that reaches the handler
without one is closed **4401**.

The agent's first frame is `ready`:

```jsonc
{
  "type": "ready",
  "agentVersion": "0.5.0",
  "protocolVersion": 7,
  "os": "darwin",              // linux | darwin | unknown
  "arch": "arm64",
  "hostname": "mac-mini",
  "dataDir": "/Users/x/.config/subshell/data",
  "capabilities": ["uploads", "mcp"],
  "selfInvoke": { "command": "/Users/x/.local/bin/subshell", "args": [] },
  "homeDir": "/Users/x"                        // resume-path defaults hang off it
}
```

`selfInvoke` is how to re-enter this agent's binary — the `{ command, args }`
PREFIX a subcommand is appended to, whatever "this machine's subshell" turns
out to be: a compiled binary answers `{ command: <self>, args: [] }`, a
bun-interpreted run answers `{ command: <bun>, args: [<entry script>] }` (the
entry ABSOLUTE, because both consumers spawn in the subshell's cwd). The
control plane cannot derive this from any single path — under a bun-interpreted
run the process's exec path is `bun`, and `bun mcp` is not a command. It is
subcommand-LESS since protocol 4, where `ready.mcpLaunch` became
`ready.selfInvoke`: the plane re-enters the agent for two unrelated things —
`mcp` for a pane's MCP registration and `report` for its harness hooks — and
one reported fact serving both is what keeps them from drifting. Absent means
the control plane falls back to `subshell` on PATH. `homeDir` is the fallback
root the control plane computes resume paths against (spec 2026-09-10 §5); a node
reporting none gets the plugin's default path computed anyway (which simply
will not exist). The resume path's other input — the env VALUES a plugin
declares — is NOT reported here: a node holds no manifests and so cannot know
the names. They are asked by name on the `detect` round trip (§5).

The identity is persisted **before** either gate below, so a refused agent still
shows its version on the Nodes page instead of being invisible.

**Gate 1 — the version floor.** `MIN_AGENT_VERSION` (currently `0.5.0`) is the
operator-facing statement "this server needs subshell >= X". It runs first
precisely because it is the gate an operator can *act* on, and the close reason
names both the required and the found version. It is bumped deliberately,
whenever a server needs newer agent behaviour.

**Gate 2 — the protocol, matched exactly.** Any `protocolVersion` differing from
`NODE_PROTOCOL_VERSION` (currently `7`) is refused **in either direction**. There
is no compatibility window and no per-feature gating: server and agent ship
together, so a mismatch is a deployment out of step, not a node to be carried.
The close reason names both numbers.

Both close **4406**, and the agent relays the reason into its own log — so the
operator sees it on the node, not only in the control plane's journal.

The two gates are independent. Raising the floor without bumping the protocol is
the normal case; never infer one from the other.

## 4. Command envelope and replay defense

Every command is a **compact JWS** (ES256/P-256), sent as `{"jws": "<compact>"}`.

```jsonc
// decoded payload
{
  "iss": "subshell-control",
  "aud": "node:<nodeId>",     // bound to ONE node
  "jti": "<unique per command>",
  "iat": 1757030400,
  "exp": 1757030430,           // 30 s (NODE_CMD_TTL_SEC)
  "seq": 42,
  "cmd": { "type": "…", /* … */ }
}
```

Signing proves **authenticity, freshness and target**. It does not provide
confidentiality — that is WSS, and the operator's deployment concern.

Verification order is load-bearing (`verifyCommand`):

1. **Signature + compact-JWS format.** `algorithms: ["ES256"]` is pinned so a
   header swap cannot downgrade the check. The payload is parsed from the bytes
   that call just verified, never by a second unverified decode of the wire
   string.
2. **Registered claims** — `iss`, `aud`, `exp`, `iat` (with 5 s skew tolerance).
   jose v6's `compactVerify` checks crypto and format only, so these are
   validated explicitly here. That split is what keeps `reason: "signature"`
   meaning bad crypto and `reason: "claims"` meaning issuer/audience/expiry.
3. **`jti` replay** against a bounded LRU (2048 entries).
4. **`seq`** ordering hint.
5. **`cmd` well-formedness** via the hand-rolled structural validators.

A frame rejected on `seq` still records its `jti` — it is stale or hostile either
way, and must never get a second evaluation.

**The two stateful pieces have different lifetimes, and mixing them up is a
security bug:**

| | lifetime | why |
|---|---|---|
| `JtiLru` | **per node**, shared across every connection that node ever makes | a fresh LRU per socket reopens the full 30 s replay window on every reconnect |
| `SeqTracker` | **per connection**, reset when a new socket opens | ordering only means anything within one stream |

`seq` is explicitly *not* the replay defense — `exp` + `jti` are. A reconnect
resets `seq`, so a replayed command would carry a "fresh" value. `seq` only
catches reordering and stale replays inside the TTL window on the same socket.

## 5. Commands

`NodeCommandBody` in `node-frames.ts`. Every command is dispatched with a `ref`
and answered by exactly one `result` event.

**Lifecycle**

| Command | |
|---|---|
| `launch` | Start a harness pane: `cwd` (already stat-verified), `harnessId`, a `preset` (`PresetDefinitionWire`; the field was `profile` until protocol 6), the `SUBSHELL_*` credential env, an optional 0600 MCP registration file to write first, optional resume pin and initial geometry. `bestEffortLog` downgrades a log-attach failure to a note instead of failing the launch. Since protocol 3 the node builds nothing itself: `argv` (REQUIRED) is the complete command line the CONTROL PLANE built, with `@@HARNESS_BINARY@@` in the binary slot; `resolve` (REQUIRED) is the manifest's lookup rule (`binaryName`/`envOverride`/`knownPaths`) the node runs at the moment of spawn to fill that slot — late binding of the one fact the node owns; and `mcp.args` / `mcp.env` ride alongside the file content, so the node no longer recomputes the harness's MCP dialect (the spawn command inside it is still node-supplied knowledge — the agent's `selfInvoke` answer, carried on `ready` and composed by the plane, never guessed from a path) |
| `terminate` / `kill` | Graceful stop / hard kill of a subshell's tmux tree |
| `prompt_deliver` | Agent-side settle loop: capture-poll until the pane is quiet, then type the text and Enter |

**Pane I/O**

| Command | |
|---|---|
| `input` | Keystrokes into the pane |
| `resize` | Set the pane grid |
| `capture` | Pane snapshot; optional `lines` prepends reflowed history for attach replay |
| `pane_size` | The pane's **real** grid as tmux reports it. Answering `null` (pane gone) is a legal result, distinct from an error |
| `log_read` | Byte-ranged read of the pane log |
| `tail_start` / `tail_stop` | Subscribe/unsubscribe a byte-offset tail, keyed by `subId` |

**Filesystem**. The deletions and writes (`remove_paths`, `write_file`) are
path-policy enforced agent-side; the PROBEs deliberately are not. `fs_ls`:
browsing is not launching, and the owner browses through it to choose what to
permit; the control plane filters listings instead (see
`docs/superpowers/specs/2026-09-05-node-directory-allowlist-design.md`).
`stat_dir` and `path_exists` join them for the same reason — gating `stat_dir`
once made the second allowlist rule unaddable, and gating `path_exists` would
silently disable restart-resume wherever the harness state dir lives, which is
nowhere near the directories subshells are allowed to run in.

| Command | |
|---|---|
| `stat_dir` | Verify a directory exists and is usable; answers the realpath. Deliberately NOT gated by the directory allowlist — the control plane resolves each new rule through this probe, so gating it made the second rule unaddable (see the 2026-09-05 allowlist revision note) |
| `path_exists` | Does `{ path }` exist on the node? `{ exists }` answers; an absent path is a SUCCESSFUL `false`, never an error. The path arrives COMPUTED: the control plane builds it with the plugin's pure `resumePath` against this node's `ready`-reported `homeDir` and the `env` values its last `detect` answer carried (spec 2026-09-10 §5 as amended) — the generalised `probe_resume`, ungated like its neighbours: a probe is not a launch |
| `fs_ls` | One-level listing for the folder picker. Empty `path` means the **agent's** home — the control plane cannot expand `~` against a filesystem it cannot see. Directories only, dotfiles hidden, capped at `FS_LS_MAX_ENTRIES` (1000) |
| `write_file` | Chunked base64 write (the terminal-uploads relay): `chunk_b64`, `chunk`, `eof` |
| `remove_paths` | Delete paths |
| `set_allowed_dirs` | Replace the node's persisted directory allowlist. The node stores it at `<dataDir>/allowed-dirs.json` (0600) and checks every `launch` against its OWN copy — signing proves who sent a launch, never whether the directory is permitted. An empty array clears the rules (unrestricted). Pushed on every owner edit and again after each `ready`, which is what reconciles a node that was offline for an edit |

**Status**

| Command | |
|---|---|
| `probe` | Liveness of a set of subshell ids |
| `inventory` | Pull the harness inventory on demand. Since protocol 3 the agent has no plugin concept, so its answer is an EMPTY `harnesses` list (protocol filler it still owes the wire) and the server correctly treats an empty array as "nothing to apply" — the rows that matter arrive via `detect` |
| `detect` | Probe THIS node for the binaries the named detection rules point at, and answer the env the plane asks about (spec 2026-09-10 §4, env per §5 as amended): `specs` is one `{ id, binaryName, envOverride, knownPaths }` per harness to check — the plugin manifests' data, which the control plane holds and re-ships every time; the node remembers nothing and loads no plugin code to answer. `envNames` (REQUIRED, may be empty) is the list of environment-variable names to report values for — the union of `subshell.hostEnv` across the plane's ENABLED harness manifests, since the node holds no manifests to name them itself. The answer is `{ results, env }`: one row `{ harnessId, installed, binaryPath?, rawVersion?, reason? }` per spec — the same entry shape the inventory event uses, with `version` replaced by `rawVersion`, because `parseVersion` is plugin code and runs on the control plane — plus `env` with values for ONLY the asked names this node actually has (unset names stay absent; unasked names are never looked at). The agent stamps no time: the probe just happened, and the plane's driver stamps its own clock when merging; the driver stashes `env` on the connection's facts, where resume-path computation reads it. An empty-`binaryName` spec is the no-binary marker, answered `no-binary` without searching. Empty `specs`/`envNames` are legal no-ops. Detection runs ONLY when asked — node-page load, Re-check, or a launch kick — there is no sweep |
| `ping` | Liveness |

Subshell ids are interpolated into node-side paths, so both sides gate them
through `isNodeSubshellId` — hex and hyphen, ≤ 64 chars. A hostile
`../../../../x` must never reach path interpolation on either side.

## 6. Events

`NodeEvent` in `node-frames.ts`, all unsigned:

| Event | |
|---|---|
| `ready` | First frame — identity, versions, capabilities, the subcommand-less `selfInvoke` prefix (`mcp` and `report` both append to it), the resume-path `homeDir` (§3, spec 2026-09-10 §5; the resume env is NOT here — it is asked by name on `detect`), and, from agents that report it, the `runtime` supervision snapshot (spec 2026-09-12 §6.1) |
| `inventory` | Per-harness `{ harnessId, installed, version?, binaryPath?, reason?, checkedAt? }` + timestamp. Since protocol 3 the event carries NO plugin set (the node has none) and the agent's answer is an empty `harnesses` list — the periodic push and the `inventory` command are protocol filler the wire still expects, and the server treats the empty array as "nothing to apply" so it can never wipe the detection rows its own `detect` command collected. Those detect answers, not this event, are the node's harness facts |
| `heartbeat` | Every 15 s (`HEARTBEAT_MS`) |
| `result` | `{ ref, ok: true, data? }` or `{ ref, ok: false, error }` — answers one command |
| `output` | Tail bytes: `subId`, `fromByte`, `toByte`, `data_b64` |
| `exit` | A pane died: `exitCode` (or `null` when unreadable) + timestamp |
| `subshells_report` | Connect-time re-projection of panes that survived an agent restart, so the control plane heals its rows |
| `error` | `{ code, message }` |

**The launch gate demands a fresh DETECT answer**, not an inventory claim: a
harness is usable on a node when the INSTANCE has the plugin installed and
enabled ∧ THAT node's detection found its binary (spec 2026-09-10 §4/§6.1).
For an agent the cached detect answer counts only inside its 10-min TTL, so an
un-probed node cannot silently fail launches; the control-plane host is probed
live on every read. What a node offers is no longer a question the node can
answer — its answers are facts about binaries, the plugin set is an instance
fact, there is no per-node enable flag on either side, and the one
instance-level `enabled` state (absent row = enabled) belongs to the control
plane's store, not this wire.

`restartRequired` is likewise an instance-store concept now: the control plane
holds a newer copy of a plugin on disk than the code its own process loaded (a
module cannot be swapped inside a live process), and its Settings → Plugins
surface says so until the SERVER restarts. A node has no plugin state that
could go stale.

**Exit detection** is a 2 s tick probing each tmux socket. An authoritative
`ok: true` answer that lacks the pane reports death immediately with the pane's
real exit code. The escalated path — `NODE_EXIT_UNREACHABLE_TICKS` (2, ≈4 s)
consecutive `ok: false` probes on one registration — reports `exitCode: null`,
because the socket is not answering rather than the pane being gone. A transient
tmux blip therefore never kills a live pane, and a relaunch resets the counter.

## 7. Dispatch ordering and results

Two invariants hold the seam together:

- **Per-node dispatch is serialized in call order** (`conn.sendChain`). A slow
  `launch` can never interleave with a `write_file`. Without this, a chunked
  upload could arrive out of order, or a pane could receive input before it
  exists.
- **Newest socket wins.** A second agent dialing with the same identity kicks the
  older socket with **4409**; the kicked agent exits rather than reconnecting into
  a fight. `node-registry.ts` owns that.

Results correlate by `ref`. Payload shapes and their parsers live in
`node-results.ts` — `NodeProbeEntry`, `NodeStatDirResult`, `NodeFsLsResult`,
`NodeLogReadResult`, `NodePromptDeliverResult`, `NodePathExistsResult`,
`NodeWriteFileResult`, `NodePaneSizeResult`, and `parseNodeDetectResults` for
the `detect` rows. Every one is parsed, never cast: a
node's answer is untrusted input like any other.

## 8. Terminal attach over a node

`NodeLauncher` (`services/nodes/node-launcher.ts`) is the **only** local-vs-remote
branch in the system. `LocalLauncher` wraps tmux/fs calls directly;
`RemoteLauncher` implements every method as a signed command.

The browser `/ws` contract is **byte-identical** for remote subshells —
`ws/remote-subshell-ws.ts` relays replay/resize/input over the node socket, so
xterm.js cannot tell a remote pane from a local one. Both attach paths follow the
same four steps:

1. subscribe to the shared pump **before** reading the pane,
2. fit to `sharedGridFor()`,
3. capture and send the replay,
4. open the subscription and broadcast presence.

Step 1 before step 4 is the join-point rule expressed as a subscription. A
refusal *after* the subscription must tear it down explicitly, or a tail keeps
running for a viewer that was never admitted.

**Geometry is confirmed on both paths.** `paneSize()` is one question with two
implementations — `LocalLauncher` reads tmux, `RemoteLauncher` sends `pane_size`
— and both answer a real grid or `null`, never a guess. `resize` is a request,
not a guarantee, and a client that believes it holds a size the pane never took
paints every later frame onto the wrong rows. `null` means "could not be read"
(usually the pane is gone, sometimes a wedged node) and nothing is announced.

An earlier revision had no `pane_size` command, and a remote pane announced the
size it had been *asked* for. That asymmetry is gone.

## 9. Offline semantics

**Absence of a socket is not absence of the process.** The agent may be down
while its panes keep running under tmux. So:

- Launching onto an offline node returns **409 `NODE_OFFLINE`**.
- The reconcile sweep **skips** rows whose node is offline — it must not mark
  panes dead that it simply cannot see.
- Subshell views carry `nodeOffline`, so the UI says "node unreachable" rather
  than "crashed".
- On reconnect, `subshells_report` re-projects surviving panes and the control
  plane heals its rows.

## 10. Close codes

| Code | Meaning | Emitted by |
|---|---|---|
| `4401` | authenticated-looking socket with no upgrade-stashed identity | backend (handler-local) |
| `4406` | `NODE_CLOSE_UPDATE_REQUIRED` — below the version floor, or protocol mismatch | backend; **terminal** for the agent |
| `4409` | `NODE_CLOSE_SUPERSEDED` — newest-wins replace | backend registry; **terminal** for the agent |
| `1009` | frame exceeded `NODE_MAX_FRAME_BYTES` | backend (handler-local) |

4406 and 4409 are shared constants because the agent imports them by name to
decide whether to exit rather than reconnect. 4401 and 1009 stay handler-local:
only the backend ever emits them.

## 11. Versioning

Two numbers, changed on different schedules:

- **`NODE_PROTOCOL_VERSION`** — bump whenever a frame changes, additive or not,
  and release both sides. **Server first**: an agent that leads the server is
  refused, and an agent that lags is refused just as clearly. The numbering
  **restarted at 1 on 2026-09-09**: the protocol had reached 6 under a
  numbering that predated any deployment, no instance ever ran on those
  versions, and the GitHub releases of that era are removed. 1 → 2 was the
  first real bump (phase 3, registry installs); **2 → 3 was the inversion**
  (spec 2026-09-10 §7): plugins left the wire — `plugin_install` and
  `plugin_uninstall` removed, `probe_resume` generalized into `path_exists`,
  `detect` added, `launch` requiring the server-built `argv` and its
  `resolve` rule, the inventory event losing its plugin set, and `ready`
  gaining `homeDir` plus the manifest-declared env values. It is the first
  BREAKING bump of the restarted numbering: the exact-match gate refuses a v2
  agent outright, which is the point — server and agent ship as a pair.
  **3 → 4 moved harness reporting into the binary** (the hooks a plugin wires
  run where the pane runs, and the only program guaranteed there is the one
  that launched it): `ready.mcpLaunch` became `ready.selfInvoke`, the same
  self-invocation WITHOUT its subcommand, so the plane appends `mcp` or
  `report` to one reported fact instead of keeping two fields free to drift.
  **4 → 5 was the node Service surface** (spec 2026-09-12, node half):
  `restart` folded into `service` as one of five verbs — one service manager,
  one refusal path — and `agent_log_read` and `set_server_url` arrived beside
  it, so a headless node can be supervised, read and repointed from a browser.
  **5 → 6 is `set_log_level`**, the agent's log-file level gate, breaking only
  because the gate is exact-match. **6 → 7 is the preset rename** (spec
  2026-09-13): the `launch` frame's `profile` field becomes `preset`
  (`ProfileDefinitionWire` → `PresetDefinitionWire`) and the plugin-report
  settings field becomes `presetSettings` — wire-shaped, not semantic: the
  same JSON under new names. Old numbers from the retired sequence do not
  recur here (their history is in git).
- **`MIN_AGENT_VERSION`** — bump when the server needs newer agent *behaviour*
  that the frames alone do not express, and in the same commit as a protocol
  bump so the refusal an operator sees names a version that exists. Currently
  `0.5.0`, raised with protocol 7 alongside the agent package's own hand-raise
  to the same number.

An exact-match protocol was chosen over a compatibility window on purpose. A
window buys the ability to add a command without a node rollout and pays for it
in branches that cannot be exercised: an "is this node new enough" check per
feature, a fallback path per check, and a second meaning for every null.
Refusing the mismatch outright is one comparison and no dead ends.

Settings → Status lists every enrolled agent under the floor in one place, since
a refused agent otherwise looks like an ordinary offline node.
