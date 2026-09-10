# Design: Plugins Move to the Control Plane

Date: 2026-09-10
Status: approved design (brainstorm + spike 2026-09-10), implemented; §4/§5 amended by the final review (see below)
Supersedes: `2026-09-09-plugin-architecture-design.md` §6, §8.1 to §8.2, §10, §11; and in full
`2026-09-10-plugins-phase4-ux-design.md`, `2026-09-10-plugins-phase5-settings-design.md`

## Amendment (2026-09-10, final whole-branch review)

Three findings from the final review changed what ships; they are recorded here
because the text below was written while nodes still held the manifests.

**§5's ready-env report moved to the `detect` round trip.** The design had the
node report, at `ready`, the values of the variables "a manifest declares it
needs" — written while §5 and §6 were still one timeline, with the node's own
plugin directory as the source of the NAMES. §6 then removed that directory: a
post-inversion node holds no manifests and cannot know what to declare, so a
fresh node always reported `env: {}`, and the §11 landmine (§11's named case)
fired on every machine with `CLAUDE_CONFIG_DIR` set: resume silently never
offered itself. Resolution: the PLANE names the variables (the union of
`subshell.hostEnv` across its enabled manifests, on every `detect` command),
the node answers values for the names it has. `ready` keeps `homeDir`; the
declaration-set field is gone. Protocol 3 is unshipped, so the frames amended
cleanly.

**§5's "the node still supplies its own executable path" ships as a reported
self-invocation, not a path.** The launch frame's MCP content is now written
node-side verbatim, so a single PATH would not do: under an interpreter run the
agent's exec path is `bun`, and `bun mcp` is not a command. The agent reports
its full `selfInvocation("mcp")` — `{command, args}` — on `ready` as
`mcpLaunch`, and the plane composes the registration from it. Same node
self-knowledge §5 intended, one field that cannot be answered wrong.

**§4's `versionArgs` was never built, and will not be.** The sketch listed a
`versionArgs` field per detect spec; grep confirms it exists nowhere in the
protocol, the agent, or the plugins. Every probe has always run `--version`,
byte-identical to pre-inversion behavior, so the field would have been wire
surface with no consumer. The sketch stands corrected to what shipped: specs
carry `{ id, binaryName, envOverride, knownPaths }` plus node-level `envNames`,
answered by `{ results, env }`. The version probe gained what the sketch lacked
but the mechanism needed: a 4 KiB output cap (a megabyte-scale `--version`
answer would ride a 1 MiB frame budget and cost the node its detect round trip).

**Carried follow-ups from the final review: ALL EIGHT addressed the same
day** (branch `follow-ups-2026-09-10`). The parity gate's fixture map now
throws for a built-in it does not know, in the same voice as the
missing-harness guard beside it. `brokenInstalledPlugins()` is GONE: the
`refreshInstalledPlugins` result plus `syncPluginRegistry`'s logging is the
read path, and a getter mirroring the overlay was a second copy of the same
state; the boot worry behind it (a throwing prepare leaves the overlay
unresolved) is answered at its root instead of with a branch nothing can
enter — the pass is total by construction, and a test pins that totality
with a `<dir>/plugins` that is a regular FILE, failing every guarded step at
once. The uninstall dialog retires a row's stale failure when a later toggle
succeeds, and `useUninstallInstancePlugin` invalidates the profiles queries
(`mode=delete` sweeps them across every user); both are pinned by page
tests. A node view's harness rows carry the instance store's `name` and the
node page renders it — an id is an identifier; a row a person reads gets a
label. The e2e suite runs on a deliberately generous test/expect budget
(the final review named the defaults its flake class under load; the fix is
the budget, not the assertions). The remote-manager test file runs the boot
migrator against the shared test-mode DB and passes standalone and as a
directory — its read of the directory allowlist goes through the requestless
context, not the file's private `:memory:` handle, which is why a
hand-curated migration list could not fix it. And the plugins-route impact
fixture's owner split is deliberately asymmetric (caller two rows, alice
one), so the pin distinguishes "distinct owners" from "others' profiles";
the daemon test now removes its per-harness /tmp dataDirs at file end
(a fresh run leaves zero).

Phases 1 through 3 put plugin packages on every node: `<dataDir>/plugins/<id>/`,
installed and updated per machine, loaded there, and reported to the control
plane. Designing phases 4 and 5 against that model produced a run of problems
that all had one root, and this document changes the root instead of continuing
to work around it.

**Plugins now live on the control plane only. Nodes execute what they are told
and hold nothing.**

Plugins themselves are unchanged as a concept: real npm packages, third-party
authorable, `@subshell-ai/plugin-api` still the contract. What changes is which
machine loads them.

## 1. Why, with the evidence

The design was reconsidered because per-node plugins kept generating
complexity in the phases built on top of them. Every one of these exists ONLY
because a plugin can differ per machine:

- **Phase 5 §2.6's resolution ladder.** An unpinned profile has no single node,
  so "which node judges these settings" needed a four-step rule and still ended
  with a documented wrinkle that the judge may not be the launcher.
- **Phase 5's templates.** Their entire purpose is copying settings between
  machines that each hold their own copy of a plugin.
- **Phase 4's update machinery.** Checking, reporting and applying per-node
  versions, with a three-way union to describe what a check found.
- **The question "which node's schema is authoritative"**, which has no good
  answer when two nodes run different versions of one plugin.

A spike (2026-09-10) measured whether the alternative is even possible. Three
findings decided it.

**Plugin code barely touches the machine.** Across all five built-ins, every
member is pure or a pure function of inputs, with exactly one exception:
claude-code's `resume.canResume`, which does an `existsSync` and reads
`CLAUDE_CONFIG_DIR`. That one is already delegated over the wire as
`probe_resume`. Detection is already manifest DATA, not code, so a scan loads
no plugin. Only `parseVersion` runs plugin code node-side, and only hermes
implements it.

**The duplication already exists, deliberately, with a tie-breaker.** The
server computes a subshell's MCP file content in `planRemoteSubshellMcp`, sends
it, and `apps/node/agent/src/commands/launch.ts` re-runs the identical plugin
function on the node and prefers its own answer with a drift warning. The
registration's `args` and `env` never ride the wire at all. One computation,
two machines, and a documented rule for when they disagree.

**The node-side check that would be lost is not the protection it looks
like.** `resolveLaunchPlugin` validates the plugin ID, while `profile.flags`
flows into argv verbatim in every plugin and the only validation is "starts
with a dash", inside `validateGenericProfile`, which nothing calls. A
compromised control plane can already put arbitrary tokens in the argv of any
launch.

The one genuine argument for node-side execution survives and is answered in
§4: `launch.ts:14-19` says the wire carries only INPUTS because a resolved
binary path can go stale between an inventory and a launch. That is a freshness
requirement about a fact the NODE owns, not a requirement that plugin code live
there.

## 2. What moves, what stays

| | before | after |
|---|---|---|
| plugin packages | `<dataDir>/plugins/` on every node | `<SUBSHELL_SERVER_DATA_DIR>/plugins/` only |
| who loads plugin code | every node, and the server for `local` | the control plane, always |
| who may install | each node's owner | an admin, since one install serves every node |
| detection rules | manifests on the node's disk | sent with each probe request (§4) |
| `parseVersion` | on the node | on the control plane, over reported raw text |
| argv | built on the node | built on the control plane (§5) |
| MCP `args`/`env` | recomputed on the node, never sent | computed once, sent |
| a plugin the plane never heard of | supported, celebrated | impossible by construction |

Unchanged and explicitly still true: plugins are npm packages
(`@subshell-ai/plugin-*`, already published at 0.0.1); `@subshell-ai/plugin-api`
is the contract; the manifest format of §4; detection metadata as data (§7);
the `packages/pane-runtime` split (§14); the licence boundary; and the whole
npm publishing pipeline, which is unaffected.

## 3. The node is a dumb executor

The node holds no plugin packages, no manifests, and no cached plugin state. It
does four things, all driven by data in the command that asks for them: probe
for a binary, write a file, spawn under tmux, and report what happened.

This is a deliberate simplification past the alternative of caching manifests
as data. The node no longer has a concept called "plugin" at all, which means
there is no second copy of anything to drift, no seeding, no reconciliation,
and no state to migrate when a plugin changes.

The property this gives up is stated plainly: **a node can no longer refuse a
launch on the grounds that it does not have the plugin.** It can and does still
refuse when the binary is absent, which is the failure an operator actually
hits. §1's third finding is why this is a smaller loss than it appears.

## 4. Detection: on demand, cached, never swept

Detection runs when someone asks: opening a node's page, pressing Re-check, or
launching. There are no background sweeps and no periodic traffic.

```
server -> node   detect { specs: [{ id, binaryName, envOverride?, knownPaths? }], envNames }
node   -> server { results: [{ id, found, path?, rawVersion?, reason? }], env }
```

- The specs come from the manifests, which the control plane holds. The node is
  told what to look for each time and remembers nothing.
- The node returns RAW version text. `parseVersion` is plugin code and runs on
  the control plane.
- **Results are cached server-side with a `checkedAt` stamp and rendered as
  last-known with their age.** Caching an answer someone asked for is not a
  sweep, and without it a node page would forget everything between visits. The
  existing `inventoryStale` concept covers exactly this and stays.
- The launch picker renders last-known rather than fanning probes across a
  fleet. An operator who wants certainty presses Re-check on the node.

## 5. Launch: the argv is built here, the binary is resolved there

The freshness argument from §1 is answered by late binding rather than by
shipping code. The launch command carries the argv the control plane built, with
a placeholder where the binary goes, plus the rule for resolving it:

```
launch {
  ...existing fields...,
  argv: string[],                 // "@@HARNESS_BINARY@@" wherever the binary belongs
  resolve: { binaryName, envOverride?, knownPaths? },
  mcp?: { path, fileContent, args, env },   // args and env now ride the wire
}
```

The node resolves the binary at the moment of launch, substitutes it, and
spawns. So the path is as fresh as it is today, and the node still refuses with
`harness binary missing: <id>` when it cannot find one.

`mcp.args` and `mcp.env` now travel, which deletes the double computation and
the drift rule with it. The one thing the node still supplies for itself is its
own executable path for the `subshell mcp` invocation, which is node
self-knowledge and not plugin knowledge: it stays a placeholder the node fills,
for the reason `selfInvocation` already exists.

`canResume` follows the same shape, with one wrinkle the plan must not
improvise. The plugin computes the candidate path, but claude-code's
`claudeConfigDir()` reads `CLAUDE_CONFIG_DIR` from the environment of the
machine the pane will run on, which the control plane cannot see.

**The node reports the environment values a manifest declares it needs**, and
nothing else:

```
node -> server        { env: { CLAUDE_CONFIG_DIR: "/home/theo/.claude" } }
server                path = <plugin computes it from cwd + env>
server -> node        path_exists { path }
```

The reported set is driven by what manifests declare, so it grows deliberately
rather than a node shipping its whole environment to the plane. All plugin
logic stays here, which is the point of the inversion.

**`probe_resume` is renamed `path_exists` and generalized.** Once it carries a
computed path and answers whether it is there, it is a general capability with
one caller rather than a resume-specific command, and a name describing what it
does is what stops the next person adding a second near-identical probe. The
protocol is already breaking here, so the rename is free.

## 6. Installing a plugin

Unchanged machinery, one location. `<SUBSHELL_SERVER_DATA_DIR>/plugins/<id>/`
is where packages land, which is where `local`'s already are, so the installer,
the npm registry client, the vendored tar reader, the integrity check, the
staging-and-rename swap and the `install.json` sidecar all survive as written
and simply stop being per-node.

**Installing is an admin act.** One install serves every node, so it cannot be
a node owner's decision any more. This replaces the owner-only rule of the
`POST /api/nodes/:id/plugins` route, which goes away along with its DELETE.

What is deleted rather than moved: the agent's `<dataDir>/plugins/` directory
and its seeding, the `subshell plugin list|install|uninstall|update` CLI verbs,
and the `plugin_install` / `plugin_uninstall` commands. An upgraded agent stops
reading the directory; with no users to migrate, it is left on disk rather than
being removed by code, and can be deleted by hand.

### 6.1 Disabling, and what uninstalling does to profiles

**Disable already exists; it just has no switch.** A profile's availability is
COMPUTED rather than stored: `profiles.route.ts` filters by harness usability,
and its own comment records the intent, that "re-enabling/installing the
harness brings them back, nothing here is ever deleted". There is no `disabled`
column on a profile and none is added.

So a plugin gains an **`enabled` flag**, consulted by `harnessUsable` and
`usableHarnessIds`, and disabling one makes its profiles vanish from every list
and picker and return untouched when it is re-enabled. No per-profile state,
nothing to drift.

**Where the flag lives matters.** NOT in `install.json`: the installer rewrites
that sidecar on every install, so a flag there is silently lost on update, the
same trap §2.4 of the superseded phase-5 spec found for node settings. It lives
in a small table, `plugin_state (plugin_id PK, enabled, updated_at)`, where an
ABSENT row means enabled, so installing writes nothing and the default is on.

**Phase 2b deleted the enable concept, and this is not that mistake
returning.** `AGENTS.md` still says "no enable flag on either side", and that
decision was about two places disagreeing over what "this host offers X" meant:
a node's installed set crossed with a control-plane table. With one plugin
store, an `enabled` flag has exactly one meaning. It does add a second state
beside installed, and the justification is that "stop offering this, keep the
bytes and keep the profiles" is a real operation uninstall cannot express.
`AGENTS.md` must be corrected rather than left contradicting the code.

**Uninstalling asks, because it can destroy other people's work.** Profiles are
per-user, and an instance-wide uninstall reaches all of them. The prompt states
the blast radius before it is confirmed:

```
Uninstall Acme Thing?

  This removes the plugin from this instance.
  4 profiles use it, across 3 users:
     2 of them are Defaults
     1 has a running subshell

  ( ) Keep the profiles, unavailable until reinstalled
  ( ) Delete the 4 profiles permanently

  Running subshells are unaffected. A restart of one
  whose profile was deleted will fail.
```

- **Keep** is today's behavior and stays the default: the rows survive and the
  computed filter hides them.
- **Delete** removes every matching profile across every user, INCLUDING
  auto-seeded Defaults, which `DELETE /api/profiles/:id` normally refuses. A
  Default for a harness that no longer exists is meaningless, so the guard is
  bypassed deliberately here and nowhere else.
- **Running subshells are untouched** either way. They are already spawned, and
  uninstalling has never stopped one. A restart of a subshell whose profile was
  deleted fails, which is the honest outcome and needs a message that says so.

Leaving another user's profiles behind as permanently unusable orphans was the
alternative, and it is worse: nobody but that user could ever clear them.

## 7. Protocol

The shipped version is 2. Phases 4 and 5 would have taken it to 3 and 4 and
were never built, so this takes it to **3**.

Removed: `plugin_install`, `plugin_uninstall`.
Renamed: `probe_resume` becomes `path_exists`, taking a computed path (§5).
Added: `detect` (§4).
Changed: a node reports the manifest-declared environment values of §5.
Changed: `launch` gains `argv`, `resolve`, and `mcp.args` / `mcp.env`.
Changed: the inventory a node reports no longer carries a plugin set, because
the node has none. What it reports is the detection results of §4.

The exact-match gate makes this a pair release, which is the same property
every previous bump relied on.

## 8. Security, accounted honestly

**What gets worse.** Third-party plugin code runs in the control-plane process,
which holds the node signing keypair, so a malicious plugin reaches every node
rather than one. Two things bound this: it is already true whenever a plugin is
installed on `local` today, since the server loads those in-process; and
installing becomes an admin act, which is the right gate for an instance-wide
capability. It should be stated in `docs/security.md` in exactly those terms,
because it is the single largest change in this document.

**What gets better.** A node no longer executes third-party code at all. Today
every node with a plugin runs that plugin's code as its OS user; after this,
nodes run agent CLIs and nothing else. For a fleet, the number of machines
running third-party plugin code drops from all of them to one.

**Unchanged:** signing still proves who sent a command and never whether the
target supports it; a compromised control plane is still all nodes, as
`docs/security.md` already says; `profile.flags` still reaches argv and is
still the thing to validate if that ever matters.

## 9. Consequences for phases 4 and 5

Both specs are superseded in full. Their decisions do not all die with them.

**Phase 4** (UX) survives in intent: a setup step that asks where subshells run,
and a page for managing plugins. The page becomes an INSTANCE-level surface
rather than a per-node card, since plugins are no longer per node, and it lives
at **`/settings/plugins`**. Settings already nests (`settings_.status.tsx`
renders `/settings/status`, linked from the Settings page), so this is the
existing pattern rather than new navigation, and it puts an admin-only
capability where the other admin-only surfaces already are. The node page
keeps a read-only list of which harnesses this machine can actually run, which
is detection output, not a plugin set. The install-by-name field and its
non-catalog confirmation carry over unchanged, moved to the instance page.
Deleting the anonymous first-run write window (§2.1 there) is still right and
still wanted.

**Phase 5** (settings) collapses substantially:

- Profile settings are unaffected and get simpler: the schema comes from a
  plugin the server holds, so §2.6's ladder and the whole judge-versus-launcher
  problem are deleted rather than solved.
- **Per-node plugin settings are not built** (decided 2026-09-10, §9.1). Plugin
  settings are instance-level, which is what one plugin copy implies.
- **Templates lose their reason to exist** and should not be built.
- The schema language (sections, groups, declarative conditions, `required`) is
  unaffected and carries forward as designed.
- **The secret story changes and gets worse, which must not be glossed.** Phase
  5's write-only secret kept credentials off the control plane entirely. Once
  the plugin runs on the control plane, a secret it needs at argv-building time
  must be readable there. A secret needed only INSIDE the pane can still be
  delivered to the node at launch and never stored centrally. That distinction
  is now load-bearing and needs deciding when settings are specced again.

### 9.1 Per-node plugin settings, and why there are none

Decided by working through the cases rather than by preference. Three
mechanisms already carry per-machine variation, and between them they cover
every case anyone could construct:

- **The node's own OS environment**, inherited by the agent and by every pane it
  spawns. Detection's `envOverride` is exactly this: a plugin names an env var
  and the machine answers.
- **A profile's `env` plus its `nodeId` pin**, for a value that belongs to one
  way of working on one machine.
- **`allowed-dirs`**, for per-node policy, which the control plane owns.

| the case | what already answers it |
|---|---|
| the binary lives somewhere unusual here | `envOverride`, with `override-invalid` already reported when it is wrong |
| this machine has its own credential | the agent's OS environment |
| this machine talks to a different endpoint | node environment, or a pinned profile's `env` |
| cache or config directory differs here | the same |
| "no bypassPermissions on the production box" | node POLICY, which belongs beside `allowed-dirs`: different owner, different lifecycle |
| hardware facts | detection, not configuration |

The credential row is the one worth pausing on, because the existing answer is
better than a settings store rather than merely equivalent: a value in the
node's environment never reaches the control plane, which is precisely the
property this whole document otherwise costs us (§8).

**The one shape genuinely uncovered** is a value that shapes ARGV rather than
env, varies per node, and should apply to every profile on that machine. Five
profiles across four nodes would mean twenty pinned edits. It only bites when
the CLI offers no env equivalent for that flag, and none of the five built-ins
has such a setting.

Deferring is safe here in a way it would not have been a week ago, and that is
the actual argument. Under per-node plugins, "add it later" meant a distributed
store, a protocol command and a page. With one plugin copy it is a table keyed
by node and plugin that the server reads while building argv. **Reopen this the
first time a real plugin needs an argv-shaping value that varies per machine**,
and not before.

A consequence worth naming: this shrinks the secret question. Plugin settings
being instance-level means one store and one policy, and anything a pane needs
privately can stay in the node's environment, where it lives today and where
the control plane never sees it.

### 9.2 Instance-level secrets, encrypted at rest

A credential a PLUGIN needs while building argv has to be readable on the
control plane, which is the one thing moving plugins here genuinely costs
(§8). It is stored encrypted, with the key held outside the database.

- **AES-256-GCM via `node:crypto`**, so this adds no dependency. The key comes
  from the environment (`SUBSHELL_SECRETS_KEY`), never from a settings row and
  never from the database, which is the whole point: a stolen database file is
  not a stolen credential.
- **Write-only over the API**, keeping phase 5 §2.3's shape: a write accepts a
  value, a read reports only that one is set, and no response body, log line or
  audit entry ever carries it. Encryption and non-disclosure are separate
  controls and this has both.
- **No key means no secrets, and it fails closed.** With `SUBSHELL_SECRETS_KEY`
  unset, writing a secret is refused rather than stored in the clear, and
  reading an existing one is an error that names the missing variable. Storing
  plaintext because a variable was forgotten is the failure this design exists
  to prevent.
- **A lost key is unrecoverable, by construction.** Rotating it re-encrypts
  every stored secret and losing it means every operator re-enters theirs.
  `docs/security.md` must say so plainly beside the `BETTER_AUTH_SECRET`
  guidance, because an operator who learns this during a restore has learned it
  too late.

What this is NOT for: a credential the agent CLI needs inside its pane. That
stays in the node's own environment, where it lives today and where the control
plane never sees it (§9.1). The distinction is the whole reason this store can
be small.

## 10. Testing

- **Spike replication as a test:** for each built-in, the argv built on the
  control plane equals the argv that plugin builds today given the same inputs.
  This is the whole correctness claim of the inversion, and it is cheap because
  `buildCommand` is pure.
- **Late binding:** a launch whose inventory path is stale still spawns, because
  the node resolved the binary itself; and a launch for an absent binary fails
  with the existing `harness binary missing:` prefix, which the backend maps to
  an inventory refresh.
- **MCP parity:** the content, args and env computed on the control plane match
  what the node used to recompute, for each of the three plugins with
  `mcpRegistration`. This is the drift rule's replacement, so it must be pinned
  before that rule is deleted.
- **The node holds nothing:** after an upgrade, a launch succeeds on a node with
  no `<dataDir>/plugins/` directory at all.
- **Detection:** results cache with `checkedAt`, render as last-known, and no
  traffic occurs without a request.

## 11. Landmines carried into the plan

- **`parseVersion` moves hosts.** Only hermes implements it, and the version
  string is rendered in the UI, so a mistake here shows up as a cosmetic bug
  rather than a failure. Pin it with a test using hermes's real banner output.
- **`claudeConfigDir()` reads a node's env var**, and §5 now settles how: the
  node reports manifest-declared environment values. What remains a landmine is
  the declaration itself, since a manifest naming the wrong variable fails
  silently, as a resume that never offers itself.
- **`local` is not special any more, in the other direction.** It is now the
  only node whose plugin directory matters, because it IS the control plane.
  Watch for code that treats `local` as "a node like any other" and now needs
  the opposite.
- **The launch frame grows.** `argv` is attacker-relevant if a control plane is
  compromised, which it already was via `profile.flags`. Do not add validation
  theatre on the node; if argv validation is wanted, it belongs where profiles
  are saved.
- **Nothing here changes the npm publishing pipeline** or the six published
  packages. Leave them alone.

## 12. What this does not decide

Everything this document opened has since been closed: secrets in §9.2, the
plugins page and the resume-path probe in §9 and §5. What is left is genuinely
downstream of building it.

- The shape of the `detect` result beyond `{ id, found, path, rawVersion,
  reason }`, which the plan should settle against the existing
  `EffectiveHarnessState` rather than inventing a parallel type.
- Whether `SUBSHELL_SECRETS_KEY` rotation is a CLI verb or a documented manual
  re-entry. It only matters once a plugin actually stores a secret (§9.2).
