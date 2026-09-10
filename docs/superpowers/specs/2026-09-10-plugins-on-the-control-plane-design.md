# Design: Plugins Move to the Control Plane

Date: 2026-09-10
Status: approved design (brainstorm + spike 2026-09-10), pending implementation plan
Supersedes: `2026-09-09-plugin-architecture-design.md` §6, §8.1 to §8.2, §10, §11; and in full
`2026-09-10-plugins-phase4-ux-design.md`, `2026-09-10-plugins-phase5-settings-design.md`

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
server -> node   detect { specs: [{ id, binaryName, envOverride?, knownPaths?, versionArgs }] }
node   -> server [{ id, found, path?, rawVersion?, reason? }]
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

`canResume` follows the same shape: the control plane computes the candidate
path with plugin code and asks the node whether it exists, which is what
`probe_resume` already does one layer up.

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

## 7. Protocol

The shipped version is 2. Phases 4 and 5 would have taken it to 3 and 4 and
were never built, so this takes it to **3**.

Removed: `plugin_install`, `plugin_uninstall`.
Added: `detect` (§4).
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
rather than a per-node card, since plugins are no longer per node. The node page
keeps a read-only list of which harnesses this machine can actually run, which
is detection output, not a plugin set. The install-by-name field and its
non-catalog confirmation carry over unchanged, moved to the instance page.
Deleting the anonymous first-run write window (§2.1 there) is still right and
still wanted.

**Phase 5** (settings) collapses substantially:

- Profile settings are unaffected and get simpler: the schema comes from a
  plugin the server holds, so §2.6's ladder and the whole judge-versus-launcher
  problem are deleted rather than solved.
- Per-node plugin settings, if still wanted, become a server-side record keyed
  by node and plugin. No node-side store, no `plugin_set_settings`, no
  round-trip.
- **Templates lose their reason to exist** and should not be built.
- The schema language (sections, groups, declarative conditions, `required`) is
  unaffected and carries forward as designed.
- **The secret story changes and gets worse, which must not be glossed.** Phase
  5's write-only secret kept credentials off the control plane entirely. Once
  the plugin runs on the control plane, a secret it needs at argv-building time
  must be readable there. A secret needed only INSIDE the pane can still be
  delivered to the node at launch and never stored centrally. That distinction
  is now load-bearing and needs deciding when settings are specced again.

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
- **`claudeConfigDir()` reads a node's env var.** The control plane cannot read
  `CLAUDE_CONFIG_DIR` on a remote machine, so the resume-path probe must either
  send a path template the node expands or have the node report that variable.
  Decide it in the plan; do not let it become an assumption.
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

- Whether per-node plugin settings are wanted at all, now that the reason for
  their store is gone (§9).
- The secret split between "needed to build argv" and "needed inside the pane"
  (§9).
- Whether the instance plugins page lives under Settings or gets its own route.
- Whether `probe_resume` keeps its name once it carries a computed path rather
  than a plugin id.
