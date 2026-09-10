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
  "agentVersion": "0.3.1",
  "protocolVersion": 1,
  "os": "darwin",              // linux | darwin | unknown
  "arch": "arm64",
  "hostname": "mac-mini",
  "dataDir": "/Users/x/.config/subshell/data",
  "capabilities": ["uploads", "mcp"],
  "executablePath": "/Users/x/.local/bin/subshell"
}
```

`executablePath` is how the control plane composes the MCP launch spec for panes
on this node — it must point at the running binary.

The identity is persisted **before** either gate below, so a refused agent still
shows its version on the Nodes page instead of being invisible.

**Gate 1 — the version floor.** `MIN_AGENT_VERSION` (currently `0.1.0`) is the
operator-facing statement "this server needs subshell >= X". It runs first
precisely because it is the gate an operator can *act* on, and the close reason
names both the required and the found version. It is bumped deliberately,
whenever a server needs newer agent behaviour.

**Gate 2 — the protocol, matched exactly.** Any `protocolVersion` differing from
`NODE_PROTOCOL_VERSION` (currently `1`, the post-restart baseline, §11) is refused **in either direction**. There
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
| `launch` | Start a harness pane: `cwd` (already stat-verified), `harnessId`, a `ProfileDefinitionWire`, the `SUBSHELL_*` credential env, an optional 0600 MCP registration file to write first, optional resume pin and initial geometry. `bestEffortLog` downgrades a log-attach failure to a note instead of failing the launch |
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

**Filesystem** (all path-policy enforced agent-side). `fs_ls` is deliberately
NOT gated by the directory allowlist — browsing is not launching, and the owner
browses through it to choose what to permit; the control plane filters listings
instead. See `docs/superpowers/specs/2026-09-05-node-directory-allowlist-design.md`.

| Command | |
|---|---|
| `stat_dir` | Verify a directory exists and is usable. **Also the allowlist gate**: refused when the node has directory rules and the resolved path is outside them, so the pre-launch probe answers the same way `launch` will |
| `fs_ls` | One-level listing for the folder picker. Empty `path` means the **agent's** home — the control plane cannot expand `~` against a filesystem it cannot see. Directories only, dotfiles hidden, capped at `FS_LS_MAX_ENTRIES` (1000) |
| `write_file` | Chunked base64 write (the terminal-uploads relay): `chunk_b64`, `chunk`, `eof` |
| `remove_paths` | Delete paths |
| `plugin_install` | Install one plugin on the node. The node performs the install from the copies its build carries and answers with its WHOLE set, because the control plane mirrors what the node reports and a partial answer would leave it guessing at the rest. It also pushes a fresh `inventory`, since the probe follows what is installed. An offline node is refused rather than queued: the node owns its set, so there is no desired state to reconcile |
| `plugin_uninstall` | Remove one plugin. Removing something already absent is a SUCCESS — the caller asked for a state and that state holds, so a retry after a dropped connection does not look like a failure. Answers with the set that remains, plus a fresh `inventory` |
| `set_allowed_dirs` | Replace the node's persisted directory allowlist (v5). The node stores it at `<dataDir>/allowed-dirs.json` (0600) and checks every `launch`/`stat_dir` against its OWN copy — signing proves who sent a launch, never whether the directory is permitted. An empty array clears the rules (unrestricted). Pushed on every owner edit and again after each `ready`, which is what reconciles a node that was offline for an edit |

**Status**

| Command | |
|---|---|
| `probe` | Liveness of a set of subshell ids |
| `probe_resume` | Whether a harness session id can be resumed in a cwd |
| `inventory` | Pull a fresh harness inventory on demand |
| `ping` | Liveness |

Subshell ids are interpolated into node-side paths, so both sides gate them
through `isNodeSubshellId` — hex and hyphen, ≤ 64 chars. A hostile
`../../../../x` must never reach path interpolation on either side.

## 6. Events

`NodeEvent` in `node-frames.ts`, all unsigned:

| Event | |
|---|---|
| `ready` | First frame — identity, versions, capabilities, `executablePath` (§3) |
| `inventory` | Per-harness `{ harnessId, installed, version?, binaryPath?, reason?, checkedAt? }` + timestamp, and `plugins` — the node's own report of what it has INSTALLED. The probe follows that installed set, not the plugins this build happens to know, so a third-party plugin is probed and an uninstalled one stops being. Pushed at connect, every 5 min (`INVENTORY_PERIOD_MS`), after any plugin change, and on demand |
| `heartbeat` | Every 15 s (`HEARTBEAT_MS`) |
| `result` | `{ ref, ok: true, data? }` or `{ ref, ok: false, error }` — answers one command |
| `output` | Tail bytes: `subId`, `fromByte`, `toByte`, `data_b64` |
| `exit` | A pane died: `exitCode` (or `null` when unreadable) + timestamp |
| `subshells_report` | Connect-time re-projection of panes that survived an agent restart, so the control plane heals its rows |
| `error` | `{ code, message }` |

**The launch gate demands a fresh inventory** reporting the harness installed, so
an un-inventoried node cannot silently fail launches. It also demands that the
node DECLARED the plugin: what a node offers is what it has installed, and
there is no enable flag on either side.

A plugin report may carry `restartRequired`. A module cannot be swapped inside
a live process, so upgrading a plugin in place leaves the agent running the
code it loaded: the reported `version` then describes the disk, not the
behaviour, and the flag is what keeps the two from being confused. It clears
when that agent restarts.

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
`NodeLogReadResult`, `NodePromptDeliverResult`, `NodeProbeResumeResult`,
`NodeWriteFileResult`, `NodePaneSizeResult`. Every one is parsed, never cast: a
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
  versions, and the GitHub releases of that era are removed. Everything in
  this document is v1-era; the first real bump is 1 → 2, and old numbers from
  the retired sequence do not recur here (their history is in git).
- **`MIN_AGENT_VERSION`** — bump when the server needs newer agent *behaviour*
  that the frames alone do not express.

An exact-match protocol was chosen over a compatibility window on purpose. A
window buys the ability to add a command without a node rollout and pays for it
in branches that cannot be exercised: an "is this node new enough" check per
feature, a fallback path per check, and a second meaning for every null.
Refusing the mismatch outright is one comparison and no dead ends.

Settings → Status lists every enrolled agent under the floor in one place, since
a refused agent otherwise looks like an ordinary offline node.
