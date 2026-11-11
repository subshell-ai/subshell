# Plugin updates and bundled-vs-installed precedence — design (2026-11-10)

Status: awaiting approval.

Two related pieces of plugin version behaviour:

1. **Updates.** An admin can see that a newer version of a plugin exists on npm
   and install it, one plugin at a time or all at once, then restart the
   server when they choose.
2. **Server upgrades.** When the server changes, a built-in plugin id resolves
   to the **newer** of the copy this build compiles in and the copy on disk.
   The bundle wins when it is newer; the installed copy wins when it is newer;
   either way only a copy whose plugin-api version this host implements is
   eligible.

The operator's rules, stated 2026-11-10:

- Updates are detected against the instance's configured npm registry
  (`registry.npmjs.org` by default, an operator's mirror when set), and the
  bytes come from that registry.
- The update UI reads like the product's other update surfaces: a version pair,
  one action per row, an "update all" action, a confirmation, and a restart
  offered afterwards rather than forced.
- A server upgrade that bundles a newer plugin version uses that version; if
  the bundle is older than the installed copy, the newer installed copy is
  kept.
- The plugin protocol version decides what is allowed.

## 0. The shape in one paragraph

A plugin id inside the data dir now has two possible candidates: the **bundled**
copy compiled into this build, and the **installed** copy under
`<dataDir>/plugins/<id>/`. One pure rule picks the **effective** copy — the
installed one only when its package version is strictly newer than the bundled
version and its manifest parses (which is what enforces plugin-api
compatibility); ties and unreadable copies go to the bundle. The in-process
overlay loads the winning installed copy for built-in ids and answers getters
and merged lists from it; the report builder describes the effective copy and
does not import losing copies at all. Separately, the plugin settings page asks
an admin-only, 15-minute-memoized endpoint for npm `latest` versions of
registry-installed plugins, offers per-row and bulk installs through the
existing install door (integrity check, staging swap, load-check), and offers
a server restart once the admin is done. For a copy the process has already
imported, a restart is the only way new code takes effect, because the ESM
cache cannot be evicted; a copy imported for the first time after an update is
live immediately. The restart offer is driven by the server's
`restartRequired` fact, not by the fact an update happened.

## 1. What exists today (measured)

- `packages/pane-runtime/src/plugins-dir.ts`
  - `installPlugin` (line ~605) has one door: embedded bytes or
    `installFromRegistry`, with the embedded-first rules of the phase-3 spec.
  - `listInstalled` (~127) reads `package.json` per directory and records
    `version`; `broken` when it cannot parse.
  - `readInstallRecord` (~224) reads the `install.json` sidecar written by
    registry installs: `{ name, version, integrity, installedAt }`.
  - `refreshStaleBuiltIns` (~682) reinstalls an embedded copy whenever
    `sourceVersion !== installed.version` — **this includes downgrades** — and
    skips any directory with a sidecar.
  - `resolvePluginUpdates` (~640) asks npm `dist-tags.latest` for every
    sidecar'd install and returns `{id, name, from, to}` where `to` is null
    when not newer. No production caller exists.
- `packages/pane-runtime/src/registry.ts`
  - Built-ins are statically imported; the overlay holds only **non-built-in**
    installed plugins. `refreshInstalledPlugins` (~250) skips any installed id
    that `BUILT_IN_IDS` contains, with a once-per-process warning for a
    registry claim.
  - `getHarness`/`getNetworkPlugin` answer compiled-first, then overlay;
    merged lists append overlay entries whose ids are absent from the compiled
    set.
- `packages/pane-runtime/src/plugin-report.ts`
  - Loads every installed directory and reports the disk copy, including a
    registry copy that resolution never uses. `restartRequired` comes from the
    loader's content fingerprint.
- `packages/plugin-api/src/manifest.ts`
  - `PLUGIN_API_VERSION = 2`; `subshell.apiVersion` is required on every
    manifest, must be `1..PLUGIN_API_VERSION`, and a higher value is refused
    with both numbers. This is the plugin protocol version; no second field is
    needed.
  - The loader additionally checks required members by name per plugin type.
- `apps/server/api/src/api/plugins.route.ts`
  - `GET /api/plugins` is read for every authenticated actor and merges disk
    reports with this build's catalog.
  - `POST /api/plugins`, `PATCH/DELETE /:pluginId` are cookie-admin.
  - The row carries `version` (disk copy) and `builtIn` (this build carries the
    id) but no source, no `restartRequired`, and no effective/installed pair.
- `apps/server/web/src/components/plugins/installed-plugins-card.tsx`
  - The source label keys off `builtIn`, so a registry copy of a built-in id
    reads "this build" even though its bytes came from npm.
- The Updates page (`settings_.updates.tsx`, `components/updates/*`) is the
  product's established update vocabulary: running/newest cells, one action,
  a confirmation dialog where the act is destructive, a `role="status"` line,
  a restart waiter, and "Update all (n)" for the fleet.

## 2. Decisions

### D1. Effective copy, by semver, with the bundle breaking ties

For a built-in id the candidates are the bundled copy and the installed copy.
The installed copy is **effective** only when both are true:

- its package version is strictly newer than the bundled version
  (`semverLt(bundled, installed)`), and
- its manifest parsed, which means `apiVersion` is within this host's range.

Anything else — equal versions, an older installed copy, an unparseable copy,
a copy that fails its load-check — leaves the bundled copy effective. Ties go
to the bundle because it is the code this build was tested and shipped with.

For a non-built-in id the installed copy is the only candidate, as today.

A subtlety that forces the choice: a bundled copy **always** has an allowed
`apiVersion`, because its manifest is validated when the module loads and the
built-in test pins every bundled manifest to `PLUGIN_API_VERSION`. The gate
therefore only ever refuses a *disk* copy, which is exactly where a foreign
build can appear.

### D2. `subshell.apiVersion` is the protocol gate; no new field

`apiVersion` already versions the `SubshellPlugin` contract, is required in
every plugin's `package.json`, and is checked at parse. A plugin declaring a
higher version is refused with "this plugin needs plugin-api N, but this host
implements M; upgrade Subshell". Older versions parse, and the loader's
required-member check still refuses one that is missing a member. Using the
existing field avoids a second version that can disagree with it.

### D3. Registry installs are never overwritten at boot

A directory with an `install.json` sidecar is the operator's npm choice and the
record the updater needs to know which package and version to compare. Boot
leaves it alone even when the bundled copy is newer; D1 makes the newer copy
*effective* without deleting the operator's bytes. This also keeps the rule
honest when the bundle is older: nothing quietly downgrades the file the
operator installed.

### D4. Boot refreshes embedded copies only, and only upward

`refreshStaleBuiltIns` changes from "any version difference" to:

- refresh an embedded copy when the bundled version is strictly newer, or when
  the installed copy is broken (no usable version), and
- never refresh a copy with a sidecar, and never refresh downward.

This is what implements "if the bundle is older, keep the newer one" for files
on disk. The runtime half of that rule lives in D5.

### D5. The overlay becomes version-aware for built-in ids

`refreshInstalledPlugins` gains the bundled version per built-in id (read from
`readBuiltIn(id)`'s `package.json`) and applies D1:

- if the installed copy is newer, load it through the same runtime and put it
  in the overlay;
- if loading it fails, record `broken` and leave the bundled copy to answer;
- otherwise skip it, as today.

Precedence flips for exactly the cases the overlay can now hold:

- `getHarness`/`getNetworkPlugin` ask the overlay first, then the compiled
  registry. Safe because the overlay holds only non-built-ins (which the
  compiled registry does not contain) and winning built-ins.
- `allHarnesses`/`allNetworkPlugins` filter the compiled entries whose id the
  overlay holds, then append the overlay entries.
- `builtInHarnesses`/`getBuiltInHarness`/`builtInIds` stay compiled-only: they
  answer "what can this build install offline", not "what runs".

### D6. Reports describe the effective copy; losing copies are not imported

`buildPluginReports` (and therefore every row and every launch gate that reads
reports) describes whichever copy D1 makes effective:

- **Bundled effective:** identity, capabilities and settings come from the
  compiled plugin; version comes from the bundled copy's `package.json`.
  `restartRequired` is absent because no disk code is running.
- **Installed effective:** the disk copy is loaded and described exactly as
  today.
- **Installed would win but fails to load:** the bundled copy is described and
  the failure is carried as a separate fact (see below), rather than marking
  the whole row broken. Launches against this id work, so `broken` must not
  hide them.

Reports still iterate **installed directories only**. The effective-copy rule
does not synthesize a report for a built-in that is not installed: `installed`
is derived from report presence, so doing that would turn every catalog row
into an installed one and open the launch gate for plugins nobody installed.
Catalog rows keep no `version`, as today; the bundled version appears once the
plugin is installed.

A losing installed copy is **never imported**. Today the report loads every
installed directory, so a shadowed npm copy executes its module merely to
describe itself even though resolution will not use it. `listInstalled`
already answers version and manifest-level failure without executing code.

New report/row facts:

- `source?: "build" | "npm" | "unrecorded"` — where the **effective** bytes
  came from. `npm` requires a sidecar; `unrecorded` is a directory with no
  sidecar and no bundled counterpart; `build` is the bundled copy or an
  embedded installed copy (the copy that wins after a server downgrade). The
  card renders these as "this build", "npm" and "no record".
- `shadowed?: { version: string; source: "build" | "npm" | "unrecorded"; error?: string }`
  — an installed copy that exists but is not effective: its version, where its
  bytes came from, and the manifest or load error when there is one. The row
  renders it as a detail line so an operator can see both facts instead of
  only the winner.
- `version` becomes the effective version. `builtIn` keeps its existing
  meaning ("this build carries the id") and is no longer used for the source
  label.

Two rules keep `shadowed` from becoming noise:

- omit it when the installed copy is healthy and its version equals the
  bundled version (every seeded built-in after a refresh would otherwise
  "shadow" itself at the same number);
- carry the installed copy's source as well as its version, so a row can say
  an npm copy is present but not in use.

Pulling capabilities from a compiled harness needs one small addition: the
adapted `HarnessPlugin` (`packages/pane-runtime/src/plugin-adapter.ts`) keeps
`settingsFields`, `suggestedEnv`, `suggestedFlags`, `mcpSetup` and
`exitStatus`, but drops the raw plugin's `capabilities()`. The adapter gains
`capabilities(): string[]`, forwarded from the plugin, so a report built from
the bundled copy can answer the same field the disk path answers today. The
member is additive and the agent's built-ins go through the same adapter.

### D7. Update detection is a separate, admin-only, memoized read

Adding registry lookups to `GET /api/plugins` would spend a packument fetch on
every page load, including the launch pickers that read that route for every
user. Detection instead gets its own admin-only pair:

- `GET /api/plugins/updates` → `{ updates, errors, checkedAt }`, 15-minute
  memo, mirroring the server's release-index TTL;
- `POST /api/plugins/updates/check` → the Re-check act, drops the memo and
  answers the same shape. POST because it is an act with an outbound cost, the
  same reasoning as `POST /api/admin/server/update/check`.

Both the check and the act use the **instance's configured registry**
(`SUBSHELL_PLUGIN_REGISTRY_URL`, default `https://registry.npmjs.org`), not a
hardcoded npm. An instance pointed at a mirror must detect against that mirror,
or it would offer versions whose bytes the mirror cannot serve and hide
versions only the mirror carries. The fake-registry test seam is the same URL
override the install route already has.

`checkedAt` is epoch milliseconds, matching the release index. `updates`
contains only offers (`to` is always a concrete version). `errors` carries
`{ id, name, message }` for every sidecar'd plugin whose registry read failed,
so a single unreachable registry produces one entry per installed plugin and
the card can name what was not checked.

`resolvePluginUpdates` changes its comparison:

- only sidecar'd installs are checked;
- `from` is the **load-checked effective version**, supplied by the caller as
  a map from the reports. Applying D1 fully matters: a built-in copy that is
  newer but fails to load leaves the bundled copy effective, and the offer
  must compare against the version that is actually running. Computing this
  inside the resolver would mean importing plugin code from a comparison
  function; the report pass already did that work, so the caller hands its
  answer in.
- `to` is `latest` only when `latest` is strictly newer than `from`;
- a failed registry read produces an `errors` entry and no offer, rather than
  only a log line.

A sidecar'd copy that is currently shadowed by the bundle stays checkable: an
update to a version newer than the bundle can become effective. That is the
case a pinned built-in install exists for.

### D8. The update act installs; the restart is offered afterwards

`POST /api/plugins/:pluginId/update`, cookie-admin, mirrors the install act:

1. Read the sidecar. Absent → 409 saying this plugin's bytes come from this
   build and move with the server, so there is nothing on npm to install.
2. Re-resolve `latest` at act time (never trust the check's cached answer) and
   refuse when it is not newer than the effective version.
3. Call `installLocalPlugin(id, "<package>@latest")`. The `@latest` tag is
   load-bearing: a bare package name that names a built-in takes the
   embedded-first door, and a pin equal to the embedded version does too.
4. Audit `plugin.update` after the bytes land, with `{ pluginId, package, from,
   to }`.
5. Answer the updated row. No restart happens here.

The SPA offers a release-style confirmation before the first install. "Update
all (n)" runs the same endpoint **sequentially** over the available updates,
keeping per-row pending and error state; a failure does not cancel the rest,
and successes stand. Sequential rather than parallel because every install
swaps directories in one store, and a partial failure is easier to attribute
one at a time.

The restart is a page-level offer, not part of the install:

- It appears while **any** installed report carries `restartRequired`, so it
  survives a page reload and a different admin's tab, and it covers an update
  made from the CLI/API as well.
- With a supervised server it opens the existing `RestartDialog` (which owns
  the pane-safety warning) and waits through `useServerRestart`; the plugin
  queries are refetched after the new boot.
- On a server that cannot restart itself (no service manager, or a browser
  instance), the strip names the reason and the command
  `subshell-server service restart` instead of offering a button that would
  fail.

That last point is why the strip is not a blanket "restart after updating"
rule. A previously shadowed installed copy that becomes effective is imported
for the first time by the install's registry refresh, so its new code is
already running and no strip appears. The common case — replacing code the
process imported at boot — reports `restartRequired` and gets the offer.

Copy follows the product's rules: the dialog title is short and fixed ("Update
this plugin?" / "Update N plugins?"), the body carries names, versions and
consequences. It says new code may need a restart, not that one is certain.

### D9. Failure behaviour

| failure | outcome |
|---|---|
| npm unreachable during a check | per-row `error`, no offer; the existing installed copy is untouched |
| npm unreachable during an update | 409, nothing written |
| integrity mismatch | 409, staging removed, previous copy intact |
| package requires a higher plugin-api than the host implements | the existing load-check refuses before the swap; 409 names both versions |
| `latest` not newer than effective | 409 naming both versions; nothing written |
| no install record | 409: the copy came from this build and updates with it |
| newer installed copy fails to load | bundled copy answers; report keeps the installed version and error as `shadowed` |
| restart unavailable | update stands; strip names `subshell-server service restart` |
| two updates to one id overlap | last writer wins in the store; the SPA serialises its own queue, and this is no weaker than the existing install route |

## 3. API and UI surface

`PluginRowSchema` additions (descriptions mirror the reasons above):

- `source: "build" | "npm" | "unrecorded"` (absent on catalog-only rows)
- `restartRequired?: boolean`
- `shadowed?: { version: string; source: "build" | "npm" | "unrecorded"; error?: string }`

`PluginReportWire` gets the same optional facts; the type's comment loses the
stale "as the node describes it" wording, because the control plane has been
the only writer since the plugin inversion.

New update types in the SPA mirror the route shape:

```ts
type PluginUpdateRow = { id: string; name: string; from: string; to: string };
type PluginCheckError = { id: string; name: string; message: string };
type PluginUpdatesView = { updates: PluginUpdateRow[]; errors: PluginCheckError[]; checkedAt: number };
```

The Installed card:

- a row with an offer shows `v1.2.0 → v1.4.0` in its detail line and an
  `Update to 1.4.0` button beside Uninstall;
- `shadowed` renders as a muted detail line: the installed version and why it
  is not in use;
- the card header gains `Check for updates` and, when more than one offer
  exists, `Update all (n)`;
- a check error renders as a detail line naming the plugin whose check failed
  (`Could not check <name>: <message>`), not as a failed card;
- the source badge reads `source`, so a registry copy of a built-in id says
  `npm` when its bytes are the ones running.

Non-admins keep the readable list they have today; the update query is
admin-gated and does not fire for them.

## 4. Security

- The update act is the same trust decision as installing a plugin: a
  cookie-admin names a package that already exists on this instance, the bytes
  come from the configured registry over the existing integrity check, and the
  package's code executes in the server process after a restart. It is audited,
  and it is not a new door: `installLocalPlugin` is the one install function.
- The registry's SHA-512 integrity remains the only provenance guarantee;
  there is no signature check, and the caveat that a plain-http mirror trusts
  its own network is unchanged.
- Losing installed copies are no longer imported for reporting. That is a
  reduction in code executed from an unused, possibly incompatible copy.
- No automatic update and no restart without a person's press.

## 5. Non-goals

- No hot reload of plugin code the process has already imported; the module
  cache cannot be evicted, so restart remains the remedy for that case.
- No auto-update, no scheduled check, no update on boot.
- No npm dist-tag choice beyond `latest`.
- No node-agent changes: the agent does not load disk plugins after the
  inversion, and nothing here gives it one.
- No sidebar "Update available" notice for plugins. That notice is the server's
  today; adding a registry call to a global query is a separate decision.
- No signature, provenance or mirror management work.
- No changes to the plugin-api contract.

## 6. Testing

- **pane-runtime, pure rules:** installed strictly newer wins; equal/older
  loses; unparseable loses; a newer copy that fails to load falls back.
- **refresh:** an embedded copy older than the bundle is replaced; a newer one
  is left; a registry copy is always left; a broken copy is repaired.
- **overlay:** a winning built-in disk copy is loaded and answered by
  `getHarness`/`getNetworkPlugin` and appears once in the merged lists; a
  losing copy is not loaded and does not appear; the agent's overlay stays
  empty.
- **reports:** effective version/source for bundled and installed winners; a
  losing copy is not imported (fixture whose module would throw); `shadowed`
  carries version and error; `restartRequired` only for a stale installed
  winner.
- **API:** the row fields; the update check lists offers against the effective
  version, memoizes, and re-checks; admin gates; the update act installs from
  the fake registry, audits, and refuses no-sidecar/not-newer/protocol/integrity
  cases.
- **SPA:** version pair and Update button; confirmation copy; update-all
  sequential queue with one failure; check error line; restart strip with and
  without a restartable server; source badge from `source`.
- e2e is not extended for the first cut: the route tests drive the fake
  registry, and the card tests cover the interaction. Say so in the plan.

## 7. Docs and release notes

- `apps/server/api/AGENTS.md`: the plugin section gains the update routes and
  the effective-copy rule.
- `docs/security.md`: one paragraph on the update act reusing the install door,
  and on losing copies no longer being imported.
- Changeset for `@internal/server` (API and SPA ship together). No changeset
  for the internal packages; the plugin-api contract does not change.

## 8. Rejected approach

**Converge the store on boot: overwrite any installed copy the bundle beats.**
Simpler reporting, but it deletes the operator's npm bytes and the sidecar on a
server upgrade, destroys the record the updater compares against, and makes a
later npm version uninstallable-by-update until someone reinstalls by name.
Resolution can prefer the bundle without deleting what the operator chose.
