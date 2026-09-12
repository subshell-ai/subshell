# Node Service surface — design (2026-09-12)

A node gets the management surface the control plane already has for itself.
`/settings/service` answers "who supervises this process, where does it write,
what did it log, and restart it" for the server; today a node answers a
fraction of that, from one card, and everything else needs a shell on the
machine. Most nodes are headless — the agent is installed there, the GUI never
is — so a browser is the only place those questions can be asked at all.

This is the node half of spec 2026-09-12 (*Management in the dashboard*), and
it follows that spec's rule rather than re-deciding it: **if the act leaves the
thing unreachable, it does not get a route**. For the server that ruled out
stop, install, uninstall and reset.

**A node is not exempt from that rule, and the first draft of this spec got it
wrong.** Every command reaches a node over the agent's OWN socket, so the plane
can never start an agent that is not already running: `stop` and `uninstall`
end the connection that would have carried the verb undoing them. They are
one-way from a browser, and only someone with a shell on that machine can
reverse them.

That is not a reason to refuse them — an operator may legitimately want a node
off, and they usually do have SSH — but it decides how they are gated and what
the UI must say. See § 5.1.

## 1. What exists, and what is missing

`NodeRuntimeCard` already reports supervision, uptime, service state and pid,
config/log/binary paths and tmux, for an online agent node whose viewer can
configure it, and `POST /api/nodes/:id/restart` already restarts the agent.
That card's own docstring calls it "the ONLY surface that answers these
questions for a headless node", and it is right.

Measured against `/settings/service`, a node is missing:

| the server has | a node has |
|---|---|
| Service card: supervision, state, boot time, **restart** | the runtime card — restart only |
| Addresses card: **editable config**, written through one validator | nothing (allowed-dirs is its own card) |
| Locations card: where it writes | the runtime card's paths |
| Server log card: **read the log**, toggle debug | nothing |
| — | **start / stop / install / uninstall** exist for neither |

So: three capabilities (service control, log reading, config editing), and a
page structure to hang them on.

## 2. Shape: sectioned node pages

`/nodes/$id` becomes a group of routes with a sub-nav, mirroring the Server
Settings group:

| route | what it answers |
|---|---|
| `/nodes/$id` | Overview — identity, OS, agent version, harness detection, sharing, key, delete |
| `/nodes/$id/service` | Who runs the agent, and the five verbs that act on the process |
| `/nodes/$id/config` | The node's own configuration: control-plane URL, allowed directories |
| `/nodes/$id/logs` | What the agent logged |

The nav is LOCAL to the node — a strip under the page header, not a new group
in the global rail. The rail lists Nodes, one entry, because a fleet of thirty
machines must not become thirty rail entries; a node's sections belong to the
node the way a subshell's tabs belong to the subshell.

Every section re-uses the Service page's own components where the question is
the same (`CopyableValue`, `FactCard`, the log viewer), and none of them is
generalized into a shared "managed process" abstraction. The server restarts
*itself*, is never offline to itself, and writes its config locally; a node is
remote, can be unreachable, and refuses on pane safety. That is two consumers
that differ in exactly the places an abstraction would have to paper over —
the same judgment `crates/desktop-core` documents for the two desktop apps.

## 3. What travels: three commands, protocol 5

The node link's version gate is exact-match, so this bumps
`NODE_PROTOCOL_VERSION` 4 → 5 and both sides ship together. `MIN_AGENT_VERSION`
and `apps/node/agent/package.json` rise in the same commit, per the rule in
`versions.ts`.

**`service`** replaces `restart` rather than joining it.

```ts
{ type: "service"; verb: "start" | "stop" | "restart" | "install" | "uninstall"; force?: boolean }
```

Folding restart in is the point: two commands that both drive the same service
manager would be two refusal paths, two audit actions and two chances to
disagree about pane safety. `restart` leaves the wire, `execRestart` becomes
one arm of the service executor, and the plane's restart route becomes one verb
of the service route. There are no deployed agents to keep compatible.

Pane safety is not restart's alone: `stop`, `restart` and `uninstall` all take
live panes down when the definition does not keep them, so all three carry the
`force` refusal. `start` and `install` cannot, and must not ask for it.

**`agent_log_read`** — named for the agent's OWN log, because `log_read` is
already a subshell's pane log and the two must never be confused.

```ts
{ type: "agent_log_read"; fromByte: number; maxBytes: number }
// → { text: string; nextByte: number; size: number; truncated: boolean }
```

**`set_server_url`**

```ts
{ type: "set_server_url"; url: string }
```

The agent rewrites `serverUrl` in its own `config.json`, keeping `nodeId`, the
node key and the pinned `controlPublicKey` — exactly what `subshell configure
--server` does, through the same function, because a second writer of that file
is a second set of rules for it.

## 4. The agent needs a log file, and this is why

**On Linux the agent has no log.** `createLogTransport` writes to the console;
launchd redirects that to a file on macOS, systemd sends it to the journal, and
`collectRuntime` reports `logHint` — a sentence telling a person to go run
`journalctl` — precisely because there is no file to name. "Read the log in the
browser" is therefore not a read of something that exists on the platform most
nodes run.

So the agent grows what the server grew for the same reason (spec 2026-09-12
§ 4.3): **one file, JSON lines, `<configHome>/logs/agent.log`, 0600 in a 0700
directory, capped at 200 KB and replaced when full, the same on every
platform.** Under the CONFIG home rather than the configured `dataDir`, because
logging starts before `config.json` is read and has to work on a machine that
was never enrolled — a daemon that cannot say why it failed to load its config
is the one you most need the log for. The console transport stays — journald and launchd keep getting
their copy, and `subshell run` in a terminal is unchanged — the file is added
beside it.

This is the one place the feature costs an agent change rather than a plane
change, and it is not optional: without it, `/nodes/$id/logs` would show a file
on macOS and a sentence about journalctl on Linux, which is not a surface.

`logPath` in the runtime report keeps its meaning (the manager's redirect, or
null); a new `agentLogPath` names this file. Both are shown — they are
different artifacts and a person debugging a service definition wants the first.

### What the log may contain

The same accounting as the server's own log, and the same conclusion: the set
of people who may read it is unchanged (0600 on disk, owner-or-`edit` on the
wire), and what widens is the set of PLACES they can read it from. An agent
logs launch failures, command refusals and connection errors; it does not log
pane content, and `docs/security.md`'s rule about not copying pane output into
diagnostics applies here verbatim. A subshell's bearer token is in the launch
argv, so **argv is never logged at any level** — pinned by a test, because this
is the one thing that would turn a log read into a credential read.

## 5. Routes

All three follow `restart-node.route.ts` exactly: cookie actor only, gate on
`nodeCanConfigure` (owner or `edit`), `local` refused with 400, the agent's own
refusal matched by equality against a protocol constant and mapped to an API
code, and an audit row.

| route | body | audit |
|---|---|---|
| `POST /api/nodes/:id/service` | `{ verb, force? }` | `node.service` with `{ verb, forced }` |
| ↳ `stop` / `uninstall` | owner only — see § 5.1 | same |
| `GET /api/nodes/:id/logs` | `?fromByte&maxBytes` | none — it is a read |
| `PATCH /api/nodes/:id/config` | `{ serverUrl }` | `node.config.update` with `{ key, from, to }` |

**`local` is refused by all three.** The control-plane host's node row is the
server; its service surface is `/settings/service`, its config writer is
`PATCH /api/admin/server/config`, and its log is
`GET /api/admin/server/logs`. Routing any of it through the node pages would
hand a node's `edit` grantee a way to stop or repoint the control plane. The
node pages link there instead.

### 5.1 The two one-way verbs

`restart`, `start` and `install` keep the restart gate — `nodeCanConfigure`,
owner or `edit`. They leave the node reachable: a restart comes back, and the
other two only make a running agent MORE supervised.

`stop` and `uninstall` are **owner-only**, for the same reason repointing is:
an `edit` grantee is trusted to interrupt a machine, not to remove it from the
instance until someone walks to it. The UI says so in the confirmation rather
than only in this document — "nothing here can start it again; that needs a
shell on that machine" — because the cost is invisible from a button that looks
like every other one.

`start` is offered only when the service is installed and not running while the
agent answers anyway, which is the one state where it means something: an agent
launched by hand with a definition sitting idle beside it. It is a no-op the
manager will refuse otherwise, and refusing it here would need the plane to
re-derive a state the agent already reports.

### Repointing is a real widening, and it is stated as one

`docs/security.md` calls `subshell configure --server` deliberately
unprivileged: it edits a 0600 file the local user already owns, grants the new
plane nothing, and merely changes where the machine announces itself. Doing it
**remotely** is not the same act. An `edit` grantee — not only the owner — can
point a machine at a host of their choosing, and the node then dials that host
with `Authorization: Bearer <nodeKey>`, disclosing a credential valid on the
old plane to whatever was typed. The machine also vanishes from this instance.

Three things bound it, and `docs/security.md` § 5 gains a paragraph saying so:

- **Owner-only**, not `nodeCanConfigure`. This is the one write in this spec
  that does not use the restart gate. An `edit` grantee may stop and start the
  agent — an availability act on a machine they were trusted with — but making
  it someone else's machine is not that.
- Audited as `node.config.update` with the old and new value, like the server's
  own config writes.
- Validated by component and stored canonicalized, and **loopback is refused
  outright**: a remote node pointed at `localhost` dials itself, which is the
  enroll-time trap the Nodes page already warns about, and here nobody would be
  sitting at the machine to see it.

## 6. About, in two places

Two different questions that happen to share a set of constants — and only one
of them needed building.

- **The plane already has one**, and it is in the right place: the user menu's
  About dialog (`components/about-dialog.tsx`), open to any signed-in user,
  carrying the instance name, the server version, the desktop shell's version
  when there is one, the licence summary, the links and the copyright. A
  `/settings/about` page would have been a second surface answering the same
  question from the same constants, which is the duplication this repo's own
  rule forbids. **Nothing was added here.**
- **An About section in Subshell Client's node window** — what this APP is,
  and the half that did not exist.
  The one-line footer under the assistant's bar goes away: a colophon under
  every screen reads as part of the question being asked. Its content moves
  into a section reached from the window's own nav, which is also what gives
  Linux — with no menu bar to carry a native About panel — a route to it.

Both render `crates/desktop-core`'s constants (Rust) and
`packages/subshell-protocol/src/legal.ts` (TypeScript), which
`scripts/license-fields.ts` already holds equal to each other and to the root
LICENSE. Neither introduces a third copy.

## 7. Testing

- **Protocol**: every new command round-trips through `parseNodeCommand`, every
  malformed shape returns null, and the version constant's bump is asserted
  against the frame set the way protocol 3's census is.
- **Agent**: the service executor's five verbs against a fake service module,
  including each refusal; the log file's cap-and-replace, its 0600 mode, and
  the argv-never-logged rule; `set_server_url` keeping nodeId/key/pin.
- **API**: each route's gate (bearer refused, `view` refused, `local` refused),
  each refusal mapping, each audit row, and — for config — that the write keeps
  every key it does not own.
- **SPA**: the sub-nav renders each section; a section acts only when the
  server says the viewer may; the log view pages.

## 8. Out of scope

- **Agent self-update from the plane.** The server's Update card is a desktop-
  only affordance backed by a bundled binary; a node updating itself over the
  wire is a different design (who signs it, what happens to live panes) and
  deserves its own spec.
- **A debug-logging toggle per node.** The server's is an instance setting
  applied live. The node equivalent needs a persisted per-node setting and a
  push on reconnect; the log file is the thing worth having first.
- **Reset.** It leaves the machine unenrolled, which is the one act that
  genuinely cannot be undone from the plane afterwards.
- **Starting an agent that is not running.** Not a scope decision but a
  structural one: the command channel IS the agent. Waking a stopped machine
  needs something that outlives the agent — a second local listener, or the
  service manager's own socket activation — and that is a different design with
  a different threat model.
