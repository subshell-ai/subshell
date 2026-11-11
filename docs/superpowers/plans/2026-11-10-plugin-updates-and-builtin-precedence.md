# Plugin Updates and Built-in Precedence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin update npm-installed plugins from Settings → Plugins (one or all, restart offered afterwards), and make a server upgrade resolve a built-in id to the newer of the bundled and installed copies, gated by `subshell.apiVersion`.

**Architecture:** One pure rule (`installedCopyWins`) decides the effective copy for a built-in id. The boot refresh stops downgrading embedded copies; the registry overlay loads a winning installed copy and the merged getters stop letting the compiled entry shadow it; the report builder describes the effective copy and never imports a losing one. A new admin-only, 15-minute-memoized endpoint compares sidecar'd installs against the configured registry's `latest`; a per-plugin update route reuses `installLocalPlugin`, then the page offers the existing restart machinery. Nothing restarts automatically.

**Tech Stack:** TypeScript on Bun, Elysia + TypeBox for routes, `bun:test`, React + TanStack Query for the SPA, `@internal/pane-runtime` for the plugin store.

**Spec:** `docs/superpowers/specs/2026-11-10-plugin-updates-and-builtin-precedence-design.md`

## Global Constraints

- **Writes are cookie-admin only** (`requireAdmin`); bearer keys are refused, exactly as install/enable/uninstall are today.
- **Registry URL:** detection and the act both use `SUBSHELL_PLUGIN_REGISTRY_URL` (constant, default `https://registry.npmjs.org`). Never hardcode npm. Tests use the existing `setPluginsRegistryUrlForTests` seam / `FakeRegistry.base`.
- **Install door:** the update act calls `installLocalPlugin(id, "<package>@latest", registryUrl)`. A bare package name that names a built-in, or a pin equal to the embedded version, would take the embedded-first door instead.
- **Integrity:** nothing is written before the sha512 check passes; a refusal leaves the previous copy byte-identical. No embedded fallback on an error.
- **No auto-update, no boot-time npm check, no hot reload** of code the process already imported.
- **No new dependencies.** No new runtime package.
- **Copy:** dialog titles are short and fixed ("Update this plugin?" / "Update N plugins?" / "Restart the server?"); names, versions and consequences go in the body. Use contractions and plain language. "Subshell" for the UI object, never "session".
- **Docs:** changeset is for `@internal/server` only; never hand-edit a CHANGELOG.
- **Test runs:** focused `bun test <file>` mid-task; package runs via `env -u SHELLOPTS -u BASHOPTS bunx turbo run test --filter=<pkg>`. Do not run the full suite.

## Review Focus

1. **A server downgrade leaves a newer installed built-in.** The overlay must load it and the merged getters must return it, not the older compiled copy. Test in Task 3.
2. **A newer installed copy that needs plugin-api 3 on a host implementing 2.** It must not be imported or win; the bundled copy answers and the row carries the protocol error. Test in Tasks 3 and 4.
3. **A shadowed npm copy.** The update check must compare `latest` against the effective version, not the sidecar version, or it offers an install the bundle still beats. Test in Task 6.
4. **Updating a built-in id that has a sidecar.** `@latest` must force the registry door; a bare name or an equal pin installs the embedded copy and drops the sidecar. Test in Task 7.
5. **A server that cannot restart itself, or a restart that would close panes.** No dead button; the command is named; the pane-safety warning stays in `RestartDialog`. Test in Task 10.

## Setup

- [ ] Create the branch `plugin-updates-and-builtin-precedence` in this checkout.
- [ ] Commit the design and plan before the first task:

```bash
git add docs/superpowers/specs/2026-11-10-plugin-updates-and-builtin-precedence-design.md docs/superpowers/plans/2026-11-10-plugin-updates-and-builtin-precedence.md
git commit -m "docs: design and plan plugin updates and built-in precedence"
```

---

### Task 1: Version helpers

**Files:**
- Create: `packages/pane-runtime/src/plugin-versions.ts`
- Modify: `packages/pane-runtime/src/index.ts` (export the two helpers)
- Test: `packages/pane-runtime/src/__tests__/plugin-versions.test.ts`

**Interfaces:**
- Produces:
  - `installedCopyWins(bundledVersion: string, installedVersion: string): boolean`
  - `bundledPluginVersion(id: string): Promise<string | null>`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bundledPluginVersion, installedCopyWins } from "../plugin-versions.js";

describe("installedCopyWins", () => {
  it("only a strictly newer installed version wins", () => {
    expect(installedCopyWins("1.2.0", "1.3.0")).toBe(true);
    expect(installedCopyWins("1.2.0", "1.2.0")).toBe(false);
    expect(installedCopyWins("1.2.0", "1.1.9")).toBe(false);
    expect(installedCopyWins("1.2.0", "")).toBe(false);
  });
});

describe("bundledPluginVersion", () => {
  it("reads the checkout copy of a built-in", async () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "../../../plugins/pi/package.json"), "utf8")) as {
      version: string;
    };
    expect(await bundledPluginVersion("pi")).toBe(pkg.version);
  });

  it("answers null for an id this build does not carry", async () => {
    expect(await bundledPluginVersion("no-such-plugin")).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test packages/pane-runtime/src/__tests__/plugin-versions.test.ts`
Expected: FAIL - module `../plugin-versions.js` not found.

- [ ] **Step 3: Implement the helpers**

In `plugin-versions.ts`, import `semverLt` from `@internal/subshell-protocol`, `packageJsonText`/`readBuiltIn` from `./builtin-source.js`. `installedCopyWins` returns `installedVersion !== "" && semverLt(bundledVersion, installedVersion)`. `bundledPluginVersion` returns null when `readBuiltIn` is null, parses `packageJsonText(source.files)`, and returns `version` only when it is a non-empty string; a parse failure answers null. Export both from `index.ts` beside the other plugins-dir exports.

- [ ] **Step 4: Run it to verify it passes**

Run: `bun test packages/pane-runtime/src/__tests__/plugin-versions.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/pane-runtime/src/plugin-versions.ts packages/pane-runtime/src/index.ts packages/pane-runtime/src/__tests__/plugin-versions.test.ts
git commit -m "feat(pane-runtime): add built-in version comparison helpers"
```

---

### Task 2: Refresh embedded copies only upward

**Review:** per-task - data loss

**Files:**
- Modify: `packages/pane-runtime/src/plugins-dir.ts` (`refreshStaleBuiltIns`, ~682-711)
- Test: `packages/pane-runtime/src/__tests__/install-registry.test.ts`

**Interfaces:**
- Consumes: `installedCopyWins` is not enough here; the refresh condition is `installed.broken || semverLt(installed.version, sourceVersion)`. `semverLt` is already imported.
- Produces: no new API; behavior change only.

- [ ] **Step 1: Write the failing tests**

Add to the existing `describe("refreshStaleBuiltIns ...")` block:

```ts
it("keeps an embedded copy that is newer than the bundle", async () => {
  const dir = tempDataDir();
  await installPlugin(dir, { id: "pi" });
  const pkgPath = join(pluginsDir(dir), "pi", "package.json");
  const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as { version: string };
  pkg.version = "99.0.0";
  await writeFile(pkgPath, JSON.stringify(pkg), "utf8");

  expect(await refreshStaleBuiltIns(dir)).toEqual([]);
  expect((await listInstalled(dir)).find((p) => p.id === "pi")?.version).toBe("99.0.0");
});

it("leaves an equal embedded copy alone", async () => {
  const dir = tempDataDir();
  await installPlugin(dir, { id: "pi" });
  await writeFile(join(pluginsDir(dir), "pi", "marker.txt"), "still here", "utf8");

  expect(await refreshStaleBuiltIns(dir)).toEqual([]);
  expect(existsSync(join(pluginsDir(dir), "pi", "marker.txt"))).toBe(true);
});

it("repairs a broken embedded copy", async () => {
  const dir = tempDataDir();
  await installPlugin(dir, { id: "pi" });
  await writeFile(join(pluginsDir(dir), "pi", "package.json"), "{not json", "utf8");

  const refreshed = await refreshStaleBuiltIns(dir);
  expect(refreshed).toEqual(["pi"]);
  expect((await listInstalled(dir)).find((p) => p.id === "pi")?.broken).toBeUndefined();
});
```

Add `readFile`/`writeFile` to the test file's `node:fs/promises` import; `existsSync`, `pluginsDir`, `installPlugin`, `listInstalled` are already imported.

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test packages/pane-runtime/src/__tests__/install-registry.test.ts`
Expected: the "keeps an embedded copy that is newer" test FAILS - the refresh downgrades it to the bundled version.

- [ ] **Step 3: Change the refresh condition**

Replace the `sourceVersion !== installed.version` test with `installed.broken || semverLt(installed.version, sourceVersion)`. Keep the existing sidecar skip and its log line. Update the docblock: refresh moves an embedded copy FORWARD to the bundle; it never moves one backward, and a registry-installed copy is never touched.

- [ ] **Step 4: Run them to verify they pass**

Run: `bun test packages/pane-runtime/src/__tests__/install-registry.test.ts`
Expected: PASS, including the existing registry-pin test.

- [ ] **Step 5: Commit**

```bash
git add packages/pane-runtime/src/plugins-dir.ts packages/pane-runtime/src/__tests__/install-registry.test.ts
git commit -m "fix(pane-runtime): never downgrade an embedded built-in at boot"
```

---

### Task 3: Version-aware overlay for built-in ids

**Review:** per-task - security

**Files:**
- Modify: `packages/pane-runtime/src/registry.ts` (`refreshInstalledPlugins`, `getHarness`, `getNetworkPlugin`, `mergedPlugins`, `allNetworkPlugins`, warning text)
- Test: `packages/pane-runtime/src/__tests__/installed-overlay.test.ts`

**Interfaces:**
- Consumes: `bundledPluginVersion` and `installedCopyWins` from Task 1.
- Produces: `refreshInstalledPlugins` may now put a built-in id in `overlay.plugins`/`overlay.networks`; `loaded` includes it. `getHarness`/`getNetworkPlugin` answer overlay first.

- [ ] **Step 1: Write the failing tests**

Extend the test helper's `opts` with `version?: string` and use it for the package's `version`. Add:

```ts
it("loads an installed copy newer than the bundle for a built-in id", async () => {
  const dir = tempDataDir();
  await writePlugin(dir, "pi", { version: "99.0.0", body: DISK_PI_BODY });
  await refreshInstalledPlugins(dir);
  expect(getHarness("pi")?.name).toBe("pi plugin");
  expect(getHarness("pi")?.buildCommand({ binary: "x" } as never)).toEqual(["x", "--from-pi"]);
  expect(allHarnesses().filter((h) => h.id === "pi")).toHaveLength(1);
});

it("keeps the compiled copy when the installed one is not newer", async () => {
  const dir = tempDataDir();
  await writePlugin(dir, "pi", { version: "0.0.1", body: DISK_PI_BODY });
  await refreshInstalledPlugins(dir);
  expect(getHarness("pi")?.name).toBe("pi");
  expect(allHarnesses().filter((h) => h.id === "pi")).toHaveLength(1);
});

it("loads a newer installed network plugin for a built-in id", async () => {
  const dir = tempDataDir();
  await writeNetworkPlugin(dir, "tailscale", "99.0.0");
  await refreshInstalledPlugins(dir);
  expect(getNetworkPlugin("tailscale")?.manifest.name).toBe("tailscale plugin");
  expect(allNetworkPlugins().filter((n) => n.manifest.id === "tailscale")).toHaveLength(1);
});
```

Add `DISK_PI_BODY` (the helper's default body is enough; it adds `--from-pi`) and a `writeNetworkPlugin` helper that writes a `network` manifest with `platforms: ["linux", "darwin"]`, `exposure: "private"`, and an entry exporting `capabilities`, `status`, `join`, `leave` as functions. Keep the existing shadow test: a `pi` copy at 1.0.0 with a sidecar still loses to the bundled copy and warns once.

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test packages/pane-runtime/src/__tests__/installed-overlay.test.ts`
Expected: the newer-copy tests FAIL - `getHarness("pi")` is still the compiled plugin.

- [ ] **Step 3: Implement the rule**

In `refreshInstalledPlugins`: when `BUILT_IN_IDS.has(installed.id)`, read `bundledPluginVersion(installed.id)`. If `bundled === null` or `!installedCopyWins(bundled, installed.version)`, keep the existing skip and once-per-process warning for a sidecar'd copy. Otherwise fall through to `runtime.load` like a third-party plugin and put it in the overlay; a load failure becomes a `broken` entry. A broken installed copy stays `broken` and never reaches the load.

Then make the overlay authoritative for ids it holds:
- `getHarness`: `overlay.plugins.get(id) ?? registry().plugins.find(...)`.
- `getNetworkPlugin`: `overlay.networks.get(id) ?? registry().networks.find(...)`.
- `mergedPlugins`: when the overlay is non-empty, `[...base.filter((p) => !overlay.plugins.has(p.id)), ...overlay.plugins.values()]`.
- `allNetworkPlugins`: the same filter-and-append.
- `builtInHarnesses`, `getBuiltInHarness`, `builtInIds` stay compiled-only.

Update the shadow warning to say the bundled copy is newer (it is the only reason a sidecar'd copy is skipped now): `an installed package claims plugin id "x", but this build's bundled copy is at least as new; the installed copy is not loaded`.

- [ ] **Step 4: Run them to verify they pass**

Run: `bun test packages/pane-runtime/src/__tests__/installed-overlay.test.ts`
Expected: PASS; the pre-existing "shadow" and "seeded copies refresh silently" tests still pass.

- [ ] **Step 5: Commit**

```bash
git add packages/pane-runtime/src/registry.ts packages/pane-runtime/src/__tests__/installed-overlay.test.ts
git commit -m "feat(pane-runtime): let a newer installed built-in win resolution"
```

---

### Task 4: Reports describe the effective copy

**Review:** per-task - security

**Files:**
- Modify: `packages/pane-runtime/src/types.ts` (`HarnessPlugin` - add `capabilities()`)
- Modify: `packages/pane-runtime/src/plugin-adapter.ts` (forward `capabilities`)
- Modify: `packages/pane-runtime/src/plugin-report.ts`
- Modify: `packages/subshell-protocol/src/node-frames.ts` (`PluginReportWire`)
- Test: `packages/pane-runtime/src/__tests__/plugin-report.test.ts`

**Interfaces:**
- Consumes: `installedCopyWins`, `bundledPluginVersion`, `readInstallRecord`, `getBuiltInHarness`, `builtInNetworkPlugins`, `brokenBuiltIns`.
- Produces:
  - `PluginReportWire` gains `source?: "build" | "npm" | "unrecorded"` and `shadowed?: { version: string; source: "build" | "npm" | "unrecorded"; error?: string }`.
  - `HarnessPlugin.capabilities(): string[]`.

- [ ] **Step 1: Write the failing tests**

Add to `plugin-report.test.ts` a helper that writes `<dataDir>/plugins/<id>/package.json` + `index.js` (a local copy of the overlay test's helper, with `version` and `body` options, plus an optional `install.json`). Tests:

```ts
it("describes the bundled copy when the installed one is older, and never imports it", async () => {
  const dir = tempDataDir();
  const marker = join(dir, "imported");
  await writePlugin(dir, "pi", {
    version: "0.0.1",
    body: `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "x"); export default () => ({ capabilities: () => [], buildCommand: (i) => [i.binary], validatePreset: () => ({ valid: true }) });`,
  });
  const [pi] = await buildPluginReports(dir);
  expect(pi?.version).toBe(await bundledPluginVersion("pi"));
  expect(pi?.source).toBe("build");
  expect(pi?.shadowed).toEqual({ version: "0.0.1", source: "build" });
  expect(existsSync(marker)).toBe(false);
});

it("names an npm copy that is present but not in use", async () => {
  const dir = tempDataDir();
  await writePlugin(dir, "pi", { version: "0.0.1", record: { name: "@subshell-ai/plugin-pi", version: "0.0.1" } });
  const [pi] = await buildPluginReports(dir);
  expect(pi?.source).toBe("build");
  expect(pi?.shadowed).toMatchObject({ version: "0.0.1", source: "npm" });
});

it("falls back to the bundle when the newer installed copy needs a newer host", async () => {
  const dir = tempDataDir();
  await writePlugin(dir, "pi", { version: "99.0.0", apiVersion: 99 });
  const [pi] = await buildPluginReports(dir);
  expect(pi?.version).toBe(await bundledPluginVersion("pi"));
  expect(pi?.broken).toBeUndefined();
  expect(pi?.shadowed?.error).toContain("plugin-api");
});

it("describes a newer installed copy that loads", async () => {
  const dir = tempDataDir();
  await writePlugin(dir, "pi", { version: "99.0.0" });
  const [pi] = await buildPluginReports(dir);
  expect(pi?.version).toBe("99.0.0");
  expect(pi?.source).toBe("build");
  expect(pi?.shadowed).toBeUndefined();
});
```

Add `source: "npm"` for a third-party install with a record, and that a third-party plugin with no record reports `"unrecorded"`.

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test packages/pane-runtime/src/__tests__/plugin-report.test.ts`
Expected: FAIL - `source` is undefined; the older disk copy is reported as the version; the marker is written (the loser is imported).

- [ ] **Step 3: Implement the effective report**

- Add `capabilities: () => plugin.capabilities()` to `adaptPlugin`, and `capabilities(): string[]` to `HarnessPlugin`.
- Add the two fields to `PluginReportWire`; update its comment to say the control plane is the writer.
- Restructure `buildPluginReports`:
  - For every `installed`, read `record = await readInstallRecord(dataDir, installed.id)`.
  - For a built-in id (`await readBuiltIn(id) !== null`): compute `bundled = await bundledPluginVersion(id)`.
    - If `!installed.broken && bundled !== null && installedCopyWins(bundled, installed.version)`: load the disk copy. On success, report it (source = record ? "npm" : "build"). On failure, fall back to the compiled copy and set `shadowed = { version: installed.version, source: record ? "npm" : "build", error }`.
    - Otherwise report the compiled copy: harness via `getBuiltInHarness(id)`, network via `builtInNetworkPlugins().find(...)`; if the compiled plugin is absent (factory threw), report it broken using `brokenBuiltIns().find(...)?.error`. Set `shadowed` only when the installed copy is broken or its version differs from `bundled`; version = `record?.version ?? installed.version`, source = record ? "npm" : "build".
  - For a non-built-in: load as today; source = record ? "npm" : "unrecorded".
  - Report fields for a compiled harness come from the adapted methods: `settingsFields()`, `suggestedEnv()`, `suggestedFlags()`, `mcpSetup(PLACEHOLDER, PLACEHOLDER)`, `exitStatus?.(code)`, `capabilities()`. Version is the bundled version.
  - Never call `runtime.load` on a losing copy; `listInstalled` and `readInstallRecord` answer version, source and manifest errors without importing.
- Keep the existing disk-report body for a winning installed copy, adding `source` and `restartRequired` as today.

- [ ] **Step 4: Run them to verify they pass**

Run: `bun test packages/pane-runtime/src/__tests__/plugin-report.test.ts packages/pane-runtime/src/__tests__/installed-overlay.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/pane-runtime/src/types.ts packages/pane-runtime/src/plugin-adapter.ts packages/pane-runtime/src/plugin-report.ts packages/subshell-protocol/src/node-frames.ts packages/pane-runtime/src/__tests__/plugin-report.test.ts
git commit -m "feat(pane-runtime): report the effective plugin copy"
```

---

### Task 5: Expose the effective copy on the API row

**Files:**
- Modify: `apps/server/api/src/api/plugins.route.ts` (`PluginRowSchema`, `toRow`)
- Test: `apps/server/api/src/api/__tests__/plugins-route.test.ts`

**Interfaces:**
- Consumes: the report fields from Task 4.
- Produces: `PluginRow` gains `source?`, `restartRequired?`, `shadowed?`; `version` is the effective version.

- [ ] **Step 1: Write the failing tests**

```ts
it("a registry copy that loses to the bundle reports the bundled version and the shadow", async () => {
  const reg = startFakeRegistry();
  try {
    reg.served.set("old-pi", { latest: "0.0.1", versions: { "0.0.1": makePluginTgz({ name: "old-pi", version: "0.0.1", id: "pi" }) } });
    setPluginsRegistryUrlForTests(reg.base);
    const res = await app.fetch(authedRequest("/api/plugins", adminCookie, { method: "POST", body: JSON.stringify({ pluginId: "pi", spec: "old-pi@0.0.1" }) }));
    expect(res.status).toBe(200);
    const row = (await res.json()) as { version: string; source: string; shadowed: { version: string; source: string } };
    const bundled = await bundledPluginVersion("pi");
    expect(row.version).toBe(bundled);
    expect(row.source).toBe("build");
    expect(row.shadowed).toEqual({ version: "0.0.1", source: "npm" });
  } finally {
    setPluginsRegistryUrlForTests(undefined);
    reg.stop();
  }
});
```

Use the test file's existing helpers and cookie names; resolve the built-in package path relative to the repo root rather than the test file if that is simpler. Add assertions that a seeded built-in row is `source: "build"` with no `shadowed`, and that a third-party install is `source: "npm"`.

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test apps/server/api/src/api/__tests__/plugins-route.test.ts`
Expected: FAIL - `source` is undefined.

- [ ] **Step 3: Extend the schema and mapping**

Add to `PluginRowSchema`:
- `source: t.Optional(t.Union([t.Literal("build"), t.Literal("npm"), t.Literal("unrecorded")]))`
- `restartRequired: t.Optional(t.Boolean())`
- `shadowed: t.Optional(t.Object({ version: t.String(), source: t.Union([...]), error: t.Optional(t.String()) }))`

In `toRow`, copy `report.source`, `report.restartRequired` and `report.shadowed` when present. `version` already comes from `report.version`.

- [ ] **Step 4: Run it to verify it passes**

Run: `bun test apps/server/api/src/api/__tests__/plugins-route.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/api/src/api/plugins.route.ts apps/server/api/src/api/__tests__/plugins-route.test.ts
git commit -m "feat(server): expose plugin source and effective version"
```

---

### Task 6: Update detection

**Files:**
- Modify: `packages/pane-runtime/src/plugins-dir.ts` (`PluginUpdate`, `resolvePluginUpdates`)
- Modify: `packages/pane-runtime/src/index.ts` (no new export; the type is already exported)
- Create: `apps/server/api/src/modules/plugins/update-check.ts`
- Modify: `apps/server/api/src/api/plugins.route.ts` (schemas + two admin GET/POST routes)
- Test: `packages/pane-runtime/src/__tests__/install-registry.test.ts`
- Test: `apps/server/api/src/modules/plugins/__tests__/update-check.test.ts`
- Test: `apps/server/api/src/api/__tests__/plugins-route.test.ts`

**Interfaces:**
- Produces:
  - `PluginUpdate = { id: string; name: string; from: string; to: string | null; error?: string }`
  - `resolvePluginUpdates(dataDir, opts: { id?: string; registryUrl?: string; effectiveVersion?: (id: string) => string | undefined }): Promise<PluginUpdate[]>`
  - `collectPluginUpdates(opts: { force: boolean; registryUrl: string }): Promise<PluginUpdatesView>`
  - `clearPluginUpdateMemo(): void`
  - `PluginUpdatesView = { updates: {id,name,from,to}[]; errors: {id,name,message}[]; checkedAt: number }`

- [ ] **Step 1: Write the failing resolver tests**

```ts
it("compares latest against the effective version, not the sidecar", async () => {
  const dir = tempDataDir();
  served.set("shadowed-pi", { latest: "0.0.5", versions: { "0.0.1": await builtInAsTgz("pi", "0.0.1"), "0.0.5": await builtInAsTgz("pi", "0.0.5") } });
  await installPlugin(dir, { id: "pi", spec: "shadowed-pi@0.0.1", registryUrl: base });
  const bundled = await bundledPluginVersion("pi");
  expect(await resolvePluginUpdates(dir, { registryUrl: base, effectiveVersion: () => bundled ?? undefined })).toEqual([
    { id: "pi", name: "shadowed-pi", from: bundled, to: null },
  ]);
});

it("reports a registry failure on the row", async () => {
  const dir = tempDataDir();
  await installPlugin(dir, { spec: "third-party@1.0.0", registryUrl: base });
  const [row] = await resolvePluginUpdates(dir, { registryUrl: trapBase, effectiveVersion: (id) => (id === "third" ? "1.0.0" : undefined) });
  expect(row?.to).toBeNull();
  expect(row?.error).toContain("registry");
});
```

Add a positive case: a third-party 1.0.0 with latest 1.1.0 yields `to: "1.1.0"`.

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test packages/pane-runtime/src/__tests__/install-registry.test.ts`
Expected: FAIL - `effectiveVersion` is ignored and no `error` is produced.

- [ ] **Step 3: Change the resolver**

In `resolvePluginUpdates`, set `const from = opts.effectiveVersion?.(p.id) ?? record.version;` and compare `latest.version` against `from`. On a registry failure, push `{ id, name: record.name, from, to: null, error: describe(err) }` and keep the existing log line. Update the docblock: `from` is the effective version supplied by the caller; the resolver never imports plugin code.

- [ ] **Step 4: Write the failing server module test**

`update-check.test.ts`:

```ts
it("memoizes for 15 minutes and force re-reads", async () => {
  // install one third-party plugin from reg, serve a newer version
  const first = await collectPluginUpdates({ force: false, registryUrl: reg.base });
  expect(first.updates.map((u) => u.id)).toContain("third");
  const hits = reg.hits.length;
  await collectPluginUpdates({ force: false, registryUrl: reg.base });
  expect(reg.hits.length).toBe(hits);
  await collectPluginUpdates({ force: true, registryUrl: reg.base });
  expect(reg.hits.length).toBeGreaterThan(hits);
  expect(typeof first.checkedAt).toBe("number");
});

it("splits registry failures into errors", async () => {
  const view = await collectPluginUpdates({ force: true, registryUrl: "http://127.0.0.1:1" });
  expect(view.errors[0]?.message).toContain("registry");
  expect(view.updates).toEqual([]);
});
```

Call `clearPluginUpdateMemo()` in `beforeEach`/`afterEach` so tests do not leak the memo.

- [ ] **Step 5: Run it to verify it fails**

Run: `bun test apps/server/api/src/modules/plugins/__tests__/update-check.test.ts`
Expected: FAIL - module not found.

- [ ] **Step 6: Implement the module**

`collectPluginUpdates` reads `localPluginReports()` from `./store.js` to build `effective = new Map(reports.map((r) => [r.id, r.version]))`, calls `resolvePluginUpdates(SUBSHELL_SERVER_DATA_DIR, { registryUrl, effectiveVersion: (id) => effective.get(id) })`, splits rows into `updates` (no error, `to !== null`) and `errors` (`{id, name, message}`), and sets `checkedAt: Date.now()`. Memoize `{ at, registryUrl, view }: { at: number; registryUrl: string; view: PluginUpdatesView } | null` with a `15 * 60_000` TTL; a different registry URL replaces the memo. `clearPluginUpdateMemo()` sets it to null.

- [ ] **Step 7: Write the failing route test**

In `plugins-route.test.ts`, add: admin `GET /api/plugins/updates` returns the offer; a second GET does not add fake-registry hits; `POST /api/plugins/updates/check` does; non-admin/bearer get 403; registry failure lands in `errors`.

- [ ] **Step 8: Run it to verify it fails**

Run: `bun test apps/server/api/src/api/__tests__/plugins-route.test.ts`
Expected: FAIL - 404 for `/api/plugins/updates`.

- [ ] **Step 9: Add the schemas and routes**

Add `PluginUpdateSchema` (`id`, `name`, `from`, `to` strings), `PluginCheckErrorSchema` (`id`, `name`, `message`), and a response schema with `updates`, `errors`, `checkedAt: t.Number()`. Add to `adminRoutes`, before the `/:pluginId` routes:

- `.get("/updates", ...)` → `collectPluginUpdates({ force: false, registryUrl: registryUrlOverride ?? SUBSHELL_PLUGIN_REGISTRY_URL })`.
- `.post("/updates/check", ...)` → the same with `force: true`.

Neither is audited; the doc comments mirror `update-check.route.ts` (a POST with a cost, change nothing on the host).

- [ ] **Step 10: Run both suites to verify they pass**

Run: `bun test apps/server/api/src/modules/plugins/__tests__/update-check.test.ts apps/server/api/src/api/__tests__/plugins-route.test.ts`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add packages/pane-runtime/src/plugins-dir.ts packages/pane-runtime/src/__tests__/install-registry.test.ts apps/server/api/src/modules/plugins/update-check.ts apps/server/api/src/modules/plugins/__tests__/update-check.test.ts apps/server/api/src/api/plugins.route.ts apps/server/api/src/api/__tests__/plugins-route.test.ts
git commit -m "feat(server): detect newer plugin versions on the configured registry"
```

---

### Task 7: The update act, its audit, and its docs

**Review:** per-task - security

**Files:**
- Modify: `apps/server/api/src/api/plugins.route.ts` (update route; clear the memo after install/uninstall)
- Modify: `apps/server/api/docs/plugins-on-the-plane.md`
- Modify: `apps/server/api/AGENTS.md`
- Modify: `docs/security.md`
- Test: `apps/server/api/src/api/__tests__/plugins-route.test.ts`

**Interfaces:**
- Consumes: `resolvePluginUpdates`, `readInstallRecord`, `installLocalPlugin`, `clearPluginUpdateMemo`, `localPluginReports`.
- Produces: `POST /api/plugins/:pluginId/update` → `PluginRowSchema` (200), 400/401/403/404/409.

- [ ] **Step 1: Write the failing tests**

```ts
it("updates a registry-installed plugin from latest and audits the package", async () => {
  // install "third" 1.0.0 from reg; serve 1.1.0; assert the route
  const res = await app.fetch(adminPost("/api/plugins/third/update"));
  expect(res.status).toBe(200);
  const row = (await res.json()) as { version: string };
  expect(row.version).toBe("1.1.0");
  expect(await readInstallRecord(SUBSHELL_SERVER_DATA_DIR, "third")).toMatchObject({ name: "third-party", version: "1.1.0" });
  const audits = await auditRows("plugin.update");
  expect(audits[0]?.metadataJson).toContain('"to":"1.1.0"');
});

it("refuses a plugin installed from this build", async () => {
  await installLocalPlugin("codex");
  const res = await app.fetch(adminPost("/api/plugins/codex/update"));
  expect(res.status).toBe(409);
  expect((await errorBody(res)).message).toContain("this build");
});

it("refuses when latest is not newer than the effective version", async () => {
  // installed 1.1.0, served latest 1.1.0
  const res = await app.fetch(adminPost("/api/plugins/third/update"));
  expect(res.status).toBe(409);
  expect((await errorBody(res)).message).toContain("already");
});
```

Add a registry-down case (trap base -> 409, install.json untouched), a protocol-incompatible package case (`makeTgz` with `apiVersion: 99` -> 409 naming plugin-api), and a non-admin 403.

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test apps/server/api/src/api/__tests__/plugins-route.test.ts`
Expected: FAIL - 404 for the update route.

- [ ] **Step 3: Implement the route**

Add to `adminRoutes`:

```ts
.post("/:pluginId/update", async ({ params, user }) => {
  // SAFE_PLUGIN_ID check
  // record = await readInstallRecord(SUBSHELL_SERVER_DATA_DIR, params.pluginId)
  // absent -> HarnessStateError(409, this copy came from this build...)
  // reports = await localPluginReports(); effective = Map(id -> version)
  // global resolvePluginUpdates(dir, { id, registryUrl, effectiveVersion: (id) => effective.get(id) })
  // update.error -> 409; update.to === null -> 409 `${name} is already at ${from}`
  // await installLocalPlugin(id, `${record.name}@latest`, registryUrl)
  // clearPluginUpdateMemo()
  // audit plugin.update { pluginId, package: record.name, from: update.from, to: update.to }
  // return requireRow(id, await readSources())
})
```

Call `clearPluginUpdateMemo()` after a successful install (the `POST /` handler) and uninstall too, so a cached check does not describe a store that has moved. The install handler's audit line stays as it is; the update gets its own action.

- [ ] **Step 4: Run it to verify it passes**

Run: `bun test apps/server/api/src/api/__tests__/plugins-route.test.ts`
Expected: PASS.

- [ ] **Step 5: Update the docs**

- `apps/server/api/docs/plugins-on-the-plane.md`: replace "Built-in ids always resolve to the compiled copy..." with the effective-copy rule (newer installed copy wins when its manifest parses; ties and unreadable copies go to the bundle), and add a short "Updating a plugin from npm" section naming the check endpoint, the update route, the `@latest` requirement, the audit and the restart offer.
- `apps/server/api/AGENTS.md` lines 155-173: the summary now says a winning installed copy resolves for a built-in id, and names `plugin.update` and the two update routes.
- `docs/security.md` §11.9: add one paragraph that an update reuses the install door (admin-only, integrity-checked, audited, same in-process execution), and that a losing installed copy is no longer imported to describe it.

- [ ] **Step 6: Run the docs-adjacent check**

Run: `bun run lint:check`
Expected: no new failures in the touched files.

- [ ] **Step 7: Commit**

```bash
git add apps/server/api/src/api/plugins.route.ts apps/server/api/src/api/__tests__/plugins-route.test.ts apps/server/api/docs/plugins-on-the-plane.md apps/server/api/AGENTS.md docs/security.md
git commit -m "feat(server): add plugin updates from npm"
```

---

### Task 8: SPA types and hooks

**Files:**
- Modify: `apps/server/web/src/hooks/use-instance-plugins.ts` (`InstancePluginRow` fields)
- Create: `apps/server/web/src/hooks/use-plugin-updates.ts`
- Test: `apps/server/web/src/hooks/__tests__/use-plugin-updates.test.tsx`

**Interfaces:**
- Produces:
  - `PLUGIN_UPDATES_QUERY_KEY = ["plugin-updates"]`
  - `PluginUpdatesView`, `PluginUpdateRow`, `PluginCheckError`
  - `usePluginUpdates(enabled: boolean)`
  - `useCheckPluginUpdates()` → `{ check(): void; pending: boolean; error: string | null }`
  - `useUpdatePlugin()` → mutation of `(id: string) => InstancePluginRow`

- [ ] **Step 1: Write the failing tests**

Using the fetch-spy wrapper from `use-instance-plugins.test.tsx`:

```ts
it("reads the check only once the viewer is a confirmed admin", async () => {
  // render usePluginUpdates(false): no GET /api/plugins/updates
  // render usePluginUpdates(true): one GET
});

it("the check POSTs and writes the fresh view into the query", async () => {
  // seed the query with one offer, POST returns zero offers, expect the cache to show zero
});

it("an update POSTs and refetches both lists", async () => {
  // update mutation + mounted useInstancePlugins and usePluginUpdates
  // expect GET /api/plugins and GET /api/plugins/updates after the POST
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test apps/server/web/src/hooks/__tests__/use-plugin-updates.test.tsx`
Expected: FAIL - module not found.

- [ ] **Step 3: Implement the hooks and row fields**

Add to `InstancePluginRow`:
```ts
source?: "build" | "npm" | "unrecorded";
restartRequired?: boolean;
shadowed?: { version: string; source: "build" | "npm" | "unrecorded"; error?: string };
```

`usePluginUpdates` is a `useQuery` with the key above, `apiFetch<PluginUpdatesView>("/api/plugins/updates")`, and `enabled`. `useCheckPluginUpdates` POSTs `/api/plugins/updates/check`, writes the answer with `setQueryData`, and invalidates it. `useUpdatePlugin` POSTs `/api/plugins/${id}/update`; on success invalidate `INSTANCE_PLUGINS_QUERY_KEY`, `PLUGIN_UPDATES_QUERY_KEY`, `PRESETS_QUERY_KEY`, `NETWORK_QUERY_KEY` and `PUBLIC_SETTINGS_QUERY_KEY` (an update can change a network plugin's manifest data, and the existing install/toggle mutations refresh the same surfaces).

- [ ] **Step 4: Run them to verify they pass**

Run: `bun test apps/server/web/src/hooks/__tests__/use-plugin-updates.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/web/src/hooks/use-instance-plugins.ts apps/server/web/src/hooks/use-plugin-updates.ts apps/server/web/src/hooks/__tests__/use-plugin-updates.test.tsx
git commit -m "feat(web): add plugin update queries and mutation"
```

---

### Task 9: The Installed card and its dialog

**Files:**
- Create: `apps/server/web/src/components/plugins/update-plugins-dialog.tsx`
- Modify: `apps/server/web/src/components/plugins/installed-plugins-card.tsx`
- Modify: `apps/server/web/src/routes/settings_.plugins.tsx`
- Test: `apps/server/web/src/components/plugins/__tests__/installed-plugins-card.test.tsx`

**Interfaces:**
- Consumes: `useUpdatePlugin`, `PluginUpdateRow`.
- Produces: `InstalledPluginsCard` props gain `updates: PluginUpdateRow[]`, `onCheck: () => void`, `checking: boolean`, `checkErrors: string[]`.

- [ ] **Step 1: Write the failing tests**

Change the test helper's signature to `renderCard(plugins, canManage = true, updates: PluginUpdateRow[] = [], extra: { checkErrors?: string[] } = {})`, passing `updates` and `extra.checkErrors ?? []` to the card. Add:

```tsx
it("shows the version pair and the update action on an npm row", () => {
  renderCard([row({ id: "third", name: "Third", source: "npm", version: "1.0.0" })], true, [
    { id: "third", name: "Third", from: "1.0.0", to: "1.1.0" },
  ]);
  expect(screen.getByText("v1.0.0 → v1.1.0")).toBeDefined();
  expect(screen.getByRole("button", { name: "Update to 1.1.0" })).toBeDefined();
});

it("confirms before installing, then POSTs the update", async () => {
  const calls = mockFetch({ "POST /api/plugins/third/update": () => json({}) });
  renderCard([...], true, [{ id: "third", name: "Third", from: "1.0.0", to: "1.1.0" }]);
  fireEvent.click(screen.getByRole("button", { name: "Update to 1.1.0" }));
  expect(screen.getByText("Update this plugin?")).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Update" }));
  await waitFor(() => expect(calls).toContain("POST /api/plugins/third/update"));
});

it("updates all offers one at a time and keeps a failure on its row", async () => {
  // two offers, first POST 409, second 200
  // assert both POSTs happened in offer order and the first row carries the message
});

it("renders check errors and the shadowed copy as detail lines", () => {
  renderCard([...], true, [], { checkErrors: ["Could not check Third: registry answered 503"] });
  expect(screen.getByText("Could not check Third: registry answered 503")).toBeDefined();
  // row.shadowed -> a line naming its version and source
});

it("a reader gets no update controls", () => {
  renderCard([row({ id: "third", name: "Third", source: "npm", version: "1.0.0" })], false, [offer]);
  expect(screen.queryByRole("button", { name: /update/i })).toBeNull();
  expect(screen.queryByRole("button", { name: "Check for updates" })).toBeNull();
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test apps/server/web/src/components/plugins/__tests__/installed-plugins-card.test.tsx`
Expected: FAIL - unknown props / no update controls.

- [ ] **Step 3: Implement the dialog**

`update-plugins-dialog.tsx` takes `{ open, onOpenChange, targets, onConfirm }` where `targets: { name: string; from: string; to: string }[]`. Title: `targets.length === 1 ? "Update this plugin?" : "Update ${targets.length} plugins?"`. Body: one line per target (`Name` / `v1.0.0 → v1.1.0`), then "This replaces the plugin's code on this server. Updated plugins may need a server restart before their new code runs." Footer: Cancel / `targets.length === 1 ? "Update" : "Update all"`.

- [ ] **Step 4: Implement the card**

- Build `offers = new Map(updates.map((u) => [u.id, u]))`.
- Version detail line: when an offer exists, `${p.version} → ${offer.to}` with `v` prefixes; otherwise the existing line.
- Source badge: `p.source === "npm" ? "npm" : p.source === "unrecorded" ? "no record" : "this build"`, falling back to the old `builtIn` rule when `source` is absent (older server).
- Actions cell: when `canManage && offer`, an `Update to ${offer.to}` ghost button before Uninstall. Disable every update control while the mutation is pending.
- Header: a flex row with `Installed` on the left and, on the right, `Check for updates` (disabled with a disabledReason while checking or pending) and, when `offers.size > 1`, `Update all (${offers.size})`.
- Shadowed line: `Installed copy v${shadowed.version} (${shadowed.source === "npm" ? "npm" : "this build"}) is not in use${shadowed.error ? `: ${shadowed.error}` : "; the bundled copy is newer"}.`
- Check error lines: render every entry of `checkErrors` as its own muted detail line.
- Dialog: state holds the targets being confirmed; confirm runs `applyUpdates(ids)`.
- `applyUpdates` loops sequentially with `await update.mutateAsync(id)`, catching per id into `updateErrors`, and sets `updateDialog` to null before starting.
- Reuse the existing `rowErrors` pattern for update errors (or a second map if the messages must not mix).

- [ ] **Step 5: Wire the page**

In `settings_.plugins.tsx`: `const updates = usePluginUpdates(canManage); const check = useCheckPluginUpdates();`. Pass `updates.data?.updates ?? []`, `onCheck={check.check}`, `checking={check.pending}`, and `checkErrors={[...(check.error ? [check.error] : []), ...(updates.data?.errors ?? []).map((e) => `Could not check ${e.name}: ${e.message}`)]}`. Keep the existing non-admin branch.

- [ ] **Step 6: Run the card and route tests**

Run: `bun test apps/server/web/src/components/plugins/__tests__/installed-plugins-card.test.tsx apps/server/web/src/routes/__tests__/settings-plugins.test.tsx`
Expected: PASS; update the route test's fetch mocks for the new GET if it asserts request counts.

- [ ] **Step 7: Commit**

```bash
git add apps/server/web/src/components/plugins/update-plugins-dialog.tsx apps/server/web/src/components/plugins/installed-plugins-card.tsx apps/server/web/src/components/plugins/__tests__/installed-plugins-card.test.tsx apps/server/web/src/routes/settings_.plugins.tsx apps/server/web/src/routes/__tests__/settings-plugins.test.tsx
git commit -m "feat(web): add plugin update controls and confirmation"
```

---

### Task 10: Restart offer, page wiring and release metadata

**Review:** per-task - destructive

**Files:**
- Create: `apps/server/web/src/components/plugins/plugin-restart-offer.tsx`
- Modify: `apps/server/web/src/routes/settings_.plugins.tsx`
- Test: `apps/server/web/src/components/plugins/__tests__/plugin-restart-offer.test.tsx`
- Create: `.changeset/plugin-updates-and-builtin-precedence.md`

**Interfaces:**
- Consumes: `ServerRestart` (`use-server-restart`), `ServerDeployment`, `RestartDialog`.
- Produces: `PluginRestartOffer({ restartRequired, deployment, restart })`.

- [ ] **Step 1: Write the failing tests**

Use `deploymentView()` and the exported `idleRestart` from
`@/components/__tests__/helpers/deployment-view`.

```tsx
const base = deploymentView();
const killsView = { ...base, service: { ...base.service, paneSafety: "kills" as const } };

it("offers the restart while a plugin reports restartRequired", () => {
  render(<PluginRestartOffer restartRequired deployment={base} restart={idleRestart} />);
  expect(screen.getByRole("button", { name: "Restart server" })).toBeDefined();
});

it("keeps the pane-safety warning and passes force", () => {
  const forced: { force?: boolean }[] = [];
  const restart = { outcome: "idle" as const, error: null, restart: async (body: { force?: boolean }) => { forced.push(body); } };
  render(<PluginRestartOffer restartRequired deployment={killsView} restart={restart} />);
  fireEvent.click(screen.getByRole("button", { name: "Restart server" }));
  expect(screen.getByText(/close every running subshell/)).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Restart anyway" }));
  expect(forced).toEqual([{ force: true }]);
});

it("names the command when this server cannot restart itself", () => {
  const view = deploymentView({}, { restart: { available: false, reason: "not supervised" } });
  render(<PluginRestartOffer restartRequired deployment={view} restart={idleRestart} />);
  expect(screen.getByText(/subshell-server service restart/)).toBeDefined();
  expect(screen.queryByRole("button", { name: "Restart server" })).toBeNull();
});

it("renders the waiting and timeout states", () => {
  // waiting -> status line "Restarting…"
  // timeout -> destructive line naming the service check
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test apps/server/web/src/components/plugins/__tests__/plugin-restart-offer.test.tsx`
Expected: FAIL - module not found.

- [ ] **Step 3: Implement the component**

- Return null when `restartRequired` is false.
- `restart.outcome === "waiting"` → a `role="status"` line with a spinner: "Restarting… waiting for the server to come back."
- `restart.error` → destructive line; `restart.outcome === "timeout"` → destructive line telling the reader to check the service on that machine.
- Otherwise:
  - If `deployment?.restart.available === true`: sentence "Updated plugins take effect after the server restarts." and a button "Restart server" opening `RestartDialog`; confirm calls `restart.restart({ force })`.
  - If `deployment?.restart.available === false`: sentence with the reason and `subshell-server service restart`.
  - If `deployment` is undefined (still loading): render nothing; the update result is already visible in the rows.
- No "Back." message; the reappearing rows are the confirmation.

- [ ] **Step 4: Wire the page**

In `settings_.plugins.tsx`, for admins only: `useAdminStatus(isAdmin)` (baseline for `useServerRestart`), `useServerDeployment(isAdmin, 60_000)`, `const restart = useServerRestart()`. Compute `restartRequired = installed.some((p) => p.restartRequired)`. Render `<PluginRestartOffer ... />` above the Installed card. On `restart.outcome === "back"` (an effect), invalidate `INSTANCE_PLUGINS_QUERY_KEY` and `PLUGIN_UPDATES_QUERY_KEY` and refetch.

- [ ] **Step 5: Run the page and component tests**

Run: `bun test apps/server/web/src/components/plugins/__tests__/plugin-restart-offer.test.tsx apps/server/web/src/routes/__tests__/settings-plugins.test.tsx`
Expected: PASS.

- [ ] **Step 6: Add the changeset**

Create `.changeset/plugin-updates-and-builtin-precedence.md`:

```md
---
"@internal/server": minor
---

Plugins installed from npm can be updated from Settings → Plugins, one at a time or all at once, with a server restart offered after the admin is done. Built-in plugin ids now resolve to the newer of the bundled and installed copies, gated by the plugin's `subshell.apiVersion`; a server upgrade no longer downgrades a newer installed copy.
```

- [ ] **Step 7: Run affected verification**

Run: `bun run test:changed -- --plan`
Expected: the plan lists the touched packages.

Then run the affected package tests once:
`env -u SHELLOPTS -u BASHOPTS bunx turbo run test --filter=@internal/pane-runtime --filter=@internal/server --filter=@internal/server-web`

Then: `bun run verify:changed`
Expected: build, type-check and lint pass for the affected packages.

- [ ] **Step 8: Commit**

```bash
git add apps/server/web/src/components/plugins/plugin-restart-offer.tsx apps/server/web/src/components/plugins/__tests__/plugin-restart-offer.test.tsx apps/server/web/src/routes/settings_.plugins.tsx apps/server/web/src/routes/__tests__/settings-plugins.test.tsx .changeset/plugin-updates-and-builtin-precedence.md
git commit -m "feat(web): offer a restart after plugin updates"
```

---

## Self-Review

- **Spec coverage:** D1/D2 (Tasks 1-3), D3/D4 (Task 2), D5 (Task 3), D6 (Tasks 4-5), D7 (Task 6), D8 (Tasks 7, 9-10), D9 (Tasks 7, 10), security/docs/changeset (Tasks 7, 10). The non-goals are enforced by omission: no boot npm check, no auto-update, no node change, no sidebar notice.
- **Type consistency:** `source` is the same three-value union in the wire, the API schema and the SPA; `shadowed` carries `version`, `source` and optional `error` everywhere; `PluginUpdateRow.to` is a string in the view after the server filters nulls; `checkedAt` is a number.
- **Review focus:** each of the five lines has a test in Tasks 3, 4, 6, 7 and 10 respectively.
- **Proportion:** the plan carries signatures, test names and exact values; implementation bodies are left to the builder except where the algorithm is a decision (effective report selection, refresh condition).
