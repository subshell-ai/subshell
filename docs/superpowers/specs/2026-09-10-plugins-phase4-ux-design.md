# Phase 4 Design: The Plugin UX

Date: 2026-09-10
Status: approved design (brainstorm 2026-09-10), pending implementation plan
Parent: `2026-09-09-plugin-architecture-design.md` §10 (UI surfaces), §13 (Security), §15 (Phases)
Predecessor: `2026-09-09-plugins-phase3-registry-design.md`, whose §8 names two items this phase owns

Phases 1 through 3 built the whole plugin mechanism and left it reachable only
by CLI and `curl`. A node can install a harness from npm; no human can do it
from a screen. This phase is the screens: the first-run wizard, the node page's
Plugins card, and the Subshell Client node window.

It does not restate §10's UI sketch. It decides the things that sketch left
open, corrects two places where it no longer matches the code, and records one
protocol addition the parent spec assumed existed.

## 1. Scope

In: setup step 2 rewritten around "where will subshells run"; the `/nodes/:id`
Plugins card replacing the harness matrix, including installing a third-party
package by name; plugin identity (name, type, description, icon) reaching the
browser; `plugin_check_updates` and the protocol bump 2 -> 3; the Subshell
Client node window's Plugins card; deleting the setup write routes.

Out, each named so nobody drifts into it: settings schemas and per-plugin
settings pages (phase 5, and the node window never gets them at all, §2.7);
a plugin catalog served from anywhere but this build (there is no registry
search, and typing a name is how you install something we did not ship);
`turbo.json`'s missing `outputs` declaration (phase 3 §8 parks it as its own
task and this phase does not touch it).

## 2. Decisions

Five from the brainstorm (2026-09-10), plus the interface decisions they force.

### 2.1 The anonymous first-run write window is deleted, not narrowed

`POST /api/setup/plugins` and `DELETE /api/setup/plugins/:pluginId` go away.
Setup step 2 installs through `POST /api/nodes/local/plugins`, the same
owner-and-admin-gated door every other install uses.

This is safe because the wizard never used the anonymous window. `STEPS =
["Account", "Harness"]` and `setStep(1)` fires inside `register()` after a
successful sign-up (`apps/server/web/src/routes/setup.tsx`), so by the time
anyone can press an install button an admin exists and is signed in. The public
carve-out was only ever reachable by someone racing a fresh instance directly
against the API.

Consequences, all of them deletions:

- `requireHarnessAccess`'s `if (!(await hasUsersProbe())) return;` goes, and
  with it the whole "first-run boot wizard stays public" concept for writes.
  `GET /api/setup/harnesses` also stops being anonymous: it is read by the
  wizard only after registration and by the node page under a session, so it
  requires an authenticated actor always. `GET /api/setup/status` stays the one
  always-public setup route, because the login page needs it to find the wizard.
- §13's standing worry retires. That paragraph exists because "the same route
  with phase 3's npm fetch behind it, still anonymous on a fresh instance, is
  an unauthenticated caller making the host download and execute a package of
  their choosing". Once the route is gone the guard cannot rot, and phase 3's
  rule that the setup door stays embedded-only becomes a statement about code
  that no longer exists.
- **Correction to §10.1.** It says this phase "removes `PATCH
  /api/setup/harnesses/:id` and with it the public-write-during-first-run
  gate". That endpoint was already removed by phase 2b, and removing it did NOT
  remove the gate: the gate moved to the two `/plugins` writes above. §10.1 was
  written before 2b landed.

**The catalog read moves with it.** After the writes are gone,
`setup.route.ts` would exist to serve one list that is not about setup and that
the node page fetches on every visit. It becomes `GET /api/plugins/catalog`,
same shape, same auth. This is a rename rather than a redesign, and it is worth
the churn because `setup` naming a general-purpose read is the overloaded-word
regression AGENTS.md's vocabulary rule exists to catch.

### 2.2 Protocol 3: one new command, and it only reads

`NODE_PROTOCOL_VERSION` bumps 2 -> 3 for a single addition:

```
plugin_check_updates { id?: string }   ->  PluginUpdateWire[]
```

Applying an update is NOT a new command. The check returns the resolved target
version, and installing it is `plugin_install { id, spec: "<name>@<to>" }`,
the path phase 3 shipped and tested, whose claim guard already permits
replacing a directory when the package name matches (§2.4 of the phase-3
spec). Three reasons this beats a `plugin_update` that means "go get latest":

- **It is deterministic.** The operator is shown a version and that exact
  version is what installs. A command that re-resolves `latest` at apply time
  can install something the operator was never shown, if the tag moves between
  the click and the send.
- **A reading command cannot mutate.** No boolean flips this between reporting
  and installing, and the audit trail records an install as an install.
- **It reuses the tested path** rather than adding a second way for bytes to
  land on disk.

`MIN_AGENT_VERSION` is not bumped; the exact-match protocol gate is what
refuses a mismatched agent, in both directions.

### 2.3 The check reports every installed plugin, including the ones it could not check

Phase 3's `resolvePluginUpdates` returns rows only for sidecar-carrying
installs, and **omits** any whose check threw, with a warning to the log. That
was right for a CLI that prints warnings. It is a lie in a card, where an
omitted row is indistinguishable from "no update available".

So the wire type is a discriminated union covering every installed plugin, and
the node classifies rather than the browser:

```ts
export type PluginUpdateWire =
  | { id: string; kind: "registry"; name: string; from: string; to: string | null }
  | { id: string; kind: "embedded" }
  | { id: string; kind: "error"; message: string };
```

- `registry` with `to: string` is an update; with `to: null` the install is at
  or above `latest`, which covers both "current" and the pinned-downgrade case
  §2.6 of the phase-3 spec describes.
- `embedded` is a plugin with no `install.json`. It is not upgradable from a
  registry and never silently upgraded behind its operator, which the card must
  say rather than imply by absence.
- `error` carries the reason the check failed for that one plugin, so an
  unreachable registry is reported per row instead of vanishing.

This closes a finding phase 3 parked rather than inventing new behavior: the
classification already exists inside `resolvePluginUpdates`, it was simply not
expressible in its return type.

### 2.4 Plugin identity reaches the browser

`PluginReportWire` already carries `name`, `type`, `description`, `icon` and
`capabilities`. `effectiveHarnessStates` (`services/nodes/inventory.ts`) throws
all of them away, mapping each report to a row keyed by `harnessId` alone, and
the card recovers a name with `catalog?.find(...)?.name ?? h.harnessId`. A
plugin this build does not carry is therefore rendered by its raw id, which is
exactly the third-party case this whole revamp exists to serve.

`NodeHarnessViewSchema` gains `name`, `type`, `description` and `icon`, sourced
from the node's own report, and the card reads them directly. The catalog stops
being an identity lookup and goes back to being what it is: the list of what
this build can install offline.

Two properties worth stating because they are easy to lose:

- The name is **reported by the node**, so it is third-party-controlled text
  rendered in an operator's browser. It is normalized on the way out the same
  way every other label is (`normalizeDeviceLabel`'s sibling treatment), so it
  cannot carry control characters into a log line or a menu.
- `version` on a harness row stays the DRIVEN PROGRAM's version, not the
  plugin package's. The phase-3 spec's §2.4 is explicit about that distinction
  and the card must not blur it: a row shows "Claude Code 2.1.266" for the CLI
  and, separately, the plugin package version where one is recorded.

### 2.5 Setup step 2: "Where will subshells run?"

Two choices, because that is the decision a new user actually has, and the step
leads with the answer the scan supports.

- **This machine** runs the existing detection over the built-ins this build
  carries and leads with what it found ("Found Claude Code 2.1.266") behind one
  Install button that uses the embedded copy and touches no network. Everything
  else collapses into one "Add another" row.
- **Another machine** goes straight into node enrollment.
- **If the scan found nothing** the step leads with enrollment instead, and
  puts the catalog with per-harness install commands below it. A headless
  control plane is the common case here and telling that operator to install a
  CLI on the server is usually the wrong advice.

The step stays skippable, and the existing escape link to `/nodes` survives in
the "found nothing" arm. Copy loses the enable-flag language it still carries
("switch it on"), which has been wrong since phase 2b.

### 2.6 The Plugins card

Replaces the harness matrix at `/nodes/:id`. Rows carry the type badge, the
plugin name from §2.4, the driven binary's status (`found at
/home/theo/.nvm/.../claude, 2.1.266`), and Uninstall. A broken plugin gets a
distinct row carrying its load error, because a plugin that failed to load is
a thing the operator must see rather than an absence.

"Add a plugin" holds the catalog of built-ins as one-click Installs, plus a
field to install any package by name.

**Friction goes exactly where trust changes.** A catalog install is one click:
the bytes are in the binary and no network is touched. A name we did not ship
raises one confirmation naming the exact package and saying plainly that it
runs as the node's OS user with no sandbox, with the reach that implies. That
is the same trust decision as installing the CLI it drives (`docs/security.md`),
and it is the first place in the product where a browser click causes a machine
to fetch and execute third-party code.

Update affordances read §2.3's rows: an update offers Update (which installs
the pinned resolved version), `embedded` says it is not registry-managed,
`error` says the check failed and why. Checking is explicit, never automatic
(§2.7 below).

Manage controls are gated on `canManage`, matching the route: owner, or admin
for `local`. An offline node renders the card read-only and says why, which the
existing `inventoryStale` banner already half-does.

### 2.7 Update checks are asked for, never scheduled

The node resolves updates only when a human presses Check for updates. It never
resolves them as part of an inventory report.

- Inventory stays offline-safe. A node with no route to a registry must still
  report what it has, and entangling that path with a network call makes a
  disconnected machine's basic reporting fail.
- No node makes scheduled egress nobody requested.
- The check uses **each node's own `registryUrl`**, so a node behind a
  corporate mirror is asked about the registry it can actually reach. This is
  the argument that rules out the control plane doing the checking: the server
  has its own `SUBSHELL_PLUGIN_REGISTRY_URL`, and a server-side check could
  confidently report an update the node cannot fetch. It would also have to put
  the npm package name on the wire, reversing phase-3 §2.4's decision to keep
  `install.json` node-side.

### 2.8 The Subshell Client node window

A Plugins card on the bundled node page, driven by new `node_plugin_*` Tauri
commands over phase 3's CLI verbs.

**Install, uninstall and list only.** No settings pages, per §10.3, and no
update checking either: the node window exists to get a machine working, and
the server UI is where a fleet is administered. A person at that machine who
wants an update has `subshell plugin update` in the terminal beside them.

Every new command must land in three files at once, because
`ui/src/__tests__/ipc-acl.test.ts` pins exact set equality between the commands
`lib/ipc.ts` actually invokes, `commands.allow` in
`src-tauri/permissions/desktop.toml`, and the `permissions` array in
`src-tauri/capabilities/node.json`. That test is the reason this window's
surface cannot widen by accident, and the install-by-name confirmation applies
here too, through the app's existing `confirm-panel` idiom rather than a new
one.

The remote window is granted nothing, and nothing in this phase changes that.

## 3. Failure behavior, stated once

| failure | outcome |
|---|---|
| install by name, package does not exist | the node's error reaches the row verbatim, naming the registry it tried (phase 3 §3); nothing installed |
| install by name, id collides with a different package | refusal naming both packages (phase-3 §2.4); the operator uninstalls first |
| install by name, node offline | 409 before anything is sent, same as every other plugin write to a live-only node |
| check for updates, registry unreachable | every row comes back `kind: "error"` with the reason; no row silently disappears (§2.3) |
| check for updates, one plugin fails | that row is `error`, the others resolve normally |
| update apply, version vanished between check and click | the install fails naming the version; the previous install is untouched |
| a reported plugin name contains control characters | normalized at the view boundary (§2.4) |
| setup step 2, install fails | the step reports it inline and stays skippable; a wizard must never dead-end |

## 4. Security

Nothing here widens the trust model, and one thing narrows it.

- **Narrower:** the anonymous first-run write window is deleted (§2.1). After
  this phase the only always-public route in the product is
  `GET /api/setup/status` plus the pre-existing `GET /api/settings/instance`.
- **Unchanged:** installs stay owner-only (admin for `local`), machine
  credentials are still refused on these routes, and the node window's remote
  page is still granted no commands at all.
- **New surface, stated plainly:** a browser button can now make a machine
  download and execute third-party code. That was already true of the API and
  the CLI; what changes is who can reach it. The confirmation in §2.6 is the
  control, and `docs/security.md` gains a paragraph saying a plugin install
  from the UI is the same trust decision as installing the CLI it drives.
- **Third-party text now renders in the operator's browser** (§2.4). Normalize
  it, and do not put it anywhere that interprets markup.

## 5. Testing

- **protocol**: v3 parse cases for `plugin_check_updates` (absent `id`, string
  `id`, wrong types refused); the `PluginUpdateWire` union round-trips; v2 now
  refused by the exact-match gate.
- **pane-runtime**: `resolvePluginUpdates` classifies into the three kinds
  against the fake registry, including a plugin whose check throws (the row is
  `error`, not an omission) and an embedded plugin (the row is `embedded`).
  Verified red-then-green per house rule.
- **server**: the setup write routes are GONE (a test asserts 404, and the
  first-run anonymous probe that used to pass now fails); `GET
  /api/plugins/catalog` requires an authenticated actor; the node view carries
  name/type/description/icon and normalizes them; the check command forwards
  and its result shape survives the round trip.
- **web**: the card renders a third-party plugin BY NAME (the regression that
  motivated §2.4); a catalog install sends no confirmation; a typed name raises
  one and cancelling sends nothing; broken rows show their error; an offline
  node renders read-only; the three update kinds each render distinctly.
- **desktop**: `ipc-acl.test.ts` extended, and it fails if a new command is
  added to any two of the three files but not the third.
- **e2e**: spec 14 currently asserts the demo plugin's row BY ID precisely
  because names did not render; it flips to asserting the name, which is the
  cheapest possible proof that §2.4 landed. A new spec drives install-by-name
  through the browser against the fake registry, including the confirmation.

## 6. Landmines carried into the plan

- **The e2e fake registry is a spawned bun child** (`e2e/fake-registry.ts`)
  because the Playwright runner is Node and cannot host `Bun.serve` in process.
  Any new e2e work reuses it rather than rediscovering that.
- **Protocol 3 touches the census**: a new command must appear in the agent's
  endpoint/command coverage test in the same commit it appears in the parser.
- **A stale `dist/` produces false greens.** Workspace imports resolve through
  built output, so rebuild before trusting a downstream suite. This bit phase 3
  twice.
- **`npm` metadata for a freshly published package 404s briefly** on the
  packument endpoint while the per-version endpoint answers. Only relevant if a
  test publishes, but it wasted time once already.
- **The node window's three-file agreement** is exact set equality in both
  directions. Adding a command to `ipc.ts` alone fails the test, which is the
  intent; adding it to all three without using it fails too.
- **`version` on a harness row is the driven program's version.** Do not
  repurpose it for the plugin package version when adding update UI (§2.4).
