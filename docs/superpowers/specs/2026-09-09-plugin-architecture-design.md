# Plugin Architecture Design

**Date:** 2026-09-09
**Status:** approved, phased (see §15)

Replaces the five hard-coded harness plugins in `packages/harnesses` with an
installable plugin system owned by the node. The control plane stops importing
harness code for machines it does not run on, and starts learning what a node
can do from what that node reports.

---

## 1. The problem

Four complaints, one root cause.

1. **First-run setup is not intuitive.** Step 2 of the wizard is a list of five
   harnesses with enable switches. It presents a chore, not a decision.
2. **Detection lies.** "Claude Code is not installed" while it is. The immediate
   cause was fixed on 2026-09-09 (`b134e35`: a service's baked PATH cannot see a
   harness installed through a node version manager), but nothing on screen says
   when detection last ran, or why a binary was not found.
3. **The list is overwhelming.** Every surface renders every registered plugin
   times every node. On a machine with one harness installed, the wizard is 80%
   "not installed" plus install help.
4. **Nodes have no say.** A node reports an inventory of what is installed; the
   control plane alone decides what may run there.

The root cause is that harnesses are compiled into the control plane. Adding one
is a server release; a node cannot offer anything the server was not built with;
and a machine's own capabilities are described by a table on another machine.

## 2. Decisions

| # | Decision | Section |
|---|---|---|
| D1 | The node is authoritative for the set of plugins it offers; the server mirrors what the node reports | §6 |
| D2 | A node's list leads with what is detected; the catalog is behind a disclosure | §10 |
| D3 | Setup step 2 asks "where will subshells run?", not "which harnesses do you want?" | §10 |
| D4 | A server-side edit is a signed command to a live node. Offline means refused, not queued | §6 |
| D5 | A plugin is a loadable JS/TS module, self-contained, receiving a host object | §4 |
| D6 | Plugins are distributed as npm packages under `@subshell-ai/` | §8 |
| D7 | A plugin's settings UI is a schema we render, validated by the plugin on the node | §9 |

D5 was chosen with its cost stated: it needs a runtime `import()` of a path
outside the compiled binary, which `.claude/rules/code-style.md` bans, and it
runs third-party code inside the agent process. §4 and §13 carry the
consequences.

### 2.1 What was measured, not assumed

Every claim below was verified against bun 1.4.2 with a `bun build --compile`
binary loading a module from disk. The findings are what makes D5 workable and
what constrains it.

| Question | Answer |
|---|---|
| Can a compiled binary `import()` an absolute path at runtime? | **Yes.** The loaded module called back into a host object passed as an argument. |
| Can the loaded module `import` a bare specifier such as `@internal/harnesses`? | **No.** `Cannot find module`. There is no `node_modules` beside it. |
| Can it import `node:fs` and friends? | **Yes.** A plugin has full filesystem, network and process access. |
| Does a `.ts` plugin load? | **Yes.** Bun transpiles on the fly. |
| Is a top-level `throw` contained by `try/catch` around `import()`? | **Yes**, fully. |
| Does a stray async throw after load kill the host? | **No**, in the case measured. It logged and the process continued. |

The second row is the load-bearing one: it is why a plugin cannot import
anything of ours and why the host object in §4 exists.

## 3. Vocabulary

The root `AGENTS.md` rule holds: no word may name two things.

- **plugin** is the unit of installation. It has a **type**.
- **type** is for humans. Today `agent-harness` and `terminal`. It groups and
  labels in the UI and filters the catalog.
- **capability** is for code. `mcp`, `resume`, `attention`, `settings`. The
  launch pipeline branches on capabilities and never on type.

Keeping those apart is what stops `type` becoming the overloaded word the rule
forbids: adding a type touches labels, adding a capability touches the pipeline.

**"harness" becomes a plugin type and stops being a package.** See §14 for the
open decision about `packages/harnesses`.

## 4. The plugin contract

### 4.1 Packages

| path | npm name | published | holds |
|---|---|---|---|
| `packages/plugin-api/` | `@subshell-ai/plugin-api` | yes | types plus small pure helpers a plugin author bundles in at build time |
| `packages/plugin-host/` | none (`@internal/plugin-host`) | no | the loader, the host object, the registry, detection. Used by the agent and by the server |
| `packages/plugins/<id>/` | `@subshell-ai/plugin-<id>` | yes | the five built-ins, one package each |

All three are Apache-2.0, outside `apps/server/**`. This is the "third parties
can write harness plugins" rationale in the root `AGENTS.md` finally delivered.

### 4.2 Identity lives in `package.json`

```json
{
  "name": "@subshell-ai/plugin-claude-code",
  "version": "1.0.0",
  "subshell": {
    "apiVersion": 1,
    "id": "claude-code",
    "type": "agent-harness",
    "name": "Claude Code",
    "description": "Anthropic's agentic coding assistant (interactive CLI)",
    "icon": "🤖",
    "entry": "dist/index.js",
    "detect": {
      "binaryName": "claude",
      "envOverride": "CLAUDE_PATH",
      "knownPaths": [".local/bin/claude", ".claude/local/claude"]
    },
    "install": { "command": "npm i -g @anthropic-ai/claude-code", "docsUrl": "https://..." }
  }
}
```

Two properties follow, and both are deliberate:

- **Listing, displaying and gating an installed plugin reads JSON only.** No
  plugin code executes until a plugin is actually used to launch something.
- **Detection needs no plugin at all** (§7). The node can scan for `claude`
  before the Claude Code plugin is installed, which is what lets setup say "we
  found Claude Code on this machine, install its plugin?".

### 4.3 The module exports a factory

Because a plugin cannot import anything of ours (§2.1), everything it needs is
handed to it:

```ts
import type { PluginHost, SubshellPlugin } from "@subshell-ai/plugin-api";

export default function createPlugin(host: PluginHost): SubshellPlugin { ... }
```

`PluginHost` carries `findBinary`, the login-PATH probe, a bounded `spawn`,
`shellQuote`, a logger, and `apiVersion`. It is also the version boundary: a
host at a higher `apiVersion` keeps older plugins working by keeping the fields
they were compiled against.

`@subshell-ai/plugin-api` must therefore be types plus *pure* helpers only.
Anything with runtime behaviour that a plugin bundles in becomes frozen at the
version the plugin was built with, which is correct for a formatter and wrong
for a filesystem probe. Filesystem probes belong on `host`.

### 4.4 Capabilities

The base contract is identity, `buildCommand`, and `validateProfile`. Everything
else is a capability the plugin opts into:

| capability | methods | who has it today |
|---|---|---|
| `mcp` | `mcpRegistration?`, `mcpSetup` | all five |
| `resume` | `allocateHarnessSessionId`, `canResume` | claude-code only |
| `attention` | wires native attention reporting in `buildCommand` | claude-code only |
| `settings` | `profileSettings()`, `pluginSettings()`, `validateSettings()` | all five |

A `terminal` plugin declares a binary and an argv and none of the rest, rather
than implementing eight stubs. The node reports each plugin's capability set;
the server's UI and launch pipeline read it.

### 4.5 How declarative the built-ins turn out to be

Recorded because it sizes the migration in phase 1. Read against the five
existing plugin bodies:

| piece | reality |
|---|---|
| `buildCommand` | The same template five times: binary, MCP args, settings-to-flag mappings, name flag, profile flags, extra flags. Only Claude's differs, with a settings-JSON merge and a `--session-id`/`--resume` branch. |
| `mcpRegistration` | A file template (JSON or TOML) plus argv and env. Pure interpolation of `command`, `args`, `configPath`. |
| `mcpSetup`, `settingsFields`, `suggestedEnv`, `suggestedFlags`, `exitStatus` | Static data in all five. |
| `validateProfile` | All five call `validateGenericProfile`. |
| detection | Data. The algorithm is shared. |
| `resume` | Real code, claude-code only. |

So phase 1 is mostly a move, not a rewrite. The contract stays code-shaped
because D5 chose that, and because the residue that is genuinely code (Claude's
resume probe and hooks merge) is exactly what a manifest could not express.

## 5. Loading and the fault model

- Plugins load **lazily, never during daemon startup**, behind a
  `PluginRuntime` interface. Its only implementation today is in-process.
- Every entry point is wrapped and deadline-bounded.
- A plugin that fails to load is marked **broken**, its error is reported up and
  rendered on the node's page, and it is not called again in that process. One
  broken plugin never affects another, which is the containment `scanOne`
  already gives detection.
- The `PluginRuntime` seam exists so that moving to a Worker per plugin later is
  one class rather than a rewrite. Workers are **not** proposed now: every
  plugin method is fast and close to pure (build an argv, render a config file),
  and the two that touch the filesystem are already bounded.

`.claude/rules/code-style.md` gains a narrow, named exception: `await import()`
is permitted in `plugin-host`'s loader and nowhere else. The rule's reasoning is
inverted in place rather than deleted, because there the bundler's blindness is
the mechanism and not the bug.

## 6. Declaration: the node owns its plugin set

**The installed plugin set is the declared set.** `<dataDir>/plugins/` is the
declaration, uninstall is the removal, and no separate enable table or exclusion
file exists on either side.

| node kind | where plugins live |
|---|---|
| agent | `<dataDir>/plugins/<id>/` |
| `local` | `<SUBSHELL_SERVER_DATA_DIR>/plugins/<id>/` |

The control-plane host is a node like any other and loads plugins through the
same `@internal/plugin-host`.

**The node reports, the server mirrors.** The existing `inventory` event grows
to carry, per plugin: id, type, name, version, capabilities, the settings
schemas, install state of the underlying binary, `checkedAt`, and `broken` with
its error. `nodes.inventory_json` becomes the single mirror, with one parser
shared by the view and the launch gate.

**A server-side change is a signed command to a live node** (D4). New protocol
commands, bumping `NODE_PROTOCOL_VERSION` to 6:

- `plugin_install { spec: string }`
- `plugin_uninstall { id: string }`
- `plugin_update { id?: string }`
- `plugin_set_settings { id: string, settings: JsonValue }`

Each is answered with a fresh plugin report the server persists, so the UI only
ever shows what the node confirmed. An offline node, or one below protocol 6,
renders read-only with the reason.

**There is deliberately no reconcile-on-`ready`, and that differs from
`allowed-dirs` on purpose.** There the control plane owns a security control, so
a node running stale rules must be corrected. Here the node owns the setting, so
there is nothing to correct. Writing this down because the two look alike and
the difference is the whole point of D1.

**The node enforces.** A `launch` naming a plugin the node does not have
installed is refused node-side, not merely filtered by the server. Signing
proves who sent a launch, never whether the target supports it.

## 7. Detection

Detection metadata is manifest data (§4.2), so a scan loads no plugin code and
can find a binary whose plugin is not installed yet. A plugin may override
detection with code; none of the five needs to.

Four fixes for "it says not installed when it is":

- **Say why.** A not-found result carries a reason: `not-on-path`, or
  `override-invalid` when the env override is set but missing or not executable.
  That case currently renders an install command that cannot help.
- **Show when.** Every scan carries `checkedAt`, and every surface renders
  "checked N ago" beside a Re-check that genuinely rescans. Today the local list
  re-probes per request while an agent list may be ten minutes stale, and
  nothing on screen distinguishes the two.
- **One code path.** The server's `harnessInfo` stops hand-probing and goes
  through the same `scanOne` plus 10-second memo the agent already uses.
- **Bound the version probe.** `getVersion` spawns `<binary> --version` with no
  deadline today, so one wedged binary hangs a request.

The informational view and the strict launch gate keep their two strictnesses,
but they now read the same snapshot shape.

## 8. Distribution

### 8.1 Installing on a node

New CLI verbs on the agent, which are also what both GUIs drive:

```
subshell plugin list [--json]
subshell plugin install <name|@scope/pkg[@version]>
subshell plugin uninstall <id>
subshell plugin update [<id>]
```

Install resolves the packument from the registry, **verifies the tarball against
the registry's own `integrity` hash**, extracts to `<dataDir>/plugins/<id>/`,
validates the `subshell` manifest and its `apiVersion`, then loads the module
once to confirm it is real. Failure at any step leaves nothing behind.

Extraction uses a small vendored tar reader rather than shelling out to
`tar(1)`, so a minimal container is not a failure mode. The agent is a compiled
binary with no package manager; nothing here assumes one.

### 8.2 The built-ins ship embedded

The five built-in plugins are embedded in the agent and server binaries.
`plugin install claude-code` uses the embedded copy when the registry is
unreachable or when the requested version is the embedded one.

This is what keeps first-run setup working with no network, and what stops an
upgrade breaking every existing instance: on first boot after upgrade, a node
with no plugins directory seeds the built-ins that the retired tables said it
had enabled (§12).

### 8.3 Publishing to npm

Modelled on `~/projects/loglayer`, which publishes a changesets monorepo to npm
with **OIDC trusted publishing** and no npm token in the repo at all.

What we adopt:

- `changesets/action` gains a **publish script** running `changeset publish`.
- The job declares `id-token: write` and removes `~/.npmrc` before publishing,
  so npm uses OIDC rather than a token. `NPM_TOKEN` stays empty.
- Each published package carries `"publishConfig": { "access": "public" }`.
  The repo-wide changeset `access` stays `restricted`, because every other
  workspace is private and must remain unpublishable by accident.
- Build, `lint:packages`, `verify-types` and `lint` all run before publish.

What we change from loglayer, because this repo is different:

- **Self-hosted runners, not `ubuntu-latest`.** The job runs on
  `[self-hosted, Linux, X64]` with a `timeout-minutes`, per the fleet rules in
  the root `AGENTS.md`. Bun is the package manager, not pnpm.
- **The existing four app pipelines are untouched.** They tag `<app>-vX.Y.Z` and
  publish GitHub Releases; npm tags live in a different namespace
  (`@subshell-ai/plugin-x@1.0.0`) and cannot collide. The plan job's
  "no component id is a prefix of another" guard is about ids and is unaffected.
- `push-git-tags` becomes true for the npm packages only, since a published
  version with no tag is unreviewable. `create-github-releases` stays false:
  release notes for the apps are still sliced from `apps/<dir>/CHANGELOG.md` by
  the publish job.
- The plugin packages come out of the changeset `ignore` list. Every
  `@internal/*` workspace stays in it.

**Operational note:** trusted publishing is configured per package on npmjs.com,
once, by a human, before the first publish of that package. A new plugin package
cannot publish until that is done, and the failure is a 403 at publish time.

## 9. Settings

A plugin declares two schemas, both rendered by one renderer of ours:

| schema | rendered in | stored on |
|---|---|---|
| `profileSettings()` | the profile editor | the profile (today's `settingsFields`, grown up) |
| `pluginSettings()` | the plugin's own page on a node | the node, beside the plugin |

The schema is richer than today's flat `SettingsField[]`: sections, groups,
conditional visibility, per-field help. On save the value round-trips to the
node (`plugin_set_settings`, or a direct call for `local`) so the plugin's own
`validateSettings` runs where the plugin lives. Arbitrary logic stays with the
plugin; no third-party code reaches the browser or the control plane.

## 10. UI surfaces

### 10.1 Setup step 2: "Where will subshells run?"

Two choices, because that is the decision a new user actually has.

- **This machine** runs a scan and leads with what it found ("Found Claude Code
  2.1.266") and one button that installs its plugin from the embedded copy, with
  no network. Everything else collapses into one "Add another" row. If nothing
  was found, the catalog appears with install commands, and the node path beside
  it.
- **Another machine** goes straight into node enrollment.

The wizard no longer writes harness state, which removes `PATCH
/api/setup/harnesses/:id` and with it the public-write-during-first-run gate.

### 10.2 `/nodes/:id`: the Plugins card

Replaces the harness matrix. Installed plugins with a type badge, version,
binary status (`found at /home/theo/.nvm/.../claude, 2.1.266`), a Settings link
where the plugin declares one, and Uninstall. Broken plugins get a distinct row
carrying the load error. "Add a plugin" holds the catalog plus a field to
install any package by name. An offline node renders read-only and says why.
`checked N ago` plus Re-check sits on the card.

### 10.3 Subshell Client: the node window

A Plugins card on the existing node page, driven by new `node_plugin_*` Tauri
commands over the CLI verbs of §8.1. `ui/src/__tests__/ipc-acl.test.ts` pins the
three-way agreement automatically.

Deliberately **install, uninstall and detect only**; settings pages stay on the
server UI. Duplicating a whole schema renderer across two apps is a different
thing from the copied `components/ui/` primitives, and the honest division is
that the node window exists to get the machine working while the server is where
configuration lives.

## 11. What the server still needs

Less than expected, because two things were already node-side before this
design:

- `canResume` is already delegated over the `probe_resume` command
  (`remote-launcher.ts`).
- Remote launches already render their own MCP file on the node
  (`apps/node/agent/src/commands/launch.ts`).

So after this change the server needs plugin *code* for exactly one thing: its
own `local` node's launches, which it does by loading plugins the same way any
node does. Everything else it needs about a remote node's plugins is *data* the
node reported: names, types, capabilities, settings schemas, suggested env and
flags, exit-code labels, MCP setup steps.

`GET /api/profiles/:id`'s `settingsFields` is served from that reported data
rather than from a compiled-in registry.

## 12. Migration and deletions

Dropped:

- the `node_harnesses` table and its repository;
- `PATCH /api/setup/harnesses/:id` and the public-write branch of its gate;
- `use-harness-toggles.ts` and the toggle half of `harness-row.tsx`;
- the `harness_plugins` table, after it is read once (below).

**The one-way seeding step.** On first boot after upgrade, for each node with no
plugins directory: read the retired tables, and install the embedded built-in
for every harness that was enabled and installed there. An agent does this for
itself on first start of the new binary; the server does it for `local`. After
that the tables are never read again, and a later migration drops them.

This must be idempotent and must never run against a populated plugins
directory, or an uninstall would be undone by the next restart.

## 13. Security

New paragraphs for `docs/security.md`:

- **Installing a plugin is installing code that runs as the node's OS user,
  inside the agent process.** No sandbox is claimed. This is the same trust
  level as installing the harness CLI the plugin drives, and the same trust
  level as the node's own binary, but it is a new way to reach it: previously
  only a release could add executable behaviour to a node.
- **Install is an explicit act with a named source.** The catalog never installs
  on its own. The tarball is verified against the registry's `integrity` hash
  before anything is written or loaded.
- **Any node share, even `view`, already lets a grantee launch subshells there.**
  Plugin management is stricter: it is **owner-only** (`canManage`), matching the
  directory allowlist and for the same reason. An `edit` grantee who could
  install a plugin could install one that ignores the allowlist.
- **A plugin sees pane content and the subshell's bearer token**, because it
  builds the launch command. That is the existing exposure of §"Nodes" restated
  for a new actor.

## 14. Open decisions

**`packages/harnesses` names two things.** Once `agent-harness` is a plugin
type, a package holding `TmuxRunner`, `launch.ts` and `binary-lookup` cannot
also be called "harnesses" without breaking the vocabulary rule. Proposal:

- host services (`binary-lookup`, `login-path`, `inventory`) move into
  `plugin-host`;
- pane machinery (`TmuxRunner`, `launch`, `curatedEnv`) becomes
  `packages/pane-runtime`;
- `packages/harnesses` ceases to exist.

It is a large mechanical diff for a naming fix, so it is called out rather than
folded silently into phase 1. The phases below assume it happens in phase 1,
where the files are being moved anyway.

## 15. Phases

| phase | what | user-visible |
|---|---|---|
| 0 | detection reasons, timestamps, one code path, bounded version probe | fixes the reported bug |
| 1 | plugin contract, host, loader; the five built-ins move to `packages/plugins/*`; agent and server load through the host; the §14 rename | nothing |
| 2 | node owns the declared set: plugins directory, reporting, protocol v6, `node_harnesses` dropped | the node page reflects the node |
| 3 | npm install/uninstall/update, embedded built-ins, CLI verbs, the publishing pipeline | plugins become installable |
| 4 | setup step 2, node Plugins card, node window card | the new UX |
| 5 | settings schemas and plugin settings pages | per-plugin configuration |

Phase 0 stands alone and is shippable on its own. Phase 1 is the riskiest and is
invisible, which is the right shape for it.

## 16. Testing

Per phase, and in addition to the repo-wide `verify-types` / `lint:check` /
`test`:

- **0**: detection reasons for each not-found cause; `checkedAt` present;
  version probe times out rather than hanging; server and agent produce the same
  entry shape.
- **1**: each built-in behaves identically before and after the move (the
  existing plugin tests move with them); a plugin that throws on import is
  reported broken and does not affect its neighbours; a plugin cannot import a
  bare specifier (pinned as a test, since it is a contract not an accident);
  `PluginRuntime` deadlines fire.
- **2**: protocol v6 validators round-trip; a pre-v6 agent degrades to read-only
  rather than erroring; a launch for an uninstalled plugin is refused node-side;
  `local` and agent paths produce the same report shape.
- **3**: integrity mismatch aborts and leaves nothing behind; the embedded
  fallback is used when the registry is unreachable; uninstall is idempotent;
  the tar reader handles a real npm tarball; the seeding step is idempotent and
  skips a populated directory.
- **4**: wizard step 2 in all three states (found, found nothing, chose another
  machine); Plugins card offline, broken and normal; the node window's IPC ACL
  test covers the new commands.
- **5**: schema renders each field type; a node-side validation rejection
  surfaces on the field; settings survive a round trip.
- **e2e**: the existing nodes spec extends to cover install and uninstall
  against a real agent.
