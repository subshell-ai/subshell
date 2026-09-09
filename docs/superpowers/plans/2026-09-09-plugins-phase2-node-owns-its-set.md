# Plugins Phase 2: The Node Owns Its Plugin Set

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the answer to "which harnesses does this machine offer?" from a table on the control plane to a directory on the node.

**Architecture:** `<dataDir>/plugins/<id>/` becomes the declaration: what is installed there is what the node offers, and there is no enable flag on either side. Built-ins are materialised into it from copies embedded in the binary, so a node needs no network to install one. The node reports its set with the inventory it already sends, the server mirrors it in `nodes.inventory_json`, and `node_harnesses` is dropped. A server-side change is a signed command to a live node; offline is refused, not queued.

**Tech Stack:** Bun, TypeScript, ElysiaJS + TypeBox, Kysely/SQLite, React 19, `bun test`, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-09-plugin-architecture-design.md` (§6, §12, §15 phase 2)

## A correction to the spec's phasing, made before starting

The spec puts the plugins directory and the dropping of `node_harnesses` in
phase 2, and `plugin install` in phase 3. **Those cannot be in that order.**
Dropping `node_harnesses` removes the only way to stop a harness being offered
on a node, and until something can install and uninstall, nothing replaces it.
The spec's own migration step (§12, "seed the built-ins the retired tables said
it had enabled") is itself an install, so phase 2 already depended on phase 3.

The split that works, and the one this plan takes:

- **Phase 2 (here): install and uninstall from the EMBEDDED copies.** No
  network, no registry, no tarballs. This is self-contained, and it is what
  makes dropping `node_harnesses` safe.
- **Phase 3: the npm registry.** Fetching a packument, verifying the tarball
  against its `integrity` hash, extracting it, third-party plugins, and the
  publishing pipeline. Purely additive on top of phase 2.

`docs/.../2026-09-09-plugin-architecture-design.md` §15 is updated by Task 9 to
say this, so the spec and the plans do not disagree.

## Global Constraints

- **Empty means "offers nothing", not "offers everything".** This inverts
  `allowed-dirs`, and the difference is deliberate: an allowlist is a
  restriction an owner opts into, while a plugin set is a positive statement of
  what is installed. A node with no plugins directory has nothing to launch,
  which is why the seeding step in Task 8 is not optional.
- **The node ENFORCES.** A `launch` naming a plugin the node does not have is
  refused node-side, not merely filtered by the server. Signing proves who sent
  a launch, never whether the target supports it.
- **No desired-state store, and no reconcile-on-`ready`.** This is the opposite
  of `allowed-dirs`, on purpose: there the control plane owns a security
  control, so a node running stale rules must be corrected; here the node owns
  the setting, so there is nothing to correct. An offline node's toggle is
  refused, not queued.
- **`NODE_PROTOCOL_VERSION` goes 5 → 6.** The two gates are matched EXACTLY, in
  both directions, so agent and server ship together and there is no
  compatibility window to design.
- **A migration is registered in BOTH `db/migrations/` and the provider map in
  `db/migrate.ts`**, with the file name matching the map key.
- **Every Elysia `t` schema property carries a `description`.**
- **No em dashes** in copy, and **no dynamic imports** outside the one named
  exception in `pane-runtime`.
- Verification after every task: `bun run verify-types` (with `--force`, since
  a cached pass is not a pass), `bun run lint:check`, `bun run test`. Anything
  touching e2e-visible copy or locators also needs `bun run test:e2e`, which
  `bun run test` does NOT cover: that gap cost a red main in phase 1.
- **A known-failing test:** the zero-byte upload case in `@internal/server`
  fails on bun 1.4.2 and passes on the 1.4.0 CI pins. Not a regression.

---

### Task 1: Embedded built-ins, as bytes the binary carries

Installing a built-in must work with no network, so the binary carries each
plugin's files. A generated module, because `bun build --compile` bundles what
it can see and a directory read at runtime is not that.

**Files:**
- Create: `packages/pane-runtime/src/scripts/embed-plugins.ts`
- Create: `packages/pane-runtime/src/generated/embedded-plugins.ts` (tracked stub)
- Modify: `packages/pane-runtime/package.json` (a `build` step that regenerates)
- Test: `packages/pane-runtime/src/__tests__/embedded-plugins.test.ts`

**Interfaces:**
- Produces: `EMBEDDED_PLUGINS: Record<string, EmbeddedPlugin>` where
  `EmbeddedPlugin = { manifest: SubshellManifest; files: Record<string, string> }`,
  keyed by plugin id; `files` maps a relative path to its content.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "bun:test";
import { parseManifest } from "@subshell-ai/plugin-api";
import { EMBEDDED_PLUGINS } from "../generated/embedded-plugins.js";

describe("embedded plugins", () => {
  it("carries all five built-ins", () => {
    expect(Object.keys(EMBEDDED_PLUGINS).sort()).toEqual([
      "claude-code", "codex", "hermes", "opencode", "pi",
    ]);
  });

  it("carries a package.json and an entry file for each", () => {
    for (const [id, plugin] of Object.entries(EMBEDDED_PLUGINS)) {
      expect([id, "package.json" in plugin.files]).toEqual([id, true]);
      expect([id, plugin.manifest.entry in plugin.files]).toEqual([id, true]);
    }
  });

  it("every embedded package.json parses as the manifest beside it", () => {
    // The two must agree or an install writes files describing a different
    // plugin from the one the registry thinks it wrote.
    for (const [id, plugin] of Object.entries(EMBEDDED_PLUGINS)) {
      const parsed = parseManifest(JSON.parse(plugin.files["package.json"] as string));
      expect([id, "error" in parsed]).toEqual([id, false]);
      if ("error" in parsed) continue;
      expect(parsed).toEqual(plugin.manifest);
    }
  });

  it("the entry file is a real module, not an empty placeholder", () => {
    for (const [id, plugin] of Object.entries(EMBEDDED_PLUGINS)) {
      expect([id, (plugin.files[plugin.manifest.entry] ?? "").length > 100]).toEqual([id, true]);
    }
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd packages/pane-runtime && bun test src/__tests__/embedded-plugins.test.ts`
Expected: FAIL, the stub exports an empty record.

- [ ] **Step 3: Write the tracked stub**

`src/generated/embedded-plugins.ts` exports `EMBEDDED_PLUGINS = {}` with a
docstring saying it is generated and that a fresh clone legitimately has it
empty until `build` runs. This is the same trick `apps/server/api`'s
`embedded-web.ts` uses, and for the same reason: the import must be legal
before the generator has run.

- [ ] **Step 4: Write the generator**

`scripts/embed-plugins.ts` reads each `packages/plugins/*/package.json` plus
the files its `entry` needs (the built `dist/`), and writes the module. It runs
as part of `build`, after the plugin packages build, which turbo already orders
through `dependsOn: ["^build"]`.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `bunx turbo build --filter=@internal/pane-runtime --force && cd packages/pane-runtime && bun test src/__tests__/embedded-plugins.test.ts`
Expected: PASS, four cases.

- [ ] **Step 6: Keep generated bytes out of commits**

Add `src/generated/embedded-plugins.ts` to the package's `.gitignore`-equivalent
handling exactly as `apps/server/api` does: the STUB is tracked, the generated
form is never committed. Confirm with `git status` after a build that the file
shows as modified and then restore it before committing.

- [ ] **Step 7: Verify and commit**

```bash
bun run verify-types && bun run lint:check && bun run test
git add packages/pane-runtime
git commit -m "feat(pane-runtime): embed the built-in plugins in the binary"
```

---

### Task 2: The plugins directory, and install/uninstall from embedded copies

The node's declaration. One directory per installed plugin, so a built-in and a
third-party plugin are identical on disk and share one loader and one uninstall.

**Files:**
- Create: `apps/node/agent/src/plugins-dir.ts`
- Test: `apps/node/agent/src/__tests__/plugins-dir.test.ts`

**Interfaces:**
- Consumes: `EMBEDDED_PLUGINS` from Task 1; `createInProcessRuntime` from `@internal/pane-runtime`.
- Produces: `pluginsDir(dataDir): string`; `listInstalled(dataDir): Promise<InstalledPlugin[]>`;
  `installEmbedded(dataDir, id): Promise<InstalledPlugin>`; `uninstallPlugin(dataDir, id): Promise<boolean>`;
  `refreshStaleBuiltIns(dataDir): Promise<string[]>`.
  `InstalledPlugin = { id: string; manifest: SubshellManifest; version: string; broken?: string }`.

- [ ] **Step 1: Write the failing test**

Cover, each against a temp data dir:

```typescript
it("an absent plugins directory lists nothing, and does not create it", async () => {
  // Empty means "offers nothing". A node that has never installed anything
  // launches nothing, which is what makes the seeding step load-bearing.
  const dir = tempDataDir();
  expect(await listInstalled(dir)).toEqual([]);
  expect(existsSync(pluginsDir(dir))).toBe(false);
});

it("installs a built-in from the embedded copy, with no network", async () => {
  const dir = tempDataDir();
  const installed = await installEmbedded(dir, "claude-code");
  expect(installed.manifest.id).toBe("claude-code");
  expect((await listInstalled(dir)).map((p) => p.id)).toEqual(["claude-code"]);
});

it("installing twice is idempotent, not an error", async () => { /* … */ });

it("uninstall removes it and answers whether it was there", async () => {
  const dir = tempDataDir();
  await installEmbedded(dir, "codex");
  expect(await uninstallPlugin(dir, "codex")).toBe(true);
  expect(await uninstallPlugin(dir, "codex")).toBe(false);
  expect(await listInstalled(dir)).toEqual([]);
});

it("refuses an id that is not a safe path segment", async () => {
  // The id becomes a directory name; `..` must never reach the filesystem.
  await expect(installEmbedded(tempDataDir(), "../escape")).rejects.toThrow();
});

it("refuses an unknown built-in by name", async () => { /* names the id */ });

it("a directory with a corrupt package.json lists as broken, not missing", async () => {
  // Reported so the node page can say why, rather than the plugin silently
  // vanishing from every list.
  const dir = tempDataDir();
  await installEmbedded(dir, "pi");
  await Bun.write(join(pluginsDir(dir), "pi", "package.json"), "{not json");
  const [entry] = await listInstalled(dir);
  expect(entry?.id).toBe("pi");
  expect(entry?.broken).toBeTruthy();
});

it("refreshes an installed built-in the binary has a newer copy of", async () => {
  // The binary and its built-ins ship together, so a stale on-disk copy of a
  // built-in is never intentional: it means the agent was upgraded.
  const dir = tempDataDir();
  await installEmbedded(dir, "hermes");
  await writeVersion(dir, "hermes", "0.0.1"); // pretend an older agent wrote it
  expect(await refreshStaleBuiltIns(dir)).toEqual(["hermes"]);
  expect((await listInstalled(dir))[0]?.version).not.toBe("0.0.1");
});

it("leaves a third-party plugin alone when refreshing", async () => { /* … */ });
```

- [ ] **Step 2: Run and confirm it fails**

Run: `cd apps/node/agent && bun test src/__tests__/plugins-dir.test.ts`
Expected: FAIL, cannot resolve `../plugins-dir.js`.

- [ ] **Step 3: Implement**

Writes are temp-directory + `rename()`, the same atomic-swap discipline
`publishArtifacts` and `allowed-dirs` use, so a killed install never leaves a
half-written plugin that the loader would then report as broken. Files are
0600 and the directory 0700, matching the rest of the agent's data dir.

- [ ] **Step 4: Run the tests and confirm they pass**

Expected: PASS, nine cases.

- [ ] **Step 5: Verify and commit**

```bash
bun run verify-types && bun run lint:check && bun run test
git add apps/node/agent
git commit -m "feat(node): the plugins directory is the node's declaration"
```

---

### Task 3: The node reports its plugin set

The inventory event already carries harness detection. It grows the plugin
descriptors the server needs so that the control plane holds no plugin code for
a machine it does not run on.

**Files:**
- Modify: `packages/subshell-protocol/src/node-frames.ts` (the `inventory` event; `NODE_PROTOCOL_VERSION` 5 → 6)
- Modify: `apps/node/agent/src/inventory.ts`
- Test: `packages/subshell-protocol/src/__tests__/node-frames.test.ts`
- Test: `apps/node/agent/src/__tests__/inventory.test.ts`

**Interfaces:**
- Produces: the `inventory` event gains `plugins: PluginReport[]`, where a report carries
  `id`, `name`, `type`, `version`, `capabilities`, `profileSettings`, `suggestedEnv`,
  `suggestedFlags`, `mcpSetup`, `exitStatuses`, plus the detection fields already there,
  and `broken?: string`.

- [ ] **Step 1: Write the failing tests**

The protocol test round-trips a v6 inventory event through the validator and
rejects a malformed `plugins` array. The agent test asserts the event carries
one report per installed plugin, that a broken plugin still appears WITH its
error, and that a node with nothing installed reports `plugins: []`.

- [ ] **Step 2: Run and confirm they fail**

- [ ] **Step 3: Bump the protocol and widen the event**

`NODE_PROTOCOL_VERSION = 6`. The reason this is a bump and phase 0's additions
were not: an older agent cannot serve the commands Task 5 adds, and the gates
match exactly in both directions.

- [ ] **Step 4: Build the report on the node**

`buildInventoryEvent` reads `listInstalled`, loads each plugin through the
runtime, and asks it for its descriptor. Keep the existing 10-second memo: it
already coalesces the three beats that land on every connection.

- [ ] **Step 5: Run the tests, verify, commit**

```bash
bun run verify-types && bun run lint:check && bun run test
git add packages/subshell-protocol apps/node/agent
git commit -m "feat(protocol): nodes report their plugin set (v6)"
```

---

### Task 4: The node enforces its own set on launch

Signing proves who sent a launch, never whether the target supports it.

**Files:**
- Modify: `apps/node/agent/src/commands/launch.ts`
- Test: `apps/node/agent/src/__tests__/commands-launch.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
it("refuses a launch for a plugin this node does not have installed", async () => {
  // The control plane filters too, but a signature says who sent the command,
  // not whether this machine can serve it.
  const result = await execLaunch(ctx, { ...LAUNCH, harnessId: "not-installed" });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toContain("not-installed");
});

it("refuses a launch for a plugin that is installed but broken", async () => { /* … */ });
```

- [ ] **Step 2: Run and confirm it fails** (today the launch proceeds)

- [ ] **Step 3: Implement**, resolving the plugin through the node's own set

- [ ] **Step 4: Run, verify, commit**

---

### Task 5: Protocol commands, and the server route that sends them

**Files:**
- Modify: `packages/subshell-protocol/src/node-frames.ts` (`plugin_install`, `plugin_uninstall`)
- Modify: `apps/node/agent/src/commands/{index,basics}.ts`
- Create: `apps/server/api/src/api/nodes/set-node-plugin.route.ts`
- Delete: `apps/server/api/src/api/nodes/patch-node-harness.route.ts`
- Test: agent command tests; a route test

**Interfaces:**
- Produces: `{ type: "plugin_install"; id: string }` and `{ type: "plugin_uninstall"; id: string }`;
  `POST /api/nodes/:id/plugins` and `DELETE /api/nodes/:id/plugins/:pluginId`.

- [ ] **Step 1: Write the failing route tests**

Cover: a non-manager is refused (`canManage`, owner-only, NOT
`nodeCanConfigure`. Any node share lets a grantee launch there, so an `edit`
grantee who could install a plugin would face no restriction at all, the same
reasoning the directory allowlist uses); an OFFLINE node is refused with a
message saying so rather than queued; a successful install answers the node's
fresh report; `local` writes directly rather than sending a command.

- [ ] **Step 2: Run and confirm they fail**

- [ ] **Step 3: Add the commands to the protocol and the agent's dispatch**

- [ ] **Step 4: Write the route**, sending through `sendCommand` and persisting the answer

- [ ] **Step 5: Delete `patch-node-harness.route.ts`** and its registration

- [ ] **Step 6: Run, verify, commit**

---

### Task 6: The server mirrors, and stops deciding

`effectiveHarnessStates` merges an enable table with an inventory. The table is
going, so what remains is the node's own report.

**Files:**
- Modify: `apps/server/api/src/services/nodes/inventory.ts`
- Modify: `apps/server/api/src/api/harness-utils.ts`
- Modify: `apps/server/api/src/api/nodes/node-view.ts`
- Test: the existing suites for each

- [ ] **Step 1: Write the failing tests**: a node's view lists what it reported, with no enable flag
- [ ] **Step 2: Run and confirm they fail**
- [ ] **Step 3: Implement**, deleting the enable merge
- [ ] **Step 4: Run, verify, commit**

---

### Task 7: Drop `node_harnesses`

**Files:**
- Create: `apps/server/api/src/db/migrations/0023-drop-node-harnesses.ts`
- Modify: `apps/server/api/src/db/migrate.ts` (the provider map)
- Delete: `apps/server/api/src/db/repositories/node-harnesses.repository.ts`, its type, its registrations

- [ ] **Step 1: Write the migration test**: the table is gone, and the migration is idempotent
- [ ] **Step 2: Run and confirm it fails**
- [ ] **Step 3: Write the migration and register it in BOTH places**
- [ ] **Step 4: Delete the repository and every reference**
- [ ] **Step 5: Run, verify, commit**

---

### Task 8: The one-way seeding step

Without this, every existing instance upgrades into a node that offers nothing.

**Files:**
- Create: `apps/node/agent/src/plugins-seed.ts`
- Modify: `apps/node/agent/src/daemon.ts` (call it once at start)
- Modify: `apps/server/api/src/index.ts` (the same for `local`)
- Test: `apps/node/agent/src/__tests__/plugins-seed.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
it("seeds every built-in when the plugins directory is absent", async () => { /* … */ });

it("does NOTHING when the directory already exists, even if empty", async () => {
  // An empty directory is a user who uninstalled everything. Re-seeding would
  // undo that on every restart, which is why the check is the DIRECTORY and
  // not its contents.
  const dir = tempDataDir();
  mkdirSync(pluginsDir(dir), { recursive: true });
  await seedBuiltIns(dir);
  expect(await listInstalled(dir)).toEqual([]);
});

it("is idempotent across repeated boots", async () => { /* … */ });
```

- [ ] **Step 2: Run and confirm it fails**
- [ ] **Step 3: Implement**, and call it before the first inventory is built
- [ ] **Step 4: Run, verify, commit**

---

### Task 9: UI, docs, spec correction, changeset

**Files:**
- Modify: `apps/server/web/src/components/nodes/node-harness-card.tsx` (no enable switch; install/uninstall for a manager; offline is read-only and says why)
- Modify: `apps/server/web/src/hooks/use-harnesses.ts`
- Modify: `docs/superpowers/specs/2026-09-09-plugin-architecture-design.md` §15 (the phasing correction above)
- Modify: `AGENTS.md`, `docs/architecture.md`, `docs/security.md`
- Create: `.changeset/<generated>.md`

- [ ] **Step 1: Write the failing component tests**: the card offers install/uninstall, is read-only offline, and shows a broken plugin's error
- [ ] **Step 2: Run and confirm they fail**
- [ ] **Step 3: Implement the card**
- [ ] **Step 4: Update the spec's §15 so it and this plan agree**
- [ ] **Step 5: Update AGENTS.md, architecture.md and security.md**
- [ ] **Step 6: Add the changeset** (minor for server and node: a node's plugin set is now its own)
- [ ] **Step 7: Full verification, INCLUDING e2e**

```bash
bun run verify-types && bun run lint:check && bun run test
bun run lint:licenses && bun run lint:packages && bun run lint:lockfile
bun run test:e2e
```

`test:e2e` is not optional here: this task changes node-page copy, and e2e
locators are outside `bun run test`. That gap turned main red in phase 1.

- [ ] **Step 8: Commit, then run the code review before reporting the phase complete**
