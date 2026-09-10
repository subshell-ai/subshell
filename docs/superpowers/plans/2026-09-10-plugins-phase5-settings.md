# Plugin Settings (Phase 5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a person configure a plugin: per-profile knobs rendered from a schema the plugin declares, per-machine settings stored on the node with write-only secrets, validation that actually reaches the plugin, and reusable templates so a fleet is configured once.

**Architecture:** One schema language (`SettingsField` grown with sections, groups, declarative conditions, `required` and a write-only `secret` type) rendered by ONE component serving both surfaces. Profile values keep living in `profiles.settingsJson`, which already reaches `buildCommand`. Node values live in a NEW store at `<dataDir>/plugin-settings/<id>.json`, deliberately outside the plugin directory because the installer renames over that. Three new protocol commands (set, get, validate-profile) take protocol 3 to 4. Templates are a per-user table whose fit against a target node is measured at apply time rather than declared by a version.

**Tech Stack:** Bun 1.4.x, TypeScript strict, ElysiaJS + TypeBox, Kysely/SQLite, React 19 + TanStack Query, `bun test`, Playwright, biome.

**Spec:** `docs/superpowers/specs/2026-09-10-plugins-phase5-settings-design.md`. Read it before Task 1; §2.1 to §2.8 are the decisions, §6 lists four corrections to the parent spec, §7 the landmines. Parent: `2026-09-09-plugin-architecture-design.md` §9. Predecessor: `2026-09-10-plugins-phase4-ux-design.md`, which must be IMPLEMENTED before this plan starts (it takes protocol to 3 and puts plugin identity on the node view; this plan assumes both).

## Global Constraints

Every task's requirements implicitly include all of these.

- **No new runtime dependencies.** The agent is a compiled binary.
- **No `await import()`** outside `packages/pane-runtime/src/plugin-runtime.ts`.
- **No third-party code reaches the browser or the control plane.** This is why conditions are data (§2.2.1). Never `eval`, never `new Function`, never a plugin-supplied predicate.
- **No em dashes in operator-facing strings.** Repo prose and code comments follow their own file's convention.
- **TDD, red then green**, and prove every guard by reverting it.
- **Rebuild dists before trusting a downstream suite** (`bunx turbo build --filter=<pkg>`). This bit phase 3 twice.
- **Every Elysia `t` schema property carries a `description`.**
- **A new migration must be created AND registered** in the static provider map in `apps/server/api/src/db/migrate.ts`. The file name and the map key must match.
- **Verification before each commit:** `bunx turbo run verify-types --force`, `bun run lint:check`, the touched package's `bun test`.
- **Known sanctioned baseline:** `apps/server/api` "ZERO-BYTE upload" fails on bun 1.4.2. Unrelated. `@internal/server-web` prints ECONNREFUSED noise while passing.
- **Protocol census:** a new command appears in the agent's command coverage test in the SAME commit as the parser.
- **Commit messages** end with the `Co-Authored-By:` trailer your harness specifies.

## Lane map, and where this plan can be split

```
A (contract):   1 -> 2
B (node):       3 -> 4          needs 1, 2
C (server):     5, 6 parallel;  7 needs 3,4,5,6
D (web):        8 -> 9, 10      needs 7
E (templates):  11 -> 12        needs 7, 10        <-- the 5b split point
F (close):      13              needs everything
```

**Tasks 1 to 10 and 13 are a complete, shippable phase on their own.** Lane E adds templates. If this phase needs splitting for review or scheduling, cut between 10 and 11 and give Lane E its own plan; nothing in 1 to 10 depends on the templates table.

---

### Task 1: The schema language in the plugin contract

**Files:**
- Modify: `packages/plugin-api/src/types.ts` (`SettingsField` around line 159; `SubshellPlugin` around line 215; `capabilityMismatches` around line 295)
- Modify: `packages/plugin-api/src/validate.ts`
- Test: `packages/plugin-api/src/__tests__/`

**Interfaces:**
- Consumes: nothing.
- Produces: `SettingsFieldType`, `SettingsCondition`, the grown `SettingsField`, `pluginSettings?()`, `validateSettings?()`, `SettingsValidationResult`, and `validateSettingsSchema(fields)`.

- [ ] **Step 1: Write the failing tests**

```ts
describe("settings schema", () => {
  test("a secret field may not declare a default", () => {
    const problems = validateSettingsSchema([
      { key: "apiKey", label: "API key", type: "secret", default: "sk-live-oops" },
    ]);
    expect(problems).toContain('field "apiKey": a secret cannot declare a default');
  });

  test("a select field must offer choices", () => {
    expect(validateSettingsSchema([{ key: "mode", label: "Mode", type: "select" }])).toHaveLength(1);
  });

  test("duplicate keys are refused, because the last one would silently win", () => {
    const problems = validateSettingsSchema([
      { key: "mode", label: "Mode", type: "string" },
      { key: "mode", label: "Mode again", type: "string" },
    ]);
    expect(problems).toContain('duplicate field key "mode"');
  });

  test("a plugin offering only node settings still gets the settings capability", () => {
    const plugin = makePlugin({ pluginSettings: () => [{ key: "endpoint", label: "Endpoint", type: "string" }], capabilities: () => ["settings"] });
    expect(capabilityMismatches(plugin)).toEqual([]);
  });

  test("declaring settings while implementing neither schema is still a mismatch", () => {
    const plugin = makePlugin({ capabilities: () => ["settings"] });
    expect(capabilityMismatches(plugin)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `cd packages/plugin-api && bun test`
Expected: FAIL, `validateSettingsSchema is not defined`, and the capability test fails because `implemented.settings` reads `profileSettings` only.

- [ ] **Step 3: Grow the types**

In `types.ts`, replace `SettingsField` and add the condition type:

```ts
/** The controls a settings schema can ask for. `secret` is write-only (spec §2.3). */
export type SettingsFieldType = "string" | "boolean" | "number" | "select" | "secret";

/**
 * When a field is shown.
 *
 * DATA, never a predicate function, and that is a security boundary rather
 * than a convenience: a plugin shipping JavaScript to be evaluated in an
 * operator's browser would break the rule that no third-party code reaches the
 * browser or the control plane. Our renderer interprets these shapes.
 *
 * A condition naming a key the schema does not declare is FALSE, so the field
 * hides rather than crashing or ignoring its own condition.
 */
export type SettingsCondition =
  | { key: string; equals: string | number | boolean }
  | { key: string; in: (string | number | boolean)[] }
  | { key: string; truthy: true };

/** A single option in a plugin's settings editor. */
export interface SettingsField {
  /** Key into the settings object (e.g. "permissionMode") */
  key: string;
  /** Property label */
  label: string;
  /** Per-field help, rendered under the control */
  description?: string;
  /** Which control to render */
  type: SettingsFieldType;
  /** Choices when type is "select" */
  choices?: string[];
  /** Default when unset. Never allowed on a `secret`: a default credential is either useless or a shipped one */
  default?: string | boolean | number;
  /** Refuse to save when empty AND visible. A hidden field is never required (spec §2.2.1) */
  required?: boolean;
  /** Section heading to group under; fields declaring none render first */
  section?: string;
  /** Sub-heading within a section, for fields that belong together */
  group?: string;
  /** Show only when this holds */
  showIf?: SettingsCondition;
}

/** What a plugin says about settings values it was handed. */
export interface SettingsValidationResult {
  valid: boolean;
  issues?: { key: string; message: string }[];
}
```

Add to `SubshellPlugin`, beside `profileSettings`:

```ts
  /** Settings rendered on this plugin's page on a NODE, stored there, not on a profile. */
  pluginSettings?(): SettingsField[];
  /** Judges node settings before they are written. Runs where the plugin lives. */
  validateSettings?(settings: Record<string, unknown>): SettingsValidationResult;
```

- [ ] **Step 4: Widen the capability derivation**

In `capabilityMismatches`:

```ts
    // Either schema earns the capability. Without this a plugin offering only
    // node settings could neither declare it (nothing implemented) nor omit it
    // (members implemented), so it would be unloadable either way.
    settings: Boolean(plugin.profileSettings ?? plugin.pluginSettings),
```

- [ ] **Step 5: Add the schema validator**

In `validate.ts`:

```ts
/**
 * Structural problems in a settings schema, checked at plugin load.
 *
 * These are AUTHOR errors rather than operator ones, so they are refused where
 * a plugin is loaded, in the same breath as a capability mismatch, rather than
 * surfacing later as a form that cannot work.
 */
export function validateSettingsSchema(fields: SettingsField[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const f of fields) {
    if (seen.has(f.key)) problems.push(`duplicate field key "${f.key}"`);
    seen.add(f.key);
    if (f.type === "secret" && f.default !== undefined) {
      problems.push(`field "${f.key}": a secret cannot declare a default`);
    }
    if (f.type === "select" && (f.choices === undefined || f.choices.length === 0)) {
      problems.push(`field "${f.key}": a select must offer choices`);
    }
  }
  return problems;
}
```

Export both new symbols from `packages/plugin-api/src/index.ts`.

- [ ] **Step 6: Run, prove, commit**

Run: `cd packages/plugin-api && bun test`. Then temporarily revert the `?? plugin.pluginSettings` widening and confirm the node-settings-only capability test fails. Restore, re-run green.

```bash
bunx turbo build --filter=@subshell-ai/plugin-api
git add packages/plugin-api && git commit
```

Message: `feat(plugin-api): a settings schema that can describe a real page`.

---

### Task 2: Protocol 4

**Files:**
- Modify: `packages/subshell-protocol/src/node-frames.ts`
- Test: `packages/subshell-protocol/src/__tests__/node-frames.test.ts`

**Interfaces:**
- Consumes: Task 1's shapes (mirrored, not imported: the protocol package must not depend on plugin-api).
- Produces: `NODE_PROTOCOL_VERSION = 4`; `SettingsFieldWire` grown; `SettingsConditionWire`; `PluginReportWire.pluginSettings`; three command variants; `PluginSettingsValuesWire`.

**CRITICAL:** every wire type here is a `type` alias, never an `interface`, because these ride inside results typed as `JsonValue`. The file says so above `SettingsFieldWire`.

- [ ] **Step 1: Write the failing tests**

```ts
test("the protocol version is 4", () => {
  expect(NODE_PROTOCOL_VERSION).toBe(4);
});

test("plugin_set_settings carries an id and an object", () => {
  expect(parseNodeCommandBody({ type: "plugin_set_settings", id: "pi", settings: { a: 1 } })).toEqual({
    type: "plugin_set_settings", id: "pi", settings: { a: 1 },
  });
});

test("plugin_set_settings refuses a non-object settings value", () => {
  expect(parseNodeCommandBody({ type: "plugin_set_settings", id: "pi", settings: [] })).toBeNull();
  expect(parseNodeCommandBody({ type: "plugin_set_settings", id: "pi", settings: null })).toBeNull();
});

test("plugin_get_settings needs an id", () => {
  expect(parseNodeCommandBody({ type: "plugin_get_settings", id: "pi" })).toEqual({ type: "plugin_get_settings", id: "pi" });
  expect(parseNodeCommandBody({ type: "plugin_get_settings" })).toBeNull();
});

test("plugin_validate_profile carries the profile definition", () => {
  const profile = { name: "p", env: {}, flags: [], settings: { a: 1 }, configIsolation: false };
  expect(parseNodeCommandBody({ type: "plugin_validate_profile", id: "pi", profile })).toEqual({
    type: "plugin_validate_profile", id: "pi", profile,
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `cd packages/subshell-protocol && bun test`

- [ ] **Step 3: Bump and grow the wire types**

`NODE_PROTOCOL_VERSION` 3 -> 4, with a comment recording that 4 adds the three settings commands. Grow `SettingsFieldWire` to mirror Task 1's `SettingsField` exactly (same property names, `type` widened with `"secret"`, plus `required`, `section`, `group`, `showIf`), add `SettingsConditionWire` mirroring `SettingsCondition`, and add to `PluginReportWire`:

```ts
  /** Settings rendered on this plugin's page on a node, stored there. Static per plugin version, which is why it rides the report rather than needing a command */
  pluginSettings?: SettingsFieldWire[];
```

And the read result:

```ts
/**
 * A plugin's node-side settings values.
 *
 * Secrets are absent from `values` by construction and appear only as keys in
 * `secretsSet`: the raw value has no path to the wire (spec §2.3).
 */
export type PluginSettingsValuesWire = {
  /** Non-secret values currently stored on the node */
  values: Record<string, string | number | boolean>;
  /** Keys of `secret` fields that have a value stored */
  secretsSet: string[];
};
```

- [ ] **Step 4: Add the three command variants and parser cases**

Variants `plugin_set_settings { id, settings }`, `plugin_get_settings { id }`, `plugin_validate_profile { id, profile }`, each with a doc comment saying what it does and (for set) that the plugin validates before anything is written. Parser cases:

```ts
    case "plugin_set_settings": {
      if (!isStr(value.id)) return null;
      const s = value.settings;
      // A plain object only: an array passes `typeof === "object"` and would
      // reach a plugin as a shape it never declared.
      if (typeof s !== "object" || s === null || Array.isArray(s)) return null;
      return { type: "plugin_set_settings", id: value.id, settings: s as Record<string, unknown> };
    }
    case "plugin_get_settings":
      return isStr(value.id) ? { type: "plugin_get_settings", id: value.id } : null;
    case "plugin_validate_profile": {
      if (!isStr(value.id)) return null;
      const p = value.profile;
      if (typeof p !== "object" || p === null || Array.isArray(p)) return null;
      return { type: "plugin_validate_profile", id: value.id, profile: p as ProfileDefinitionWire };
    }
```

If no `ProfileDefinitionWire` exists yet, define one mirroring `ProfileDefinition` from plugin-api (name, description?, env, flags, settings, configIsolation, restartOnExit?).

- [ ] **Step 5: Run, prove, commit**

Run the suite. Prove the array guard by dropping `Array.isArray(s)` and watching that test fail. Then:

```bash
bunx turbo build --filter=@internal/subshell-protocol
git add packages/subshell-protocol && git commit
```

Message: `feat(protocol): settings commands, and a schema that can carry a page (protocol 4)`.

---

### Task 3: The node-side settings store

**Files:**
- Create: `packages/pane-runtime/src/plugin-settings.ts`
- Modify: `packages/pane-runtime/src/plugin-report.ts` (around line 89)
- Modify: `packages/pane-runtime/src/plugin-runtime.ts` (the load check around line 233)
- Modify: `packages/pane-runtime/src/index.ts` (exports)
- Test: `packages/pane-runtime/src/__tests__/plugin-settings.test.ts`

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces: `readPluginSettings(dataDir, id, schema)`, `writePluginSettings(dataDir, id, values, schema)`, `pluginSettingsPath(dataDir, id)`.

**Context and the whole point of this task's location:** settings live at `<dataDir>/plugin-settings/<id>.json`, NOT inside `<dataDir>/plugins/<id>/`. Phase 3's `installStaged` renames a staged directory over the target, so anything written inside is destroyed by the next install. `install.json` survives only because the installer rewrites it every time. Use `enforceMode` from `fs-mode.ts` the way `plugins-dir.ts` already does: 0600 files in a 0700 directory.

- [ ] **Step 1: Write the failing tests**

```ts
test("values survive a reinstall of the plugin", async () => {
  await writePluginSettings(dataDir, "pi", { endpoint: "https://a" }, schema);
  await installPlugin(dataDir, { id: "pi" });            // re-stages and renames the plugin dir
  expect((await readPluginSettings(dataDir, "pi", schema)).values.endpoint).toBe("https://a");
});

test("values survive an uninstall, so reinstalling keeps the machine's configuration", async () => {
  await writePluginSettings(dataDir, "pi", { endpoint: "https://a" }, schema);
  await uninstallPlugin(dataDir, "pi");
  expect((await readPluginSettings(dataDir, "pi", schema)).values.endpoint).toBe("https://a");
});

test("a secret is stored but never read back", async () => {
  await writePluginSettings(dataDir, "pi", { apiKey: "sk-live-1" }, secretSchema);
  const read = await readPluginSettings(dataDir, "pi", secretSchema);
  expect(read.values.apiKey).toBeUndefined();
  expect(read.secretsSet).toEqual(["apiKey"]);
  expect(await Bun.file(pluginSettingsPath(dataDir, "pi")).text()).toContain("sk-live-1");
});

test("the file is 0600 in a 0700 directory", async () => {
  await writePluginSettings(dataDir, "pi", { endpoint: "https://a" }, schema);
  expect((await stat(pluginSettingsPath(dataDir, "pi"))).mode & 0o777).toBe(0o600);
  expect((await stat(dirname(pluginSettingsPath(dataDir, "pi")))).mode & 0o777).toBe(0o700);
});

test("an absent file reads as defaults, not an error", async () => {
  const read = await readPluginSettings(dataDir, "never-configured", schema);
  expect(read.values).toEqual({ endpoint: "https://default" });
  expect(read.secretsSet).toEqual([]);
});

test("writing omits a secret key, leaving the stored one alone", async () => {
  await writePluginSettings(dataDir, "pi", { apiKey: "sk-live-1" }, secretSchema);
  await writePluginSettings(dataDir, "pi", {}, secretSchema);   // form saved without touching the secret
  expect((await readPluginSettings(dataDir, "pi", secretSchema)).secretsSet).toEqual(["apiKey"]);
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `cd packages/pane-runtime && bun test src/__tests__/plugin-settings.test.ts`

- [ ] **Step 3: Implement the store**

`plugin-settings.ts` with a module doc comment stating the §2.4 correction (why it is a sibling of the plugin directory and not inside it, naming the rename). Behavior:

- `pluginSettingsPath(dataDir, id)` returns `join(dataDir, "plugin-settings", `${id}.json`)`, asserting the id with the same `SAFE_PLUGIN_ID` rule `plugins-dir.ts` uses, since the id becomes a filename.
- `readPluginSettings` returns `{ values, secretsSet }`: stored non-secret values with schema defaults filled in for missing keys, and the KEYS of secret fields that have a stored value. A missing file is `{}` before defaults, never a throw. Junk JSON reads as empty, matching how `readNodePlugins` treats junk.
- `writePluginSettings` merges: a secret key ABSENT from the incoming values keeps its stored value (that is how a form saves without re-entering a credential), and a secret key present with an empty string CLEARS it. Non-secret keys are replaced wholesale. Write via a temp file and `rename` for atomicity, then `enforceMode`.

- [ ] **Step 4: Report the schema, and police it at load**

In `plugin-report.ts`, beside `profileSettings`, add `...(plugin.pluginSettings ? { pluginSettings: plugin.pluginSettings() } : {})`.

In `plugin-runtime.ts`, where `capabilityMismatches` is consulted, also run `validateSettingsSchema` over both schemas and refuse the load with the same shape of message when it returns problems. A settings page that cannot work should fail where a broken manifest fails, not in a browser.

- [ ] **Step 5: Run, prove, commit**

Run the pane-runtime suite. Prove the location decision: temporarily point `pluginSettingsPath` inside the plugin directory and confirm the reinstall test fails. Restore.

```bash
bunx turbo build --filter=@internal/pane-runtime
git add packages/pane-runtime && git commit
```

Message: `feat(pane-runtime): node settings that survive an update, and secrets that never read back`.

---

### Task 4: The agent answers the three commands

**Files:**
- Modify: `apps/node/agent/src/commands/basics.ts`
- Modify: `apps/node/agent/src/commands/index.ts`
- Test: the command test file covering `execPluginInstall`, plus the census test

**Interfaces:**
- Consumes: Tasks 2 and 3.
- Produces: `execPluginSetSettings`, `execPluginGetSettings`, `execPluginValidateProfile`.

**Context:** follow `execPluginInstall`'s shape exactly, including returning `{ ok: false, error }` with the underlying message verbatim. Loading the plugin to call `validateSettings` / `validateProfile` goes through the same runtime the report builder uses; find how `plugin-report.ts` obtains a loaded plugin and reuse that, do not open a second loading path.

- [ ] **Step 1: Write the failing tests**

```ts
test("set_settings refuses what the plugin rejects, and writes nothing", async () => {
  const result = await execPluginSetSettings(ctx, { type: "plugin_set_settings", id: "rejects", settings: { a: 1 } });
  expect(result.ok).toBe(false);
  expect(await readPluginSettings(dataDir, "rejects", schema)).toEqual({ values: {}, secretsSet: [] });
});

test("get_settings never returns a secret value", async () => {
  await execPluginSetSettings(ctx, { type: "plugin_set_settings", id: "pi", settings: { apiKey: "sk-1" } });
  const result = await execPluginGetSettings(ctx, { type: "plugin_get_settings", id: "pi" });
  expect(JSON.stringify(result)).not.toContain("sk-1");
  expect((result as { ok: true; data: { secretsSet: string[] } }).data.secretsSet).toEqual(["apiKey"]);
});

test("validate_profile returns the plugin's own issues and writes nothing", async () => {
  const result = await execPluginValidateProfile(ctx, {
    type: "plugin_validate_profile", id: "picky",
    profile: { name: "p", env: {}, flags: [], settings: { bad: true }, configIsolation: false },
  });
  expect((result as { ok: true; data: { valid: boolean } }).data.valid).toBe(false);
});
```

- [ ] **Step 2: Run and watch them fail**
- [ ] **Step 3: Implement all three**

Each with a JSDoc saying what it does and what it does NOT do. `set` calls the plugin's `validateSettings` first and writes only on success; `get` returns `readPluginSettings`'s shape unchanged; `validate_profile` calls the plugin's `validateProfile` and writes nothing. None of the three pushes an inventory: `get` and `validate` change nothing, and `set` changes settings rather than the plugin SET the inventory reports.

- [ ] **Step 4: Dispatch and census**

Add three `case` arms in `commands/index.ts` and the three names to the coverage test, in this commit.

- [ ] **Step 5: Run, prove, commit**

Prove the secret guard: temporarily have `execPluginGetSettings` return the raw stored object and watch the `sk-1` assertion fail. Restore.

```bash
git add apps/node/agent && git commit
```

Message: `feat(agent): read, write and judge plugin settings`.

---

### Task 5: Schemas and profiles stop depending on server-side plugin code

**Files:**
- Modify: `apps/server/api/src/api/profiles.route.ts` (the `/harnesses/:id/schema` handler around line 187; the create handler around line 83; the `PUT` around line 211)
- Modify: `apps/server/api/src/api/harness-utils.ts` (add a reported-schema lookup)
- Test: `apps/server/api/src/api/__tests__/profiles-route.test.ts`

**Interfaces:**
- Consumes: phase 4's node view work (identity from reported data).
- Produces: `reportedSchemaFor(harnessId)` returning the schema from any node that reports the plugin.

**Context, and this is a bug fix as much as a feature:** `GET /api/profiles/harnesses/:id/schema` calls `getHarness(id)`, which is the SERVER's own registry, so a plugin installed only on a remote node has no schema. Worse, the profile CREATE handler refuses outright with `if (!getHarness(body.harnessId))`, and then calls `harnessUsable(body.harnessId)` with its default `local` node. So a profile for a remote-only plugin cannot be created at all, which would make this entire phase unreachable for third-party plugins. `harnessUsable` and `usableHarnessIds` are ALREADY node-aware and carry a comment saying the registry must not be consulted first for an agent; the create path never got the same treatment.

- [ ] **Step 1: Write the failing tests**

```ts
test("a profile can be created for a plugin only a remote node has", async () => {
  await seedNodePlugins(agentNodeId, [{ id: "acme-thing", name: "Acme Thing", type: "agent-harness", version: "1.0.0", description: "", capabilities: [] }]);
  const res = await createProfile({ harnessId: "acme-thing", name: "p", nodeId: agentNodeId });
  expect(res.status).toBe(200);
});

test("the schema for a remote-only plugin is served from what the node reported", async () => {
  await seedNodePlugins(agentNodeId, [{ id: "acme-thing", /* ... */ profileSettings: [{ key: "mode", label: "Mode", type: "string" }] }]);
  const res = await app.handle(withCookie(new Request("http://x/api/profiles/harnesses/acme-thing/schema")));
  expect((await res.json()).settingsFields).toEqual([{ key: "mode", label: "Mode", type: "string" }]);
});

test("a genuinely unknown harness is still refused", async () => {
  const res = await createProfile({ harnessId: "not-a-thing", name: "p" });
  expect(res.status).toBe(400);
});

test("usability is checked against the profile's own node, not always local", async () => {
  const res = await createProfile({ harnessId: "acme-thing", name: "p", nodeId: agentNodeId });
  expect(res.status).toBe(200);
});
```

- [ ] **Step 2: Run and watch them fail**
- [ ] **Step 3: Add the reported lookup**

In `harness-utils.ts`, a function that scans nodes' `plugins_json` for a plugin id and returns its reported `profileSettings` / `pluginSettings` / identity, preferring `local`. Reuse `readNodePlugins`, which already parses that column. Document that a plugin can be reported by several nodes at different versions and this returns the preferred one, naming §2.6's ladder as the shared rule.

- [ ] **Step 4: Fix the three call sites**

- `/harnesses/:id/schema`: serve from `getHarness(id)` when the server has it, else the reported lookup, else 404. Keep the MCP and suggestion fields behaving as they do for server-known plugins, and return empty arrays rather than throwing for a reported-only plugin whose report lacks them.
- The create handler: replace `if (!getHarness(body.harnessId))` with a check that the id is known to the server OR reported by some node, and pass `body.nodeId ?? LOCAL_NODE_ID` to `harnessUsable`.
- The `PUT` handler: apply the same two fixes if it repeats them.

- [ ] **Step 5: Run, prove, commit**

Prove the create fix by restoring `getHarness` and watching the remote-only creation test fail.

```bash
git add apps/server/api && git commit
```

Message: `fix(profiles): a profile for a plugin only a remote node carries`.

---

### Task 6: Schema validation on the control plane

**Files:**
- Create: `apps/server/api/src/services/settings-validation.ts`
- Test: `apps/server/api/src/services/__tests__/settings-validation.test.ts`

**Interfaces:**
- Consumes: the wire schema type from Task 2.
- Produces: `isFieldVisible(field, values)`, `validateAgainstSchema(fields, values) -> { key, message }[]`.

**Context:** this is layer 1 of §2.5 and the ONLY layer that needs no plugin. It is also where §2.2.1's three rules live, and each of them is a test.

- [ ] **Step 1: Write the failing tests**

```ts
test("a hidden required field does not block a save", () => {
  const fields = [
    { key: "mode", label: "Mode", type: "select", choices: ["a", "b"] },
    { key: "detail", label: "Detail", type: "string", required: true, showIf: { key: "mode", equals: "b" } },
  ];
  expect(validateAgainstSchema(fields, { mode: "a" })).toEqual([]);
});

test("a visible required field does block it", () => {
  const fields = [
    { key: "mode", label: "Mode", type: "select", choices: ["a", "b"] },
    { key: "detail", label: "Detail", type: "string", required: true, showIf: { key: "mode", equals: "b" } },
  ];
  expect(validateAgainstSchema(fields, { mode: "b" })).toEqual([{ key: "detail", message: "Detail is required" }]);
});

test("a condition on an unknown key hides the field", () => {
  const fields = [{ key: "x", label: "X", type: "string", required: true, showIf: { key: "ghost", equals: "y" } }];
  expect(validateAgainstSchema(fields, {})).toEqual([]);
});

test("a value outside a select's choices is refused", () => {
  const fields = [{ key: "mode", label: "Mode", type: "select", choices: ["a"] }];
  expect(validateAgainstSchema(fields, { mode: "z" })).toHaveLength(1);
});

test("a key the schema does not declare is refused", () => {
  expect(validateAgainstSchema([], { stray: 1 })).toHaveLength(1);
});

test("types are checked", () => {
  const fields = [{ key: "n", label: "N", type: "number" }];
  expect(validateAgainstSchema(fields, { n: "twelve" })).toHaveLength(1);
});
```

- [ ] **Step 2: Run and watch them fail**
- [ ] **Step 3: Implement**

`isFieldVisible` returns false when `showIf` names a key absent from the schema (not from the values: an unset key with a default is still declared). Otherwise it evaluates the three condition shapes against the current values. `validateAgainstSchema` skips invisible fields entirely, then checks required, type and choices, and finally reports keys present in `values` that no field declares. Never evaluate anything; these are three literal shapes.

- [ ] **Step 4: Run, prove, commit**

Prove the hidden-required rule by removing the visibility skip and watching the first test fail.

Message: `feat(server): validate settings against a schema, including the conditional rules`.

---

### Task 7: The round-trip and the routes

**Files:**
- Modify: `apps/server/api/src/services/nodes/plugin-sync.ts`
- Create: `apps/server/api/src/api/nodes/node-plugin-settings.route.ts`
- Modify: `apps/server/api/src/api/profiles.route.ts` (save path)
- Modify: `apps/server/api/src/api/nodes/index.ts` (register the route)
- Test: alongside each

**Interfaces:**
- Consumes: Tasks 3, 4, 5, 6.
- Produces: `resolveJudgeNode(harnessId, pinnedNodeId)`, `validateProfileOnNode`, `getNodePluginSettings`, `setNodePluginSettings`; the routes `GET|PUT /api/nodes/:id/plugins/:pluginId/settings`.

- [ ] **Step 1: Write the failing tests**

```ts
test("a pinned profile is judged by its own node", async () => {
  expect((await resolveJudgeNode("acme-thing", agentNodeId))?.id).toBe(agentNodeId);
});

test("an unpinned profile prefers local when local has the plugin", async () => {
  expect((await resolveJudgeNode("pi", null))?.id).toBe("local");
});

test("an unpinned profile falls back to an online node that has the plugin", async () => {
  expect((await resolveJudgeNode("acme-thing", null))?.id).toBe(agentNodeId);
});

test("no online node with the plugin refuses the save, naming the plugin", async () => {
  await setNodeOffline(agentNodeId);
  await expect(saveProfileSettings(profileId, { mode: "a" })).rejects.toMatchObject({ status: 409 });
});

test("plugin settings on an offline node are refused like an install", async () => {
  await setNodeOffline(agentNodeId);
  await expect(setNodePluginSettings(agentNode, "acme-thing", {})).rejects.toMatchObject({ status: 409 });
});
```

- [ ] **Step 2: Run and watch them fail**
- [ ] **Step 3: Implement the ladder**

```ts
/**
 * Which node judges a profile's settings (spec §2.6).
 *
 * A pinned profile is judged by its own node, online or refused. An unpinned
 * one claims to run anywhere, so any node running that plugin is a legitimate
 * judge: `local` first because it is in-process and always reachable, then the
 * first online node that has it.
 *
 * The wrinkle, stated rather than hidden: two nodes can run different versions
 * of one plugin, so the judge is not always the eventual launcher. Launch-time
 * validation (§2.5 layer 3) is what makes that survivable.
 */
export async function resolveJudgeNode(harnessId: string, pinnedNodeId: string | null): Promise<NodeTable | null>
```

Then `validateProfileOnNode` (sends `plugin_validate_profile`), `getNodePluginSettings` and `setNodePluginSettings` (send the other two), each branching on `isLocal` exactly as `installNodePlugin` does and reusing that file's `send` so an offline node becomes a 409 naming the node.

- [ ] **Step 4: Wire the profile save**

In the profile create and update handlers, when `settings` is present: run `validateAgainstSchema` (Task 6) against the reported schema (Task 5), then resolve the judge and round-trip. Schema issues and plugin issues both come back as field-keyed errors so the editor can render them per field. Nothing is stored unless both pass.

- [ ] **Step 5: Add the node settings routes**

`GET` and `PUT /api/nodes/:id/plugins/:pluginId/settings`, both `nodeCanManageFor`-gated exactly like install, both `requireCookieActor`. `PUT` is audited (`node.plugin.settings`) because it changes how a program runs on that machine; `GET` is not, because it reads. The audit metadata records the KEYS changed and never the values, since one of them may be a secret.

- [ ] **Step 6: Run, prove, commit**

Prove the ladder by making `local` lack the plugin and watching the preference test move to the agent node.

Message: `feat(server): settings reach the plugin, wherever it lives`.

---

### Task 8: One renderer, both surfaces

**Files:**
- Create: `apps/server/web/src/components/settings/settings-form.tsx`
- Create: `apps/server/web/src/components/settings/field-visibility.ts`
- Create: `apps/server/web/src/types/settings-schema.ts`
- Test: `apps/server/web/src/components/__tests__/settings-form.test.tsx`

**Interfaces:**
- Consumes: the wire schema shape.
- Produces: `<SettingsForm fields values secretsSet onChange issues />`, and `isFieldVisible` (the browser twin of Task 6's).

**Context:** ONE component serves the profile editor and the node settings page. The visibility rule must agree exactly with the server's, so port Task 6's `isFieldVisible` rather than writing a second interpretation, and say so in a comment on both.

- [ ] **Step 1: Write the failing tests**

Cover: sections render as headings in declaration order with unsectioned fields first; groups render within their section; a `showIf` field appears when its condition holds and disappears when it stops; a `secret` with `secretsSet` renders "set" plus Replace and never an input carrying a value; a `secret` not set renders an empty input; per-field issues render against their field; a select renders its choices.

- [ ] **Step 2: Run and watch them fail**
- [ ] **Step 3: Implement**

Group by `section` then `group`, preserving order. Render each type; `secret` renders as described. Hidden fields are omitted from the DOM entirely, not merely hidden with CSS, so a screen reader and a test agree with the validator about what is on the page.

- [ ] **Step 4: Run and commit**

Message: `feat(web): one settings renderer for both surfaces`.

---

### Task 9: Settings in the profile editor

**Files:**
- Modify: `apps/server/web/src/components/profile-fields.tsx`
- Modify: `apps/server/web/src/hooks/use-profiles.ts` (surface field-keyed issues from a save)
- Test: `apps/server/web/src/components/__tests__/profile-fields.test.tsx`

**Context:** the editor offers Harness, Name, Node, Env vars, Flags and Auto-restart today and nothing writes `settingsJson`. Add a Settings section between Flags and Auto-restart, rendered by Task 8's component from the harness schema endpoint.

- [ ] **Step 1: Write the failing tests**

Cover: the section renders the harness's fields; changing a field and saving sends `settings` in the body; a plugin issue returned by the save renders against its field; when the save fails with the no-online-node 409, the message names the plugin and the form keeps the user's input rather than clearing it.

- [ ] **Steps 2 to 4:** run red, implement, run green, commit.

Message: `feat(web): profiles can finally carry the settings they always stored`.

---

### Task 10: The node plugin settings page

**Files:**
- Create: `apps/server/web/src/routes/nodes_.$id.plugins.$pluginId.tsx`
- Modify: `apps/server/web/src/components/nodes/node-harness-card.tsx` (a Settings link per row, only where the plugin declares a schema)
- Test: alongside

**Context:** phase 4's card already renders rows and gates on `canManage`. The link appears only when the row's reported `pluginSettings` is non-empty, so a plugin with no node settings shows no dead link.

- [ ] **Step 1: Write the failing tests**

Cover: the link appears only for a plugin declaring node settings; the page loads values and renders secrets as set/unset; saving sends a PUT; a plugin rejection renders per field; an offline node renders the form read-only saying why; a non-manager gets 403 rather than a form.

- [ ] **Steps 2 to 4:** run red, implement, run green, commit.

Message: `feat(web): a settings page for a plugin on a node`.

---

## Lane E: templates (the 5b split point)

### Task 11: The templates table and its routes

**Files:**
- Create: `apps/server/api/src/db/migrations/0026-settings-templates.ts`
- Modify: `apps/server/api/src/db/migrate.ts` (register it; the key must equal the filename)
- Create: `apps/server/api/src/db/types/settings-templates.db-types.ts`
- Create: `apps/server/api/src/db/repositories/settings-templates.repository.ts`
- Create: `apps/server/api/src/api/settings-templates.route.ts`
- Test: alongside

**Interfaces:**
- Produces: `settings_templates` (id, user_id, name, plugin_id, values_json, created_at, updated_at) and CRUD at `/api/settings-templates`.

**Context:** per-user and private (§2.7). Every read and write filters by the caller's user id; a template belonging to someone else is 404, never 403, matching how subshells hide.

- [ ] **Step 1: Write the failing tests**

Cover: create, list, delete; another user's template is 404 on read and on delete; a name is unique per user and plugin; the row survives a round trip with its values intact.

- [ ] **Step 2 to 5:** migration + registration, repository, routes with full `description`s, run red then green, commit.

Message: `feat(server): per-user settings templates`.

### Task 12: Capture and apply

**Files:**
- Modify: `apps/server/api/src/api/settings-templates.route.ts` (a fit-check endpoint)
- Create: `apps/server/web/src/components/settings/template-actions.tsx`
- Modify: the node settings page from Task 10
- Test: alongside

**Interfaces:**
- Produces: `POST /api/settings-templates/:id/fit?nodeId=` returning per-field fit, and the apply flow.

**Context:** fit is MEASURED against the target node's current schema, never declared by a version (§2.7). Reuse Task 6's validator: a key the schema no longer declares, a select value no longer offered, a type that changed. Secrets are never captured and never applied.

- [ ] **Step 1: Write the failing tests**

```ts
test("capturing a template omits secrets", async () => {
  await setNodePluginSettings(node, "acme-thing", { endpoint: "https://a", apiKey: "sk-1" });
  const tpl = await captureTemplate(node.id, "acme-thing", "prod");
  expect(JSON.stringify(tpl)).not.toContain("sk-1");
  expect(Object.keys(tpl.values)).toEqual(["endpoint"]);
});

test("applying reports each field that no longer fits, and writes nothing until confirmed", async () => {
  const fit = await checkFit(templateId, otherNodeId);
  expect(fit.misfits).toContainEqual({ key: "legacyMode", reason: "no longer declared by this plugin" });
  expect(await getNodePluginSettings(otherNode, "acme-thing")).not.toHaveProperty("legacyMode");
});

test("a template cannot be applied to a node without that plugin", async () => {
  await expect(applyTemplate(templateId, nodeWithoutPlugin.id)).rejects.toMatchObject({ status: 400 });
});
```

- [ ] **Steps 2 to 4:** run red, implement capture (reads current settings, drops secret keys), fit (validates against the target's reported schema and reports per field), apply (writes the fitting subset through Task 7's setter), plus the UI on the settings page. Run green, commit.

Message: `feat: settings templates, checked against the plugin they are applied to`.

---

### Task 13: Docs, e2e, and the whole-suite pass

**Files:**
- Modify: `docs/security.md`, `.claude/rules/security-context.md`, `docs/node-protocol.md`, `docs/architecture.md`, `AGENTS.md`, `apps/server/api/AGENTS.md`, `packages/plugin-api/README.md` if one exists
- Create: `e2e/tests/16-plugin-settings.spec.ts`
- Modify: this plan (tick the boxes)

- [ ] **Step 1: Docs**

`docs/security.md` gains the settings paragraph: a new 0600 secret store on nodes, plaintext by the same reasoning that leaves pane logs unencrypted; secrets never reach the control plane's database, backups or response bodies; node settings are owner-only; third-party schema text is normalized before rendering. `.claude/rules/security-context.md` must agree with it. `docs/node-protocol.md` gains three command rows and the version becomes 4. The AGENTS files gain the settings store path and the new table.

- [ ] **Step 2: e2e**

`16-plugin-settings.spec.ts` against the fake registry's demo plugin: open its settings page on `local`, set a value and a secret, reload and confirm the secret shows as set and never as a value, capture a template, and check its fit against a second node. Finish by clearing what it set.

- [ ] **Step 3: Full verification**

```bash
bunx turbo build
bunx turbo run verify-types --force
bun run lint:check
bun run test
cd e2e && bunx playwright test
```

Green except the sanctioned ZERO-BYTE baseline.

- [ ] **Step 4: Tick and commit**

Message: `docs(plugins): phase 5 is documented, and the e2e proves a secret never comes back`.

---

## Self-Review (plan author, 2026-09-10)

**Spec coverage.** §2.1 both surfaces -> Tasks 1, 3, 9, 10. §2.2 schema language -> Task 1 (types), 2 (wire), 8 (renderer). §2.2.1 the three conditional rules -> Task 6's tests, mirrored in Task 8. §2.3 secrets -> Task 3 (store), 4 (never on the wire), 8 (set/Replace), 12 (never captured), 13 (e2e proof). §2.4 the location correction -> Task 3, with the reinstall test as its proof. §2.5 three validation layers -> Task 6 (schema), Task 7 (round-trip), Task 4 plus the launch call site. §2.6 the ladder -> Task 7. §2.7 templates -> Tasks 11, 12. §2.8 protocol 4 -> Task 2. §3's failure table is distributed across the tasks that own each row. §4 -> Task 13. §6's four corrections: the first is Task 3's whole point, the second and third are Task 2, the fourth is Task 5.

**One thing the spec did not anticipate, added here.** §2.5 layer 3 says `validateProfile` runs at launch, and the spec treats that as a detail. It is not: it is the only thing that makes §2.6's "the judge may not be the launcher" wrinkle survivable. Task 4 owns the handler, but the LAUNCH call site is in the node's launch path and must not be forgotten. If Task 4's implementer cannot find a clean seam for it, that is a plan defect to raise rather than skip, because dropping it silently removes the safety net the unpinned decision depends on.

**Known ambiguities, resolved here.**
- Writing a secret key with an empty string CLEARS it; omitting the key entirely LEAVES it. Without that distinction a form that does not re-send an untouched secret would wipe it on every save. Task 3 step 3 states both.
- Hidden fields are omitted from the DOM rather than CSS-hidden, so the browser and the validator agree about what is on the page (Task 8 step 3).
- `resolveJudgeNode` returns null rather than throwing, so the caller owns the 409 and its wording. Task 7's tests assert the wording names the plugin.

**Type consistency.** `SettingsField` (Task 1), `SettingsFieldWire` (Task 2) and the browser type (Task 8) declare the same property names; the two visibility implementations (Tasks 6 and 8) must stay identical and each carries a comment pointing at the other. `PluginSettingsValuesWire`'s `{ values, secretsSet }` is the shape returned by `readPluginSettings` (Task 3), the agent command (Task 4), the route (Task 7) and the form (Task 8), unchanged at every hop.

**What this plan does NOT do:** template sharing, templates for profile settings, nested or boolean conditions, and any settings surface in the Subshell Client node window. Each is in §8 of the spec with the reason.
