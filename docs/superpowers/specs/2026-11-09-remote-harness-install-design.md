# Remote harness install

## Why

A node page lists every harness the instance offers and marks the ones whose
CLI is not on that machine. On the control-plane host an admin gets an
**Install** button on each missing row; on an enrolled node the row just says
"not installed". The asymmetry is deliberate today (spec 2026-09-10 §6.2 and
spec 2026-09-11 §11 put remote installs out of scope), but it leaves the one
person who can already configure that machine with no action and no guidance
in the page: finding the command means reading the plugin manifest or the
vendor's docs, then opening a shell on the node.

This design reverses that scope decision for built-in agent harnesses. The
node page gains an Install button on an enrolled node's missing row, gated to
the machine's owner or a Manage grantee, running the same vendor line the
local installer uses under the same bounded runner.

## Goals

- An owner or `manage` grantee sees **Install** on a not-installed agent
  harness row on an enrolled node.
- Pressing it installs that CLI **on that node**, not on the control-plane
  host, and reports the same result shape the Update row already renders
  (`ok`, `exitCode`, `output`, `durationMs`, `timedOut`).
- Only built-in plugins' compiled-in `install.command` may run. Nothing in the
  request body chooses a command.
- The run is browser-cookie-only, audited, bounded at ten minutes, and shares
  the existing per-node harness-run serialization with Update, so two package
  managers never race over one filesystem.
- After the run the node's cached detection is refreshed, so the page's
  installed/missing row catches up on its ordinary 5-second poll.
- The control-plane host's existing admin-only install path is unchanged.

## Non-goals

- Third-party (registry-installed) plugin install commands. Those remain
  copy-only guidance, per spec 2026-09-10 §6.2.
- A unified node-scoped route for `local`. The setup route already owns that
  act with the admin gate, and the card keeps using it.
- Streaming the installer's live output from the node. The node command
  answers once, like `harness_update`; the rule shows a spinner and the
  result when it lands.
- Installing anything other than a harness CLI (tmux, network daemons, node
  binaries).
- Changes to plugin manifests, the launch path, or detection rules.

## Decisions

### Send a signed command, don't ship binaries

| Approach | Why not |
|---|---|
| Run the installer on the plane and copy artifacts to the node | The vendor script installs through the machine's package manager and PATH; copying a binary is a second, unrelated install mechanism and would not reproduce the vendor's layout. |
| Reuse `harness_update` with the installer line | Update is a configure act (`nodeCanConfigure`, which includes `edit`) and already falls back to the installer. Installing is a stronger act on the machine; reusing the verb would either loosen update's gate or overload its audit story. |
| Ship a copy-command block only | Honest but does not answer the page: a person still has to leave the UI, open a shell, and re-check. |
| **Add a signed `harness_install` node command** | Sibling of `harness_update`: same transport, same bounded runner, same result shape, distinct verb and gate. **Chosen.** |

### Authorization is the owner/manage band

The route requires a browser cookie and `gate.canManage`. On an enrolled node
that is exactly `nodeCanManage(access)` — owner or a `manage` grantee. `edit`
is not enough: editing configuration changes how the machine is used, while
installing software changes what is on it. Admins on a foreign node carry
`access: edit` (the admin boost never ranks an agent as owner), so they cannot
install on someone else's machine; that matches ownership transfer and the
other owner-only acts.

The local path keeps its own rule (`canManage`, which is the admin answer on
`local`).

### Built-in ids only

`harnessInstallCommand(id)` resolves the plugin through `getHarness`, requires
`type === "agent-harness"`, requires the id in `builtInIds()`, and returns a
non-empty `installHint.command`. The route also requires the instance to
currently offer the plugin (`enabledHarnessPlugins`), the same refusal Update
carries, so a stale id cannot install a CLI the page does not list.

A manifest parser already refuses a privileged line (`sudo`/`doas`/`pkexec`)
at load. The shell line is therefore compiled-in data, never request input.

### Protocol 29

Adding a command changes the wire, and node/server pairing is exact-match.
`NODE_PROTOCOL_VERSION` moves 28 → 29; `MIN_NODE_VERSION` moves 3.5.0 → 3.6.0
(the published agent is 3.5.1, so the floor is one minor above it);
`apps/node/agent/package.json` moves to 3.6.0 in the same commit.

Wire shape:

```ts
| {
    type: "harness_install";
    /** Harness plugin id, echoed in the answer for correlation */
    harnessId: string;
    /** Shell line that installs the CLI (the manifest's install.command) */
    command: string;
  }
```

The frame parser refuses an empty id or blank command, like
`harness_update`. The answer reuses `NodeHarnessUpdateResult` and
`parseNodeHarnessUpdateResult` — the payload is identical (`harnessId`, `ok`,
`exitCode`, `output`, `durationMs`, `timedOut`), and keeping the exported name
avoids a breaking rename in the published protocol package. Its documentation
widens to "a harness command run" rather than "an update".

### The node runs it like an installer

A new `execHarnessInstall` calls the same `runBounded(["sh", "-c", command])`
as the update executor, with a ten-minute deadline and the noun "installer" in
the timeout marker. The daemon puts `harness_install` on the **same** private
chain as `harness_update` (renamed `harnessRunChain`), so installs and updates
on the node queue among themselves and never hold pane effects behind a
package manager.

### One run slot per node, shared by install and update

The plane-side per-node lock moves out of `harness-update.service.ts` into
`harness-run-lock.ts`:

```ts
claimHarnessRun(nodeId, id, verb: "install" | "update"): HarnessRunClaim | HarnessRunRefused
```

The holder records the id and verb, so a refusal says what is already running
(`"codex" is already being installed on this node.`). On `local` it still also
takes the process-wide `claimLocalRun` slot, so update and the existing local
installer cannot overlap. Both routes claim before the response body opens; a
racing press is a 409, never an error frame over a 200.

### Route and frames

`POST /api/nodes/:id/harnesses/:pluginId/install`:

- Cookie sessions only (`requireCookieActor`).
- 404 for an invisible/absent node; 400 for the `local` node (the setup route
  owns it); 403 when the viewer is below the manage band.
- Refusals before the body opens: unknown plugin (404), not built-in (400),
  not offered by the instance (404), no install command (400), node offline
  (409 `NODE_OFFLINE`), run slot taken (409).
- NDJSON, the same protocol as `/update`: `{type:"waiting"}` heartbeats every
  five seconds (Bun closes a response silent for ten), then exactly one
  `{type:"done", ...result}` or `{type:"error", message}`. A node sends no
  `line` frames, because the command answers once.
- Audited as `node.harness.install` with plugin/outcome metadata, and
  `node.harness.install.unknown` only when a timeout or dropped socket leaves
  it unknowable whether the command ran. Output is never logged.
- After the run, `detectOnNode(nodeId)` refreshes cached detection; a failed
  refresh is logged and does not change the run's result.

`installHarnessOnNode` takes an optional `{ send?, detect? }` seam defaulting
to the real node RPC and detection refresh, following
`detectOnNode(nodeId, deps)`. The route tests pin refusals; the service tests
pin the run and report without needing a live socket.

### Client

`useInstallAgent` grows an optional second argument, so existing callers keep
their place: `useInstallAgent(onLine?, nodeId?)`.

- no `nodeId` → `POST /api/setup/agents/:id/install` (existing local path);
- `nodeId` present → `POST /api/nodes/:nodeId/harnesses/:id/install`.

Its result type makes `harness` optional (the remote answer carries none) and
adds optional `timedOut`. On settle it invalidates the harness registry and,
when a node id was given, `["node", nodeId]` so the row updates immediately
rather than at the next poll.

The harness card's gate becomes:

```ts
const canInstallHere =
  data?.kind === "local"
    ? data.canManage
    : data.access === "owner" || data.access === "manage";
const installReachable =
  data?.kind === "local" || (data?.status === "online" && data?.held === null);
```

The row still hides Install unless the row is missing its program and the
registry row is an agent harness with a non-empty command. On an enrolled
node the button is disabled when the node is offline, with the reason in its
accessible description, rather than trading a press for a 409. While a remote
run is in flight the row says "Running the installer on this node…"; the
local row keeps its streamed installer lines. The command explainer says the
line runs "on this node, as the user the subshell daemon runs as" for an
enrolled node, and keeps the server-user wording for `local`.

## Security accounting

This is the same class as §11.10c (harness update), with a stronger gate:

- The only input is a plugin id and a node id. The command is the built-in
  manifest's `installHint.command`; a request cannot supply or alter it.
- The command travels the existing signed node link. A compromised control
  plane could already run `harness_update`; the new verb does not widen what a
  compromised plane can execute on a node.
- Browser-cookie-only; bearer keys are refused because a machine credential
  cannot order a package manager run.
- Owner/manage gate; `view` and `edit` grantees, and admins without a manage
  grant on that agent node, are refused.
- `runBounded` keeps the allowlisted environment (no node bearer token, no
  server secrets), login-shell PATH, closed stdin, ten-minute deadline, reader
  cancellation, and 64 KiB per-stream capture. The output is a bounded
  disclosure to the caller's browser and is not logged.
- The run holds the shared per-node slot, so it cannot overlap an update or a
  second install on the same machine.
- Install, unlike update, is restricted to built-in ids, so a registry plugin
  cannot introduce a shell line that reaches a node; third-party installs
  remain copy guidance.

Residual: installing a built-in CLI can execute code on the node as the user
the daemon runs as. That is the act the owner is asking for; the line is the
vendor's own and the same one the local install route runs.

## Test plan

- Protocol: `harness_install` body parsing accepts the shape and refuses an
  empty id/blank command; the version bump and floor move together.
- Node: the command runs through `sh -c` and reports exit code/output; a
  non-zero exit is a result; the daemon chain orders install and update
  together without blocking pane effects.
- Server service: built-in-only command lookup; refusals for unknown,
  non-built-in, no command, and not-offered; the shared slot refuses a second
  run and releases after; a remote run sends the command, validates the
  echoed id, and refreshes detection; malformed answers throw.
- Server route: 401 without a session, 403 for bearer and for view/edit,
  400 for the local node, 404 for unknown or not-offered, 409 for offline and
  a taken slot; a successful stream ends in one `done`.
- SPA: owner/manage see Install on an agent row and POST the node-scoped path;
  edit/view do not; the local path is unchanged; offline disables with a
  reason; a failed remote run renders its output under the row.

## Release

Changeset: `@internal/server` minor, `@internal/node` patch,
`@internal/desktop-server` patch, `@internal/desktop-client` patch,
`@internal/docs` patch. The protocol package and server web are ignored by
changesets; describe the SPA work in the server changeset. Node protocol 29
means enrolled nodes need subshell 3.6.0; older nodes stay held until they
update, as with every prior bump.
