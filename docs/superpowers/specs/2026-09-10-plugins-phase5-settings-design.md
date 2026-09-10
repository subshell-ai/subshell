# Phase 5 Design: Settings

Date: 2026-09-10
Status: approved design (brainstorm 2026-09-10), pending implementation plan
Parent: `2026-09-09-plugin-architecture-design.md` §9 (Settings), §10.3, §13
Predecessors: `2026-09-09-plugins-phase3-registry-design.md`, `2026-09-10-plugins-phase4-ux-design.md`

The last phase of the plugin revamp. Phases 1 through 4 made a plugin
installable, updatable and visible; none of them let anyone configure one.

This document decides what §9 left as a sketch, and corrects three places where
that sketch does not survive contact with what phases 3 and 4 actually built.

## 1. Scope

In: a richer settings schema (sections, groups, conditional visibility,
per-field help, a write-only `secret` type, `required`); the profile editor
that renders `profileSettings()` and finally writes `profiles.settingsJson`;
per-node `pluginSettings()` with its own store, page and protocol commands;
validation that actually reaches the plugin; reusable per-user settings
templates; protocol 3 -> 4.

Out, each named so nobody drifts into it: templates covering PROFILE settings
(an unpinned profile is already portable, so a template for one would duplicate
what a profile is); sharing templates with other users (§2.7); any settings
surface in the Subshell Client node window (§10.3 is explicit, and phase 4 held
to it); a settings UI for plugin `capabilities`, which are declared by code and
not configuration.

## 2. Decisions

Six from the brainstorm (2026-09-10), plus the interface decisions they force.

### 2.1 Both surfaces, and what each is for

| schema | scope | rendered in | stored on |
|---|---|---|---|
| `profileSettings()` | one profile | the profile editor | `profiles.settingsJson`, the control plane's DB |
| `pluginSettings()` | one machine | the plugin's page on a node | a file on the node (§2.4) |

The distinction is not cosmetic and the two must not be merged. A profile
setting is a knob on the agent for one way of working: a "planning" profile
sets Claude Code's `permissionMode` to `plan` while a "build" profile sets
`acceptEdits`, on the same machine with the same plugin. A plugin setting is
machine-local truth: the endpoint this box reaches, the path a licence sits at.
One is per-intent, the other per-host, and no single store expresses both.

**Profile settings are the smaller build than they look.** The column exists,
`profile.settings` already reaches `buildCommand`, Claude Code already turns it
into `--settings <json>`, and all five built-ins already declare a
`profileSettings()` schema. Nothing renders it, so today the only way to fill
that column is a direct API call. This phase closes a loop that is open at
exactly one point.

**Plugin settings are entirely new**: no declarer, no store, no command, no
page. `pluginSettings?(): SettingsField[]` and `validateSettings?(settings):
SettingsValidationResult` join the plugin contract as optional members behind
the existing `settings` capability.

### 2.2 The schema language

`SettingsField` grows from four types and six properties into a language that
can describe a real settings page:

```ts
export type SettingsFieldType = "string" | "boolean" | "number" | "select" | "secret";

export interface SettingsField {
  /** Key into the settings object */
  key: string;
  /** Property label */
  label: string;
  /** Per-field help, rendered under the control */
  description?: string;
  type: SettingsFieldType;
  /** Choices when type is "select" */
  choices?: string[];
  /** Default when unset. Never allowed on a `secret` (§2.3) */
  default?: string | boolean | number;
  /** Refuse to save when this is empty and the field is visible (§2.5) */
  required?: boolean;
  /** Section heading this field appears under; fields with none come first */
  section?: string;
  /** Sub-heading within a section, for fields that belong together */
  group?: string;
  /** Show this field only when the condition holds (§2.2.1) */
  showIf?: SettingsCondition;
}
```

Sections and groups are LABELS, not a nested tree. The renderer groups by
`section` then `group`, preserving declaration order within each. A flat list
with two labels stays trivially serializable across the wire, survives a plugin
adding a field in the middle, and cannot express a malformed tree, which a
nested structure would have to be validated against.

#### 2.2.1 Conditional visibility is data, never code

```ts
export type SettingsCondition =
  | { key: string; equals: string | number | boolean }
  | { key: string; in: (string | number | boolean)[] }
  | { key: string; truthy: true };
```

**A condition is a value, not a predicate function, and that is a security
boundary rather than a convenience.** §9's rule is that no third-party code
reaches the browser or the control plane. A plugin shipping a JavaScript
predicate to be evaluated in an operator's browser would break that rule
outright, so the condition is a small declarative shape our renderer
interprets.

Three rules make conditional fields behave predictably, and each exists because
its absence is a bug someone would hit:

- **A hidden field is not validated.** `required` on a hidden field is
  satisfied, or a plugin could make a page impossible to save by requiring
  something it also hides.
- **A hidden field's stored value is preserved, not cleared.** Toggling a mode
  off and back on must not silently erase what was configured under it.
- **A condition naming an unknown key is FALSE**, so the field hides. A schema
  that lost a key in an update degrades to a hidden field rather than to a
  crash or a field that ignores its own condition.

Conditions do not nest and there is no AND/OR. A field needing two conditions
is a signal the schema wants a section, and that limit can be lifted later
without moving anything built here.

### 2.3 Secrets are write-only

`type: "secret"` marks a value the browser may SET and may never READ.

- The node stores it with every other setting in a 0600 file (§2.4).
- Reads never return it. The wire carries `{ set: true }` or `{ set: false }`
  for that key, so the form renders "set" with a Replace action instead of a
  populated input.
- `default` is refused on a secret field at load time, because a default
  credential is either useless or a shipped credential.
- A secret is never captured into a template (§2.7), which follows from the
  read rule rather than being a second rule.
- The plugin reads the real value locally when it builds a launch. The value
  never enters the control plane's database, its backups, or a screenshot of a
  settings page.

Storing it in plaintext on the node is deliberate and consistent: the repo
already refuses to encrypt pane logs on the grounds that the key would sit on
the same host under the same OS user that can already read the file, so
permissions are the real control. `docs/security.md` says exactly this about
pane logs and will say it about settings.

### 2.4 Where node settings live, and a correction

**`<dataDir>/plugin-settings/<pluginId>.json`, 0600, in a 0700 directory.**
NOT inside `<dataDir>/plugins/<pluginId>/`.

§9 says "stored on the node, beside the plugin", and that has to mean a sibling
path. Phase 3's installer stages a new directory and renames it over the old
one, so a file an operator wrote inside the plugin directory is destroyed by
the next install or update. `install.json` survives only because the installer
rewrites it into the staged files every time. Operator-owned configuration
cannot depend on that.

Consequences of the sibling location, all wanted: settings survive an update, a
downgrade and a reinstall; uninstalling a plugin does NOT delete its settings,
so removing and reinstalling keeps a machine's configuration; and a stale
settings file for a plugin nobody has installed is inert, reported by nothing,
and costs bytes.

### 2.5 Validation, and the method that never had a caller

**`validateProfile` is required by the plugin contract, implemented by every
plugin, adapted, load-checked, and called by nothing.** No route, no launcher,
nothing in the repo consults its result. This phase gives it a caller.

Validation happens in three places, each doing what only it can:

1. **Schema validation, on the control plane, always.** Types, `choices`,
   `required` on visible fields, unknown keys, and the §2.2.1 rules. The
   control plane holds the reported schema and needs no plugin code to apply
   it.
2. **The plugin, on save, over a round-trip.** The value goes to a node running
   that plugin and the plugin's own `validateProfile` (or `validateSettings`)
   runs where the plugin lives. Arbitrary logic stays with the plugin.
3. **The plugin, at launch.** `validateProfile` runs on the node immediately
   before `buildCommand`, which is where a bad profile must not proceed anyway,
   and closes the gap that a profile saved against one plugin version can be
   launched against another.

**An offline node refuses the save.** This is the same rule as installing a
plugin, for the same reason: the node owns the answer, and a queue would let
the UI show a configuration nothing has accepted. The cost is real and accepted
out loud: a user cannot fix a typo in their own profile while the relevant
machine is switched off.

### 2.6 Which node judges an unpinned profile

A profile does not have to name a node. `nodeId: null` means "any
launch-eligible node", and the auto-seeded Default profiles are created that
way, so unpinned is the common case rather than an edge one.

Resolution order when saving profile settings:

1. Pinned profile: its own node. Offline is a refusal.
2. Unpinned: `local`, when `local` has that plugin installed. It runs in this
   process, so it is always reachable and costs no round-trip.
3. Unpinned: the first online node that has that plugin installed.
4. None: refuse with a message naming the plugin, not the node, because there
   is no node to name: "No node running Claude Code is online, so these
   settings cannot be checked. Start one and try again."

**The wrinkle, stated rather than hidden:** two nodes can run different
versions of the same plugin, so the judge is not always the machine that
eventually launches the profile. Layer 3 of §2.5 is what makes that survivable,
and it is the reason launch-time validation is in this design rather than being
left as a nicety.

### 2.7 Templates

A **settings template** is a named, reusable set of plugin-settings values a
user applies to any node they can configure.

```
settings_templates: id, userId, name, pluginId, valuesJson, createdAt, updatedAt
```

- **Per-user and private.** It mirrors profiles, so no new ownership or sharing
  concept enters the product. Two admins tending one fleet each keep their own,
  which is duplication between people rather than between machines, and that is
  the smaller problem.
- **Plugin settings only.** A template for profile settings would duplicate
  what an unpinned profile already is.
- **Never carries a secret**, because a secret cannot be read back (§2.3).
  Applying a template leaves each node's credential to be set on that node.
- **Fit is measured, not declared.** On apply, the template's values are
  validated against the TARGET node's current schema, per field: a key the
  plugin no longer declares, a `select` value no longer offered, a type that
  changed. The operator sees exactly which fields do not fit before anything is
  written, and may apply the rest.

That last point is a deliberate rejection of a version number on the schema. A
declared version says "this might not fit" and depends on plugin authors
bumping it honestly, which cannot be enforced and will be forgotten. Validating
the values against the live schema says "the field `legacyMode` no longer
exists", needs nothing from the author, and reuses the machinery §2.5 already
requires. A version is a promise; validation is a measurement.

Capturing a template from a node's current settings is how one is normally
created, which makes "configure one machine, apply to the rest" the default
path rather than a feature to discover.

### 2.8 Protocol 4

`NODE_PROTOCOL_VERSION` 3 -> 4. §9 names one command; three are needed, because
writing, reading and judging are three operations:

```
plugin_set_settings     { id, settings }        -> { ok } | { issues }
plugin_get_settings     { id }                  -> { values, secretsSet }
plugin_validate_profile { id, profile }         -> { valid, issues }
```

- `plugin_set_settings` runs the plugin's `validateSettings` before writing, so
  a rejected value never lands, and returns the plugin's own issues.
- `plugin_get_settings` returns values with every `secret` key replaced by its
  presence in `secretsSet`. The raw value has no path to the wire.
- `plugin_validate_profile` is the round-trip of §2.5 layer 2. It writes
  nothing.

**The SCHEMA does not need a command.** It is static for a given plugin
version, so `pluginSettings` joins `profileSettings` on `PluginReportWire` and
arrives with the inventory the node already sends. Only the VALUES need asking
for, because they change without the plugin changing.

`local` takes all three by direct call, as it does for every other plugin verb
since phase 2b.

## 3. Failure behavior, stated once

| failure | outcome |
|---|---|
| save profile settings, no node with that plugin online | 409 naming the plugin (§2.6); nothing stored |
| save profile settings, plugin rejects them | the plugin's own issues, per field, in the editor; nothing stored |
| save plugin settings, node offline | 409 naming the node, exactly like an install |
| a `secret` field with a `default` | refused at plugin load, the same class as an invalid manifest |
| a `showIf` naming an unknown key | the field hides; no error (§2.2.1) |
| a required but hidden field is empty | saves; hidden fields are not validated (§2.2.1) |
| apply a template whose fields no longer fit | per-field report before writing; the operator may apply the remainder |
| apply a template to a node lacking that plugin | refused; a template is scoped to one `pluginId` |
| read settings for a plugin with no settings file | every field at its default, secrets unset; not an error |
| plugin declares `pluginSettings` without the `settings` capability | refused at load, matching how `resume` is already policed |

## 4. Security

- **A new secret store exists on every node that uses one**:
  `<dataDir>/plugin-settings/*.json`, 0600 in a 0700 directory, plaintext by
  the same reasoning that leaves pane logs unencrypted. Whoever owns that OS
  user can read it, which is already true of everything a plugin touches.
- **Secrets never reach the control plane.** Not its database, not its
  backups, not a response body, not a log line. This is stronger than the
  profile `envJson` precedent, which stores values server-side and merely
  redacts them from machine callers.
- **Editing plugin settings is node-owner-only**, matching install and
  uninstall: the settings decide how a program runs on that machine.
- **Editing profile settings is profile-owner-only**, unchanged from profiles
  today.
- **Third-party schema text renders in an operator's browser**: labels,
  descriptions, section names and choice values. Normalized at the view
  boundary exactly as phase 4 normalizes reported plugin names, and never
  rendered as markup.
- **No third-party code reaches the browser or the control plane.**
  Conditional visibility is declarative data for this reason (§2.2.1), and
  every plugin-authored rule runs on the node.

## 5. Testing

- **plugin-api**: schema validation refuses a `secret` with a `default`, and
  refuses `pluginSettings` without the `settings` capability. `SettingsField`
  round-trips through the wire type with every new property.
- **pane-runtime**: the settings file is written 0600 in a 0700 directory and
  survives an install, an update and an uninstall-then-reinstall of the same
  plugin (the §2.4 correction, proven rather than asserted); reads return
  secrets as presence only; `validateSettings` rejection prevents the write.
- **protocol**: v4 parse cases for all three commands, including malformed
  settings objects; v3 refused by the exact-match gate.
- **server**: schema validation per §2.2.1's three rules; the §2.6 resolution
  ladder including the none-online refusal; templates are per-user invisible to
  others; apply reports per-field misfits without writing.
- **web**: sections and groups render in declaration order; a `showIf` field
  appears and disappears; a hidden required field does not block save; a secret
  renders as set with Replace and never as a value; the plugin's own issues
  render per field.
- **e2e**: configure a plugin on `local` through the browser, capture a
  template, apply it to the e2e demo plugin on a second node, and see the
  misfit report for a field that does not exist there.

## 6. Corrections to the parent spec

- **§9 "stored on the node, beside the plugin"** must mean a sibling path, not
  a file inside the plugin directory, which phase 3's install swap destroys
  (§2.4).
- **§9 names `plugin_set_settings` alone.** Reading values and validating a
  profile are separate operations and separate commands (§2.8).
- **§9 implies the schema travels with the settings.** It does not need to: a
  schema is static per plugin version and rides the plugin report (§2.8).
- **§9's `settingsFields` is served from server-side plugin code today**
  (`GET /api/profiles/harnesses/:id/schema` calls `getHarness`), so a plugin
  installed only on a remote node has no schema at all. It must be served from
  reported data, which §11 already anticipated.

## 7. Landmines carried into the plan

- **This phase is larger than phase 3 was.** Both surfaces, a new schema
  language, a new store, three protocol commands, a new table and a template
  UI. The plan should consider splitting it into 5 (settings) and 5b
  (templates), which are separable at the template table.
- **A new table needs a migration AND registration** in the static provider map
  in `apps/server/api/src/db/migrate.ts`; the CLI scans the folder but the
  boot-time migrator reads the map, and the file name and key must match.
- **Protocol 4 touches the census**: each new command must appear in the
  agent's command coverage test in the same commit as the parser.
- **`profiles.settingsJson` already reaches `buildCommand`.** Do not add a
  second path for the same value; the editor writes the column that already
  works.
- **The `settings` capability already exists** in `PluginCapability` and is
  derived from `Boolean(plugin.profileSettings)`. It MUST become "either
  schema", and that is load-bearing rather than tidy: §3 refuses a plugin
  declaring `pluginSettings` without the capability, so a plugin offering only
  node settings would otherwise fail a check it has no way to pass. Widening
  the derivation also grants the capability to plugins that previously lacked
  it, which is a behavior change to make deliberately and to pin with a test.
- **A stale dist produces false greens.** Rebuild before trusting a downstream
  suite; this bit phase 3 twice.

## 8. Deferred, with the door left open

- **Sharing templates.** Per-user and private is the starting point; the
  vocabulary for grants already exists on subshells and nodes if usage asks for
  it.
- **Templates for profile settings.** Unpinned profiles already carry settings
  everywhere, so a template would duplicate a profile. If profiles ever become
  node-scoped, revisit this first.
- **Nested or boolean conditions** (`AND`/`OR`, conditions on conditions). The
  single-condition form covers what a settings page needs; a schema wanting
  more is usually asking for a section.
- **Settings in the Subshell Client node window.** §10.3 draws this line
  deliberately: that window exists to get a machine working, and the server UI
  is where a fleet is configured.
