# Node credential hot-reload + Nodes-page status dot and filters

Date: 2026-10-10
Status: approved design, pre-implementation
Scope: `apps/node/agent` (daemon), `apps/server/web` (Nodes page). One change set,
two independently shippable parts (A ships in a node release, B in a server build).

## Problem

### A — re-registration silently no-ops against a running daemon

Incident (2026-10-10, operator machine): a node row was re-registered from the
dashboard; `install.sh → subshell setup` enrolled fresh credentials, printed
`Enrolled as …`, `subshell is enabled and running`, `done.` — and the node stayed
offline forever. The daemon (started 14:51 with the previous credentials) never
loaded the config the installer wrote at 16:41; it reconnect-looped with the
superseded bearer until a manual `systemctl --user restart`.

Mechanics, all verified at current `main`:

- `runSetup` (`apps/node/agent/src/setup.ts:215`) enrolls (rewriting
  `config.json`) and then calls `installService`.
- `installService` on Linux runs `systemctl --user enable --now`
  (`apps/node/agent/src/service.ts:~380`) — **`--now` on an active unit is a
  no-op**, so the live daemon keeps its boot-time config object.
- The dial reads the boot snapshot: `daemon.ts:890` and `daemon.ts:1229`
  construct the WebSocket with `config.nodeKey` from the object loaded at start;
  nothing re-reads config for the connection path.
- `service restart` deliberately refuses without `--force` because restart kills
  live panes (`service.ts:1267-1269`). That doctrine is kept: **nothing here
  restarts the process.**

Related facts this design rides on:

- `HEARTBEAT_MS = 15_000` (`daemon.ts:74`) — a beat already runs in steady state.
- `daemon.lock` is refreshed with `config.nodeId` (`daemon.ts:600`, doc at 397) —
  the lock must follow any identity swap or `status` lies.
- The retention pass already establishes live-reload doctrine: it "re-resolves
  the stored layer from `config.json` every run … lands on the next hourly sweep
  without a restart" (`daemon.ts:522-533`). Credentials get the same posture on
  the faster beat.
- A healthy daemon that is merely *reconnected* would also pick up on-disk
  config; a watcher (`fs.watch`) would go deaf on inode-replacing writers
  (the common Linux case) and needs a poll fallback anyway — the beat check is
  the same mechanism without the extra lifecycle.

### B — Nodes list: offline is invisible and the fleet is unfilterable

- Offline renders as `<Badge variant="muted">offline</Badge>`
  (`apps/server/web/src/components/nodes/node-row.tsx:127`), visually equal to
  the gray OS/arch chip beside it — an operator missed exactly this while a node
  sat dead for hours.
- The list has no search or filters; every other scannable surface in the app
  (`routes/index.tsx`) has search + a machine `Select` composed through a pure
  lib (`lib/subshell-filter.ts`).
- Subshells already settled this exact design question: on 2026-09-24 the home
  cards and list rows **replaced text status chips with the 6px `SubshellDot`**,
  with an operator ruling that node-offline is **red, not amber** ("a machine you
  cannot reach is an error state, not a caution", `subshell-dot.tsx` header).
  The Nodes page adopts the same state language.

## Design

### A — credential hot-reload on the heartbeat beat

**Contract:** a config written while the daemon runs lands on the next beat
(≤15 s) without a restart and without touching panes; a config that cannot be
read or parsed is a warn line and the connection keeps yesterday's working
bundle; the swap is atomic per connection-identity bundle.

1. On each heartbeat beat (same tick that refreshes `daemon.lock`), read and
   parse `config.json` and compare the **connection-affecting fields**:
   `serverUrl`, `nodeId`, `nodeKey`, `encryptKeyPair`,
   `controlEncryptPublicKey`, `controlPublicKey`. The criterion is
   **field equality**, not file-byte equality — a reformat/key-reorder must not
   cost a redial, and a field change hidden by formatting must not slip past.
   No field difference → nothing.
2. On difference → log `config changed; reconnecting as <new nodeId>`, close
   the plane WebSocket *without* entering the reconnect backoff, and redial
   using a **newly loaded config bundle** swapped in as one object. The lock
   write, heartbeat payloads, and `setDaemonState` all read the swapped bundle.
3. Failure handling: read/parse/validation failure → single warn line per
   change attempt (`config reload failed: …; keeping the running identity`),
   last-good bundle stays, retried on the next beat. A bad write mid-flight can
   therefore never drop a healthy connection's ability to keep working — worst
   case is the status quo (offline, loudly logged).
4. Non-connection fields (name, dataDir, retention settings) never trigger a
   redial; existing consumers of those keep their own resolution points.
5. The `set-server-url` command takes the same path for free (it only edits the
   config on disk today — with this it lands live).
6. Implementation-time verification (not a design choice): locate every capture
   of the boot `config` object reachable from the dial/crypto path
   (`link-crypto.ts:240-241` builds envelopes per-message from `config`;
   confirm the instance does not pin the old object anywhere) so the swap is
   genuinely atomic — plan must enumerate the sites.

**Why not installer-side fixes:** a silent restart violates the pane doctrine;
a loud "restart required" message leaves every honest install still printing
"done." while offline. Hot-reload makes the original message true.

**Tests** (daemon's injectable-deps style, `apps/node/agent/src/__tests__/`):

- healthy socket + config write with new id/key → exactly one controlled
  reconnect, dial headers carry the new `nodeKey`, `daemon.lock` and
  `status` report the new id, and **zero** pane-teardown calls.
- unparsable config written after a good one → warn line, connection stays,
  a subsequent valid write lands.
- byte-identical rewrite (touch, same content) → no reconnect.
- non-connection field change only (e.g. `name`) → no reconnect.
- `serverUrl` change → redials at the new URL.

### B — Nodes page: dot instead of chip, plus filters

**Status dot (tiles and table rows):**

- Remove the `online/offline` `Badge` from `node-row.tsx` and the equivalent
  cell in `node-table.tsx`.
- New `NodeStatusDot` — 6px (`h-1.5 w-1.5 rounded-full`), same geometry as
  `SubshellDot`, colors from the same tokens: online → `bg-success`, offline →
  `bg-destructive`. It sits **before the node name** in the identity column.
  No blink (a node is not "working"), no amber tier — deliberately matching the
  subshell standard, including its no-caution-for-unreachable ruling.
- It is a node-domain component, not an import of `SubshellIndicator`
  (different state space); a later unification into a shared Dot primitive is
  welcome but out of scope. If the unmerged `status-dot-badges` branch lands
  first, rebase onto its primitives rather than forking colors.
- Accessibility: on the subshell rail the dot is `aria-hidden` because the row
  text carries state; here the chip is gone, so the dot is the **only** carrier
  → render with `role="img"`, `aria-label` and `title` = `online` /
  `offline · seen <relative>` (the seen-time joins the words the chip's line
  already had; `maintenance`/`inventory stale` chips remain separate, they are
  warnings and warnings never hide).
- The hostname line keeps `· seen …· v…` unchanged.

**Filters (both `tiles` and `list` views; `keys` tab untouched):**

- Toolbar above the list, aligned to the home page's pattern:
  - Search `Input` — case-insensitive substring across `name` and `hostname`
    (fallback `id` when hostname is null, matching what the row displays).
    Placeholder: `Search by name or hostname…`.
  - Status `Select`: All / Online / Offline.
  - Access `Select`: All / Yours / Shared (`access === "owner"` vs not — the
    same reading the `yours` / `shared · <access>` chips use).
- AND-composed. Page state, not URL (home precedent: "the machine filter is
  page-level"; the existing tab stays URL-encoded as is). Filters apply
  identically to both views; counts above the list (if shown) reflect
  filtered/total.
- Zero-match empty state: "No nodes match" + a `Clear filters` action that
  resets all three (distinct from the existing "No nodes yet" state, which is
  about enrollment, not filtering).
- Pure helper `lib/node-filter.ts` (`filterNodes(nodes, { query, status,
  access })`) mirroring `lib/subshell-filter.ts`; all logic lives there.

**Tests:**

- vitest for `node-filter.ts`: each axis alone, AND-combination, null-hostname
  fallback, empty results, no mutation of input.
- Nodes-page component test (pattern: `routes/__tests__/nodes-page-gate.test.tsx`):
  offline node renders `bg-destructive` dot and no status chip; dot exposes the
  aria label; filtering to "Online" hides the offline row; zero-match shows
  Clear filters.

## Out of scope

- The install-time "verify the daemon actually connected before printing done"
  step (hot-reload makes the current message true; a verification probe is a
  separate contract with the plane).
- `installService`'s wording; `service restart`'s pane doctrine (unchanged).
- The unmerged `status-dot-badges` branch's home-page concerns.
- Any pricing/credit surface — Part A/B touch none.

## Success criteria

- Reproducing the incident (re-register a running, healthy node) leaves the
  plane-connected within one beat (~15 s) with zero operator action and zero
  pane loss; `daemon.lock`/`status` show the new id.
- An offline node is unmistakable on the Nodes page at a glance, screen readers
  hear its state, and an operator with a mixed fleet can reach
  search+status+shared in one click each with results in the URL-stable tab UX.
