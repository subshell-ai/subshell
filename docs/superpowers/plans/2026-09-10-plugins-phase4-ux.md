# Plugin UX (Phase 4) Implementation Plan

> **SUPERSEDED (2026-09-10) by the plan for `2026-09-10-plugins-on-the-control-plane-design.md`.** Do not execute this.
> Two of its findings still matter and must be carried into whatever replaces
> it: `GET /api/profiles/harnesses/:id/schema` serves from server-side plugin
> code, and the profile CREATE route refuses any harness `getHarness` does not
> know while checking usability against `local` regardless of the profile's
> node.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the plugin machinery built in phases 1 to 3 usable from a screen: a first-run wizard that asks where subshells will run, a node Plugins card that can install a third-party package by name and act on available updates, and the same install/uninstall surface inside Subshell Client.

**Architecture:** One new READ-ONLY protocol command (`plugin_check_updates`, protocol 2 -> 3) whose result is a discriminated union covering every installed plugin. Applying an update is not a new command: it reuses `plugin_install` with the resolved version pinned into the spec, which is what the agent's own `plugin update` verb already does. Plugin identity (name, type, description, icon) stops being dropped at the server view boundary, so third-party plugins render by name. The anonymous first-run write routes are deleted rather than narrowed, and the catalog read moves out of `/api/setup`.

**Tech Stack:** Bun 1.4.x, TypeScript strict, ElysiaJS + TypeBox, React 19 + TanStack Query/Router + Tailwind, Tauri v2 + Rust, `bun test`, Playwright, biome.

**Spec:** `docs/superpowers/specs/2026-09-10-plugins-phase4-ux-design.md` (read it before Task 1; §2.1 through §2.8 are the decisions this plan implements). Parent: `docs/superpowers/specs/2026-09-09-plugin-architecture-design.md` §10, §13. Predecessor: `docs/superpowers/specs/2026-09-09-plugins-phase3-registry-design.md`, whose §8 lists what phase 3 deliberately left for this phase.

## Global Constraints

Every task's requirements implicitly include all of these.

- **No new runtime dependencies**, anywhere. The agent is a compiled binary.
- **No `await import()`** outside `packages/pane-runtime/src/plugin-runtime.ts`. That is the repo's one sanctioned dynamic import (`.claude/rules/code-style.md`).
- **No em dashes in operator-facing strings**: CLI output, UI copy, error messages a person reads. Repo prose files and code comments follow their own file's existing convention.
- **TDD, red then green.** Write the failing test, run it, watch it fail for the stated reason, then implement. Every guard must be proven by reverting it and seeing a test fail.
- **Rebuild dists before trusting a downstream suite.** Workspace imports resolve through built output: `bunx turbo build --filter=@internal/subshell-protocol` after protocol changes, `--filter=@internal/pane-runtime` after pane-runtime changes, or `bunx turbo build` for everything. A stale dist produced false greens twice in phase 3.
- **Every Elysia `t` schema property carries a `description`** (`.claude/rules/code-style.md`).
- **Discriminated unions over loose strings**, and export a runtime array beside a type when something must iterate it.
- **JSDoc on exported functions and interface properties**, describing what is NOT obvious from the signature.
- **Verification before each commit:** `bunx turbo run verify-types --force`, `bun run lint:check`, and the touched package's `bun test`. The full `bun run test` before the final task.
- **Known sanctioned baseline failure:** `apps/server/api` "ZERO-BYTE upload" fails on bun 1.4.2. It is unrelated. Do not chase it. `@internal/server-web` prints `connect ECONNREFUSED 127.0.0.1:80` while passing.
- **Protocol census:** a new command must appear in the agent's endpoint/command coverage test in the SAME commit it appears in the parser.
- **Commit messages** end with the `Co-Authored-By:` trailer your harness specifies.
- **`version` on a harness row is the DRIVEN PROGRAM's version**, never the plugin package's. Do not blur them when adding update UI.

## Lane map and ordering

Tasks 1 to 3 are a chain and must land in order; everything else consumes them.

```
A (protocol/runtime/agent):  1 -> 2 -> 3
B (server):                  4, 5 independent of each other; 6 needs 1+3
C (web):                     7 needs 4,5,6;  8 needs 7;  9 needs 7
D (desktop):                 10 -> 11        (needs nothing from B/C)
E (docs+e2e+pass):           12 needs everything
```

---

### Task 1: Protocol 3 — the check command and its result union

**Files:**
- Modify: `packages/subshell-protocol/src/node-frames.ts`
- Test: `packages/subshell-protocol/src/__tests__/node-frames.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `NODE_PROTOCOL_VERSION = 3`; the command variant `{ type: "plugin_check_updates"; id?: string }`; the exported type `PluginUpdateWire`.

**Context:** `NODE_PROTOCOL_VERSION` is at line 39 and is currently `2`. The command union's plugin variants are around lines 230 to 262; the parser's cases are around lines 553 to 561. The gate is an exact match in both directions (`apps/server/api/src/services/nodes/node-ws-handler.ts:303`), so server and agents ship together and there is no compatibility shim to write.

**CRITICAL — use `type`, not `interface`.** `PluginUpdateWire` rides inside a command RESULT, which is typed as `JsonValue`. An `interface` has no implicit index signature and is not assignable to `JsonValue`. The file already says this above `SettingsFieldWire`; the same reasoning applies here.

- [ ] **Step 1: Write the failing tests**

Append to `packages/subshell-protocol/src/__tests__/node-frames.test.ts`, matching the file's existing describe/test style and leaving a blank line between tests:

```ts
describe("plugin_check_updates (protocol 3)", () => {
  test("the protocol version is 3", () => {
    expect(NODE_PROTOCOL_VERSION).toBe(3);
  });

  test("parses with no id, meaning every installed plugin", () => {
    expect(parseNodeCommandBody({ type: "plugin_check_updates" })).toEqual({ type: "plugin_check_updates" });
  });

  test("parses with an id, narrowing to one plugin", () => {
    expect(parseNodeCommandBody({ type: "plugin_check_updates", id: "pi" })).toEqual({
      type: "plugin_check_updates",
      id: "pi",
    });
  });

  test("refuses a non-string id rather than coercing it", () => {
    expect(parseNodeCommandBody({ type: "plugin_check_updates", id: 7 })).toBeNull();
  });

  test("refuses an empty id, which would silently mean 'all'", () => {
    expect(parseNodeCommandBody({ type: "plugin_check_updates", id: "" })).toBeNull();
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd packages/subshell-protocol && bun test src/__tests__/node-frames.test.ts`
Expected: FAIL. The version test fails with `expected 3, got 2`; the parse tests return `null` because the parser has no such case.

- [ ] **Step 3: Bump the version**

In `packages/subshell-protocol/src/node-frames.ts`, change `export const NODE_PROTOCOL_VERSION = 2;` to `3`, and update its doc comment so it records what the bump was for, in the voice of the surrounding comments (phase 3's entry is the model): protocol 3 adds `plugin_check_updates`, a read-only command, and nothing else changed.

- [ ] **Step 4: Add the result type**

Add near `PluginReportWire` (around line 313):

```ts
/**
 * One installed plugin's update status, as it travels.
 *
 * A row exists for EVERY installed plugin, which is the whole point of the
 * union. `resolvePluginUpdates` used to omit both embedded copies and checks
 * that threw, and a CLI could carry that in a warning line. In a card an
 * omitted row is indistinguishable from "no update available", so the node
 * classifies and the browser renders rather than inferring.
 *
 * A `type` alias rather than an `interface`: this rides inside a command
 * result typed as `JsonValue`, and an interface has no implicit index
 * signature, so it is not assignable to one.
 */
export type PluginUpdateWire =
  | {
      /** Plugin id, which is also its directory name on the node */
      id: string;
      /** Installed from a registry, so an update is a thing that can exist */
      kind: "registry";
      /** The npm package name recorded in the plugin's `install.json` */
      name: string;
      /** The version currently installed */
      from: string;
      /** The newer version, or null when the install is at or above `latest` */
      to: string | null;
    }
  | {
      /** Plugin id */
      id: string;
      /** No `install.json`, so it came from the agent's own build and is never upgraded from a registry behind its operator */
      kind: "embedded";
    }
  | {
      /** Plugin id */
      id: string;
      /** The check itself failed for this one plugin; the others still resolved */
      kind: "error";
      /** Why, in the registry client's own words (it names the URL it tried) */
      message: string;
    };
```

- [ ] **Step 5: Add the command variant**

Add to the command union, immediately after the `plugin_uninstall` variant:

```ts
  | {
      /**
       * Ask this node which of its installed plugins have a newer version.
       *
       * READ-ONLY. Applying an update is `plugin_install` with the resolved
       * version pinned into `spec`, so the bytes that land are the bytes the
       * operator was shown; a command meaning "go get latest" could install
       * something newer than what was on screen if the tag moved in between.
       *
       * The node uses ITS OWN configured registry, so a machine behind a
       * mirror is asked about the registry it can actually reach. Checking is
       * never part of an inventory report: it is network egress, and a node
       * with no route to a registry must still be able to report what it has.
       */
      type: "plugin_check_updates";
      /** One plugin id, or absent for every installed plugin */
      id?: string;
    }
```

- [ ] **Step 6: Add the parser case**

Beside the other plugin cases:

```ts
    case "plugin_check_updates": {
      if (value.id === undefined) return { type: "plugin_check_updates" };
      // Same reasoning as `plugin_install`'s spec: an empty string is not a
      // narrower request, it is a malformed one, and admitting it would make
      // "check this plugin" silently mean "check all of them".
      return isStr(value.id) && value.id !== "" ? { type: "plugin_check_updates", id: value.id } : null;
    }
```

- [ ] **Step 7: Run the tests and the whole protocol suite**

Run: `cd packages/subshell-protocol && bun test`
Expected: PASS, including the pre-existing tests. Any test asserting the version is 2 is now correctly failing and must be updated to 3 in this commit.

- [ ] **Step 8: Prove the empty-id guard**

Temporarily change the parser case to `return isStr(value.id) ? ... : null` (dropping `&& value.id !== ""`). Re-run: the empty-id test must fail. Restore the guard and re-run to green.

- [ ] **Step 9: Rebuild and commit**

```bash
bunx turbo build --filter=@internal/subshell-protocol
git add packages/subshell-protocol
git commit
```

Message: `feat(protocol): plugin_check_updates, and a row for every installed plugin (protocol 3)`. Body should say why the result is a union rather than a list of updates, and that applying reuses `plugin_install`.

---

### Task 2: pane-runtime classifies instead of omitting

**Files:**
- Modify: `packages/pane-runtime/src/plugins-dir.ts` (the `PluginUpdate` interface and `resolvePluginUpdates`, around lines 553 to 600)
- Modify: `apps/node/agent/src/plugin-cli.ts` (`pluginUpdate`, around lines 148 to 195)
- Test: `packages/pane-runtime/src/__tests__/` (the file holding the existing `resolvePluginUpdates` cases; find it with `grep -rl resolvePluginUpdates packages/pane-runtime/src/__tests__`)
- Test: `apps/node/agent/src/__tests__/cli-plugin.test.ts`

**Interfaces:**
- Consumes: `PluginUpdateWire` from Task 1.
- Produces: `resolvePluginUpdates(dataDir, opts) -> Promise<PluginUpdateWire[]>`, one row per installed plugin (subject to the `id` filter), never an omission.

**Context:** Today `resolvePluginUpdates` returns `PluginUpdate[]` and does three things this task changes: it `continue`s past a plugin with no `install.json`, it swallows a failed check into a `pluginLog().warn`, and it defines its own `PluginUpdate` interface. The interface is deleted; the protocol's `PluginUpdateWire` is the single definition, and pane-runtime already imports from `@internal/subshell-protocol` (it uses `semverLt`).

**This changes the `subshell plugin update --json` output shape**, which is a documented contract in `plugin-cli.ts`'s comment. That is intended and the comment must be rewritten. The repo has no users, so no compatibility path is needed.

- [ ] **Step 1: Write the failing tests**

In the pane-runtime test file that already exercises `resolvePluginUpdates` against the fake registry, add:

```ts
test("an embedded plugin gets a row saying so, rather than being omitted", async () => {
  // Seed an embedded plugin (no install.json) and nothing else.
  const rows = await resolvePluginUpdates(dataDir, { registryUrl });
  expect(rows).toContainEqual({ id: "pi", kind: "embedded" });
});

test("a plugin whose check throws gets an error row naming the reason", async () => {
  // Point at a registry that cannot answer, with ONE registry-installed plugin present.
  const rows = await resolvePluginUpdates(dataDir, { registryUrl: "http://127.0.0.1:1/dead" });
  const row = rows.find((r) => r.id === "e2e-demo");
  expect(row?.kind).toBe("error");
  if (row?.kind === "error") expect(row.message).toContain("127.0.0.1:1");
});

test("a registry install at the newest version reports to: null, not absence", async () => {
  const rows = await resolvePluginUpdates(dataDir, { registryUrl });
  expect(rows).toContainEqual({ id: "e2e-demo", kind: "registry", name: "e2e-demo", from: "1.0.0", to: null });
});
```

Adapt the seeding to whatever helpers that test file already uses (phase 3 built a fake registry fixture and a `makePluginTgz`; reuse them, do not invent new ones). Keep the existing "newer version is reported" test and update its expected shape to include `kind: "registry"`.

- [ ] **Step 2: Run them and watch them fail**

Run: `cd packages/pane-runtime && bun test`
Expected: FAIL. The embedded and error rows are absent from the array; the `to: null` row lacks `kind`.

- [ ] **Step 3: Replace the type and the resolver**

Delete the `PluginUpdate` interface. Import the wire type and rewrite the function:

```ts
import type { PluginUpdateWire } from "@internal/subshell-protocol";

/**
 * Every installed plugin's update status, one row each.
 *
 * Three kinds, because three things can be true and a caller must be able to
 * tell them apart: the plugin came from a registry and may have a newer
 * version (`registry`, with `to: null` meaning it is already at or above
 * `latest`, which also covers a pin deliberately ahead of it); it came from
 * this build and is never upgraded from a registry behind its operator
 * (`embedded`); or the check for that one plugin failed and the others still
 * resolved (`error`).
 *
 * This used to omit the last two. That was survivable for a CLI that could
 * warn in prose, and a lie in any UI, where a missing row reads as "nothing
 * to do".
 *
 * @param opts.id - narrow to one plugin; absent means all of them
 * @param opts.registryUrl - the mirror to ask; absent means the default registry
 */
export async function resolvePluginUpdates(
  dataDir: string,
  opts: { id?: string; registryUrl?: string } = {},
): Promise<PluginUpdateWire[]> {
  const out: PluginUpdateWire[] = [];
  for (const p of await listInstalled(dataDir)) {
    if (opts.id !== undefined && p.id !== opts.id) continue;
    const record = await readInstallRecord(dataDir, p.id);
    if (!record) {
      out.push({ id: p.id, kind: "embedded" });
      continue;
    }
    try {
      const latest = await resolvePackageVersion(record.name, undefined, opts.registryUrl ?? DEFAULT_REGISTRY_URL);
      out.push({
        id: p.id,
        kind: "registry",
        name: record.name,
        from: record.version,
        to: semverLt(record.version, latest.version) ? latest.version : null,
      });
    } catch (err) {
      // Reported as a row rather than a log line: "could not ask" must never
      // reach a reader as "up to date".
      out.push({ id: p.id, kind: "error", message: describe(err) });
    }
  }
  return out;
}
```

- [ ] **Step 4: Run the pane-runtime suite**

Run: `cd packages/pane-runtime && bun test`
Expected: PASS.

- [ ] **Step 5: Rebuild, then fix the CLI consumer**

```bash
bunx turbo build --filter=@internal/pane-runtime
```

`pluginUpdate` in `apps/node/agent/src/plugin-cli.ts` now gets richer data and gets SIMPLER. Its apply loop must skip non-registry rows, and its human-mode "skipped" enumeration no longer needs its own directory walk (the phase-3 fix round added that walk precisely because the resolver hid embedded plugins; the resolver now reports them):

```ts
  const updates = await resolvePluginUpdates(dataDir, { ...(id === undefined ? {} : { id }), registryUrl });
  let moved = 0;
  for (const u of updates) {
    if (u.kind !== "registry" || u.to === null) continue;
    // Same door as `install`, with the resolved pin: exact version, no
    // floating, so the bytes that land are the bytes the check named.
    await installPlugin(dataDir, { spec: `${u.name}@${u.to}`, registryUrl });
    moved += 1;
  }
```

and the human lines become one pass over `updates`:

```ts
  const lines = updates.map((u) => {
    if (u.kind === "embedded") return `${u.id} (embedded, not updated from the registry)`;
    if (u.kind === "error") return `${u.id} (could not check: ${u.message})`;
    return u.to === null ? `${u.id} ${u.from} (already at or above latest)` : `${u.id} ${u.from} -> ${u.to} (updated)`;
  });
```

Keep the existing empty-case line and the `RESTART_NOTE` behavior exactly as they are, keep `--json` printing only the array to stdout with the note on stderr, and rewrite the function's doc comment: its current text describes the two silences as load-bearing, which is now false. Broken plugins previously got no skip line; they now appear as whatever kind the resolver gives them, which is a deliberate improvement, so update the comment rather than filtering them back out.

- [ ] **Step 6: Update the CLI tests and run them**

`apps/node/agent/src/__tests__/cli-plugin.test.ts` pins the update verb's human and JSON output. Update the expectations to the new shapes, including a new case for an error row. Run: `cd apps/node/agent && bun test`
Expected: PASS, 451+ tests.

- [ ] **Step 7: Prove the classification**

Temporarily restore the `if (!record) continue;` line. Re-run the pane-runtime suite: the embedded-row test must fail. Restore and re-run to green.

- [ ] **Step 8: Commit**

```bash
git add packages/pane-runtime apps/node/agent
git commit
```

Message: `refactor(plugins): every installed plugin gets an update row, including the ones we could not check`.

---

### Task 3: The agent answers the check

**Files:**
- Modify: `apps/node/agent/src/commands/basics.ts` (beside `execPluginInstall`, around line 295)
- Modify: `apps/node/agent/src/commands/index.ts` (the dispatch switch, around line 84)
- Test: `apps/node/agent/src/commands/__tests__/` (the file covering `execPluginInstall`; find it with `grep -rl execPluginInstall apps/node/agent/src`)
- Test: the agent's command coverage/census test (find it with `grep -rl "plugin_uninstall" apps/node/agent/src/__tests__`)

**Interfaces:**
- Consumes: `plugin_check_updates` (Task 1), `resolvePluginUpdates` returning `PluginUpdateWire[]` (Task 2).
- Produces: `execPluginCheckUpdates(ctx, cmd) -> Promise<CommandResult>` answering `{ ok: true, data: { updates } }`.

**Context:** `execPluginInstall` is the model to follow, including how it reads `ctx.config.registryUrl` and how it returns `{ ok: false, error }` with the underlying message verbatim. Unlike install, this command changes nothing, so it must NOT push an inventory.

- [ ] **Step 1: Write the failing test**

In the command test file, beside the existing plugin command tests:

```ts
test("plugin_check_updates answers with a row per installed plugin and pushes no inventory", async () => {
  const ctx = makeCtx({ dataDir, registryUrl });
  const result = await execPluginCheckUpdates(ctx, { type: "plugin_check_updates" });
  expect(result.ok).toBe(true);
  const updates = (result as { ok: true; data: { updates: PluginUpdateWire[] } }).data.updates;
  expect(updates.some((u) => u.kind === "embedded")).toBe(true);
  // A read must not announce a change.
  expect(ctx.ws.sent).toHaveLength(0);
});

test("plugin_check_updates narrows to one plugin when given an id", async () => {
  const ctx = makeCtx({ dataDir, registryUrl });
  const result = await execPluginCheckUpdates(ctx, { type: "plugin_check_updates", id: "pi" });
  const updates = (result as { ok: true; data: { updates: PluginUpdateWire[] } }).data.updates;
  expect(updates.map((u) => u.id)).toEqual(["pi"]);
});
```

Adapt `makeCtx` and the ws-capture to whatever that file already uses.

- [ ] **Step 2: Run and watch it fail**

Run: `cd apps/node/agent && bun test src/commands/__tests__/`
Expected: FAIL, `execPluginCheckUpdates is not defined`.

- [ ] **Step 3: Implement the handler**

In `basics.ts`, after `execPluginUninstall`:

```ts
/**
 * `plugin_check_updates`: which installed plugins have a newer version.
 *
 * READ-ONLY, and deliberately so: it pushes no inventory and writes nothing.
 * Applying an update is a `plugin_install` carrying the resolved version, so
 * the control plane installs the version it showed its operator rather than
 * whatever `latest` means a moment later.
 *
 * The answer carries a row for EVERY installed plugin, embedded copies and
 * failed checks included, because the caller renders this and a missing row
 * reads as "nothing to do". The registry asked is this node's own configured
 * mirror, which is the reason the check lives here and not on the control
 * plane: the server's registry setting is a different value and could name an
 * update this machine cannot fetch.
 */
export async function execPluginCheckUpdates(
  ctx: CommandContext,
  cmd: Cmd<"plugin_check_updates">,
): Promise<CommandResult> {
  try {
    const updates = await resolvePluginUpdates(ctx.config.dataDir, {
      ...(cmd.id === undefined ? {} : { id: cmd.id }),
      registryUrl: ctx.config.registryUrl,
    });
    return { ok: true, data: { updates } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
```

Import `resolvePluginUpdates` from `@internal/pane-runtime` beside the existing `installPlugin` import.

- [ ] **Step 4: Wire the dispatch**

In `apps/node/agent/src/commands/index.ts`, beside `case "plugin_uninstall":`:

```ts
      case "plugin_check_updates":
        return await execPluginCheckUpdates(ctx, cmd);
```

- [ ] **Step 5: Update the census test**

The agent has a test asserting every command in the protocol union has a handler. Add `plugin_check_updates` to it in this same commit; if the test derives the list automatically it will already fail without the dispatch case, which is the point.

- [ ] **Step 6: Run the suite**

Run: `cd apps/node/agent && bun test`
Expected: PASS.

- [ ] **Step 7: Prove the no-inventory property**

Temporarily add `await pushInventory(ctx);` before the return. The "pushes no inventory" assertion must fail. Remove it and re-run to green.

- [ ] **Step 8: Commit**

```bash
git add apps/node/agent
git commit
```

Message: `feat(agent): answer plugin_check_updates without touching anything`.

---

### Task 4: Plugin identity reaches the browser

**Files:**
- Modify: `apps/server/api/src/services/nodes/inventory.ts` (`effectiveHarnessStates`, around lines 174 to 196, and the `EffectiveHarnessState` type it builds)
- Modify: `apps/server/api/src/api/nodes/node-view.ts` (`NodeHarnessViewSchema`, around lines 38 to 68)
- Test: `apps/server/api/src/api/nodes/__tests__/nodes-crud-route.test.ts` or the inventory test beside it

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `NodeHarnessViewSchema` rows carrying `name`, `type`, `description` and `icon`.

**Context:** `readNodePlugins(node)` already parses `nodes.plugins_json` into `PluginReportWire` values, which carry `name`, `type`, `description`, `icon` and `capabilities`. `effectiveHarnessStates` maps each report to a row keyed by `harnessId` and throws the rest away, which is why `node-harness-card.tsx:86` has to recover a name from the build's catalog and falls back to the raw id for anything third-party.

**Normalization is required, not optional.** These strings are written by a plugin author and rendered in an operator's browser and log lines. Find the existing label normalizer (`grep -rn "normalizeDeviceLabel" apps/server/api/src`) and apply the same treatment; if it is not exported from a shared place, put a small `normalizeLabel` beside it and use it from both.

- [ ] **Step 1: Write the failing test**

```ts
test("a node's harness rows carry the plugin's reported identity, not just its id", async () => {
  // Seed a node whose plugins_json holds a plugin this build does not carry.
  await seedNodePlugins(nodeId, [
    { id: "acme-thing", name: "Acme Thing", type: "agent-harness", version: "1.0.0", description: "does things", capabilities: [] },
  ]);
  const view = await getNodeView(nodeId);
  const row = view.harnesses.find((h) => h.harnessId === "acme-thing");
  expect(row?.name).toBe("Acme Thing");
  expect(row?.type).toBe("agent-harness");
  expect(row?.description).toBe("does things");
});

test("a reported name cannot carry control characters into the view", async () => {
  await seedNodePlugins(nodeId, [
    { id: "acme-thing", name: "Acme \nThing", type: "agent-harness", version: "1.0.0", description: "", capabilities: [] },
  ]);
  const view = await getNodeView(nodeId);
  expect(view.harnesses.find((h) => h.harnessId === "acme-thing")?.name).toBe("Acme Thing");
});
```

Adapt the seeding helper to what the test file already uses for `plugins_json`.

- [ ] **Step 2: Run and watch it fail**

Run: `cd apps/server/api && bun test src/api/nodes/__tests__/`
Expected: FAIL, `row.name` is `undefined`.

- [ ] **Step 3: Carry the fields through the merge**

In `effectiveHarnessStates`, extend the built state:

```ts
    const state: EffectiveHarnessState = {
      harnessId: report.id,
      installed: entry?.installed === true,
      // Identity comes from the NODE's own report, which is what lets a
      // plugin this build never heard of render by name. The catalog stays
      // what it is: the list of what this build can install offline.
      name: normalizeLabel(report.name) || report.id,
      type: report.type,
      description: normalizeLabel(report.description ?? ""),
    };
    if (report.icon) state.icon = normalizeLabel(report.icon);
```

Extend the `EffectiveHarnessState` type with the same four fields (`icon` optional), each with a JSDoc line.

- [ ] **Step 4: Extend the response schema**

In `node-view.ts`, add to `NodeHarnessViewSchema`, each with a `description`:

```ts
  name: t.String({
    description:
      "Display name as the NODE reported it, so a plugin this build does not carry still renders by name. Normalized: it is third-party text reaching a browser and a log line",
  }),
  type: t.String({ description: "What kind of thing the plugin provides, e.g. 'agent-harness' or 'terminal'" }),
  description: t.String({ description: "One-line description from the plugin's manifest, as the node reported it" }),
  icon: t.Optional(t.String({ description: "Emoji or glyph the plugin declares, when it has one" })),
```

Note in the schema comment that `version` on this row remains the DRIVEN PROGRAM's version, unchanged by this addition.

- [ ] **Step 5: Run the server suite**

Run: `cd apps/server/api && bun test`
Expected: PASS except the sanctioned ZERO-BYTE baseline.

- [ ] **Step 6: Prove the normalization**

Temporarily drop `normalizeLabel` from the `name` assignment. The control-character test must fail. Restore and re-run.

- [ ] **Step 7: Commit**

```bash
git add apps/server/api
git commit
```

Message: `feat(server): a node's harness rows carry the plugin identity the node reported`.

---

### Task 5: Delete the anonymous write window, move the catalog

**Files:**
- Modify: `apps/server/api/src/api/setup.route.ts` (delete the two `/plugins` handlers and the write half of `requireHarnessAccess`; move the catalog read out)
- Create: `apps/server/api/src/api/plugins-catalog.route.ts`
- Modify: `apps/server/api/src/api/routes.ts` (or wherever route modules are aggregated; find it with `grep -rn "setupRoutes" apps/server/api/src --include=*.ts | grep -v __tests__`)
- Modify: `apps/server/web/src/hooks/use-harnesses.ts` (the `useHarnesses` URL, and delete `useSetHarnessInstalled` plus `harnessInstallErrorMessage` if nothing else uses them)
- Modify: `apps/server/web/src/hooks/use-harness-toggles.ts` (its only consumer is the wizard, which Task 9 rewrites; delete it if Task 9's design leaves it unused, otherwise repoint it)
- Test: `apps/server/api/src/api/__tests__/setup-route.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `GET /api/plugins/catalog`, same body as the old `GET /api/setup/harnesses` (`HarnessInfo[]`), requiring an authenticated actor.

**Context:** `requireHarnessAccess(request, write)` currently early-returns for everyone while `hasUsersProbe()` is false. Spec §2.1: the wizard never uses that window, because `setStep(1)` fires inside `register()` after sign-up succeeds, so an admin session always exists by the time an install button can be pressed. `GET /api/setup/status` stays always-public; nothing else in this file does.

**Order matters:** do Task 5 before Task 9, so the wizard rewrite is written against the routes that will exist.

- [ ] **Step 1: Write the failing tests**

In `setup-route.test.ts`, replace the tests covering the two writes with:

```ts
test("the setup plugin write routes are gone", async () => {
  const post = await app.handle(new Request("http://x/api/setup/plugins", { method: "POST", body: JSON.stringify({ pluginId: "pi" }) }));
  expect(post.status).toBe(404);
  const del = await app.handle(new Request("http://x/api/setup/plugins/pi", { method: "DELETE" }));
  expect(del.status).toBe(404);
});

test("an anonymous caller on a FRESH instance cannot install anything", async () => {
  // The F3 regression this file has guarded since 2026-08, now closed by
  // deletion rather than by a check that could rot.
  await clearUsers();
  const res = await app.handle(new Request("http://x/api/setup/plugins", { method: "POST", body: JSON.stringify({ pluginId: "pi" }) }));
  expect(res.status).toBe(404);
});

test("the catalog moved and is never anonymous", async () => {
  await clearUsers();
  const anon = await app.handle(new Request("http://x/api/plugins/catalog"));
  expect(anon.status).toBe(401);
  const authed = await app.handle(withCookie(new Request("http://x/api/plugins/catalog")));
  expect(authed.status).toBe(200);
});

test("setup status stays the one always-public setup route", async () => {
  await clearUsers();
  const res = await app.handle(new Request("http://x/api/setup/status"));
  expect(res.status).toBe(200);
});
```

Adapt `clearUsers`/`withCookie` to the helpers that file already has.

- [ ] **Step 2: Run and watch them fail**

Run: `cd apps/server/api && bun test src/api/__tests__/setup-route.test.ts`
Expected: FAIL. The writes answer 200/403 rather than 404; `/api/plugins/catalog` 404s.

- [ ] **Step 3: Create the catalog route**

New `apps/server/api/src/api/plugins-catalog.route.ts`, moving the existing `GET /harnesses` handler body verbatim (it calls `allHarnesses()` and `installedIdsHere()`), behind the normal `authGuard` so any authenticated actor may read it. Give the module a doc comment explaining why it is not under `/api/setup` any more: after the setup writes were deleted, this list is not about setup, it is the catalog of what this build can install offline, and the node page reads it on every visit. Keep the response schema and its `description`s.

- [ ] **Step 4: Gut the setup route**

Delete the `POST /plugins` and `DELETE /plugins/:pluginId` handlers, the `GET /harnesses` handler, `requireHarnessAccess`, and any now-unused imports (`allHarnesses`, `builtInIds`, `installLocalPlugin`, `uninstallLocalPlugin`, `harnessInfo` if it moved). Update the module doc comment: `GET /status` is now the only route here and the only always-public one, and the first-run public-write concept is gone rather than narrowed. Register the new route module wherever `setupRoutes` is registered.

- [ ] **Step 5: Repoint the web hook**

In `use-harnesses.ts`, change the `useHarnesses` fetch to `/api/plugins/catalog`, and delete `useSetHarnessInstalled` and `harnessInstallErrorMessage` along with their now-dead imports. Update the `HarnessInfo` doc comment in `apps/server/web/src/types/harness.ts`, which names the old URL. Fix every test that stubs `/api/setup/harnesses` (`grep -rln "api/setup/harnesses" apps/server/web/src`).

- [ ] **Step 6: Run both suites**

Run: `cd apps/server/api && bun test src/api/__tests__/setup-route.test.ts` then `cd apps/server/web && bun test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/server/api apps/server/web
git commit
```

Message: `refactor(setup): delete the anonymous first-run write window, move the catalog out of /api/setup`. The body should record that the wizard never used the window, and that §13's worry about an anonymous door in front of phase 3's npm fetch is retired by deletion rather than by a guard that could rot.

---

### Task 6: The check-updates route

**Files:**
- Modify: `apps/server/api/src/services/nodes/plugin-sync.ts`
- Modify: `apps/server/api/src/api/nodes/set-node-plugin.route.ts`
- Test: `apps/server/api/src/api/nodes/__tests__/` (beside the existing plugin route tests) and `apps/server/api/src/services/nodes/__tests__/plugin-sync.test.ts`

**Interfaces:**
- Consumes: `plugin_check_updates` (Task 1), the agent handler (Task 3).
- Produces: `POST /api/nodes/:id/plugins/check-updates -> { updates: PluginUpdateWire[] }`, owner-gated.

**Context:** `installNodePlugin` in `plugin-sync.ts` is the model: it branches on `isLocal(node)`, calls the pane-runtime function directly for `local`, and otherwise `send()`s a signed command (which turns a `NodeRpcError` into a 409 naming the node). `send` already exists in that file.

**POST, not GET**, because the node dials a registry as a result. It is an action with an outward effect, and a GET would also be cacheable, which this must not be.

**No audit entry.** The route module audits install and uninstall because they change what a machine will execute. A check changes nothing, and auditing reads would drown the log the other entries live in. State that in the handler's comment so nobody adds one for symmetry.

- [ ] **Step 1: Write the failing tests**

Service test:

```ts
test("checkNodePluginUpdates asks the local host directly", async () => {
  const rows = await checkNodePluginUpdates(localNodeRow, undefined);
  expect(rows.some((r) => r.kind === "embedded")).toBe(true);
});

test("checkNodePluginUpdates refuses an offline agent with 409, not 500", async () => {
  await expect(checkNodePluginUpdates(offlineAgentRow, undefined)).rejects.toMatchObject({ status: 409 });
});
```

Route test:

```ts
test("check-updates is owner-gated like install", async () => {
  const res = await app.handle(withCookie(new Request(`http://x/api/nodes/${foreignNodeId}/plugins/check-updates`, { method: "POST" }), otherUser));
  expect(res.status).toBe(403);
});

test("check-updates answers with the node's rows", async () => {
  const res = await app.handle(withCookie(new Request(`http://x/api/nodes/local/plugins/check-updates`, { method: "POST" }), admin));
  expect(res.status).toBe(200);
  expect(Array.isArray((await res.json()).updates)).toBe(true);
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `cd apps/server/api && bun test src/services/nodes/__tests__/plugin-sync.test.ts`
Expected: FAIL, `checkNodePluginUpdates is not a function`.

- [ ] **Step 3: Add the service function**

In `plugin-sync.ts`:

```ts
/**
 * Asks one node which of its installed plugins have a newer version.
 *
 * Reads only: nothing is installed, nothing is mirrored, and no audit entry is
 * written, because nothing changed. The node uses its OWN configured registry,
 * which is why this is asked rather than computed here: this server's
 * `SUBSHELL_PLUGIN_REGISTRY_URL` is a different setting, and answering from it
 * could name an update the node cannot fetch.
 * @throws HarnessStateError 409 when an enrolled node is offline
 */
export async function checkNodePluginUpdates(node: NodeTable, pluginId: string | undefined): Promise<PluginUpdateWire[]> {
  if (isLocal(node)) {
    return await resolvePluginUpdates(SUBSHELL_SERVER_DATA_DIR_PLUGINS_ROOT, {
      ...(pluginId === undefined ? {} : { id: pluginId }),
      registryUrl: SUBSHELL_PLUGIN_REGISTRY_URL,
    });
  }
  const result = await send(node, {
    type: "plugin_check_updates",
    ...(pluginId === undefined ? {} : { id: pluginId }),
  });
  const updates = (result as { updates?: unknown } | null)?.updates;
  return Array.isArray(updates) ? (updates as PluginUpdateWire[]) : [];
}
```

For the `local` branch, use the SAME data-dir resolution `installLocalPlugin` uses. Open `apps/server/api/src/services/nodes/local-plugins.ts` and reuse its helper rather than re-deriving a path; if it keeps the dir private, export it or add a `checkLocalPluginUpdates` there and call that. Do not hardcode a path.

- [ ] **Step 4: Add the route**

Append a third handler to `setNodePluginRoute`, following the two that exist (same `requireCookieActor`, `loadNodeGate`, `nodeCanManageFor` gate, same `RESPONSES` minus the ones that cannot happen):

```ts
  .post(
    "/:id/plugins/check-updates",
    async ({ params, user, actor, status }) => {
      requireCookieActor(actor, "Plugin management is restricted to browser sessions");
      const gate = await loadNodeGate(user.id, params.id);
      if (!gate) {
        return status(404, apiErrorBody({ code: BackendErrorCodes.NOT_FOUND_ERROR, message: "Node not found" }));
      }
      if (!nodeCanManageFor(gate.row.kind, gate.access, gate.isAdmin)) throw new ForbiddenError();
      // Deliberately NOT audited: the two handlers above are, because they
      // change what a machine will execute. This one reads.
      return { updates: await checkNodePluginUpdates(gate.row, undefined) };
    },
    {
      params: t.Object({ id: t.String({ description: "Node id" }) }),
      response: { 200: PluginUpdatesSchema, 401: "ApiErrorResponse", 403: "ApiErrorResponse", 404: "ApiErrorResponse", 409: "ApiErrorResponse" },
      detail: {
        operationId: "checkNodePluginUpdates",
        tags: ["nodes"],
        description:
          "Asks one node which installed plugins have a newer version (owner-only, cookie session). POST because the node contacts a registry; nothing is installed and nothing is recorded. An offline node is refused rather than queued",
      },
    },
  );
```

Define `PluginUpdatesSchema` in the same module as a named constant mirroring the union, with a `description` on every property, using `t.Union` of three `t.Object`s discriminated by a `t.Literal` `kind`.

- [ ] **Step 5: Run the server suite**

Run: `cd apps/server/api && bun test`
Expected: PASS except the sanctioned baseline.

- [ ] **Step 6: Prove the gate**

Temporarily remove the `nodeCanManageFor` line. The 403 test must fail. Restore and re-run.

- [ ] **Step 7: Commit**

```bash
git add apps/server/api
git commit
```

Message: `feat(server): ask a node which plugins have updates`.

---

### Task 7: Web data layer

**Files:**
- Modify: `apps/server/web/src/hooks/use-harnesses.ts`
- Modify: `apps/server/web/src/types/node.ts` (the `NodeHarness` type)
- Create: `apps/server/web/src/types/plugin-update.ts`
- Test: `apps/server/web/src/hooks/__tests__/` (follow the existing hook test style; if hooks are tested only through components, put these assertions in Task 8's component tests instead and say so in the commit)

**Interfaces:**
- Consumes: Tasks 4, 5, 6.
- Produces: `NodeHarness` carrying `name`/`type`/`description`/`icon`; `PluginUpdate` (web mirror of the wire union); `useSetNodePlugin` accepting an optional `spec`; `useCheckNodePluginUpdates(nodeId)`.

- [ ] **Step 1: Add the types**

`apps/server/web/src/types/plugin-update.ts`:

```ts
/**
 * One installed plugin's update status, as `POST
 * /api/nodes/:id/plugins/check-updates` reports it.
 *
 * Every installed plugin gets a row. An absent row means the plugin is not
 * installed, never "nothing to do": the node classifies embedded copies and
 * failed checks explicitly so a card does not have to guess at silence.
 */
export type PluginUpdate =
  | { id: string; kind: "registry"; name: string; from: string; to: string | null }
  | { id: string; kind: "embedded" }
  | { id: string; kind: "error"; message: string };
```

Extend `NodeHarness` in `types/node.ts` with `name: string`, `type: string`, `description: string`, `icon?: string`, each with a JSDoc line, noting that `name` is the node's own reported name and not a lookup in this build's catalog.

- [ ] **Step 2: Teach `useSetNodePlugin` about `spec`**

```ts
export function useSetNodePlugin(nodeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ pluginId, installed, spec }: { pluginId: string; installed: boolean; spec?: string }) =>
      installed
        ? apiFetch<Node>(`/api/nodes/${nodeId}/plugins`, {
            method: "POST",
            body: JSON.stringify({ pluginId, ...(spec === undefined ? {} : { spec }) }),
          })
        : apiFetch<Node>(`/api/nodes/${nodeId}/plugins/${pluginId}`, { method: "DELETE" }),
    onSuccess: (view) => {
      queryClient.setQueryData([...NODE_QUERY_KEY, nodeId], view);
      void queryClient.invalidateQueries({ queryKey: NODE_QUERY_KEY });
    },
  });
}
```

- [ ] **Step 3: Add the check hook**

```ts
/**
 * Asks a node which plugins have updates. A MUTATION rather than a query,
 * deliberately: it makes the node contact a registry, so it must happen when
 * a person asks and never on render, refetch or window focus.
 */
export function useCheckNodePluginUpdates(nodeId: string) {
  return useMutation({
    mutationFn: () =>
      apiFetch<{ updates: PluginUpdate[] }>(`/api/nodes/${nodeId}/plugins/check-updates`, { method: "POST" }),
  });
}
```

- [ ] **Step 4: Extend the error mapper**

`nodePluginErrorMessage` already unwraps a 409 and a 403. Add a 400 case for the malformed-spec refusal the server raises before sending anything: return the server's own message, since it names what was wrong with the string the user typed.

- [ ] **Step 5: Run and commit**

Run: `cd apps/server/web && bun test`
Expected: PASS.

```bash
git add apps/server/web
git commit
```

Message: `feat(web): plugin identity, specs and update checks in the data layer`.

---

### Task 8: The Plugins card

**Files:**
- Modify: `apps/server/web/src/components/nodes/node-harness-card.tsx`
- Create: `apps/server/web/src/components/nodes/install-by-name.tsx`
- Test: `apps/server/web/src/components/__tests__/node-harness-card.test.tsx` (create if absent; model it on the existing component tests)

**Interfaces:**
- Consumes: Task 7.
- Produces: the card. No exports other tasks depend on.

**Context:** the current card is 181 lines and already handles broken rows, `restartRequired`, the two `reason` cases and per-row errors. Keep all of that. Three things change and one is added.

Changes: the row name comes from `h.name` (not a catalog lookup); the "Add a plugin" block gains the install-by-name field; update affordances appear once a check has run; the card is read-only when `!canManage`.

**Copy rules:** no em dashes in any string a user reads. The confirmation must name the exact package and state the consequence plainly.

- [ ] **Step 1: Write the failing tests**

```tsx
test("a third-party plugin renders by its reported name, not its id", async () => {
  renderCard({ harnesses: [{ harnessId: "acme-thing", name: "Acme Thing", type: "agent-harness", description: "", installed: true }] });
  expect(await screen.findByText("Acme Thing")).toBeInTheDocument();
  expect(screen.queryByText("acme-thing")).not.toBeInTheDocument();
});

test("installing from the catalog asks nothing", async () => {
  const { post } = renderCard({ catalog: [{ id: "pi", name: "Pi" }] });
  await userEvent.click(screen.getByRole("button", { name: /install/i }));
  expect(post).toHaveBeenCalledWith(expect.objectContaining({ pluginId: "pi" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

test("installing a typed package asks first and sends nothing when cancelled", async () => {
  const { post } = renderCard({});
  await userEvent.type(screen.getByLabelText(/install from npm/i), "@acme/plugin-thing");
  await userEvent.click(screen.getByRole("button", { name: /^install$/i }));
  expect(await screen.findByText(/@acme\/plugin-thing/)).toBeInTheDocument();
  expect(screen.getByText(/runs as the node's OS user/i)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
  expect(post).not.toHaveBeenCalled();
});

test("confirming a typed package sends it as the spec", async () => {
  const { post } = renderCard({});
  await userEvent.type(screen.getByLabelText(/install from npm/i), "@acme/plugin-thing@2.0.0");
  await userEvent.click(screen.getByRole("button", { name: /^install$/i }));
  await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /install/i }));
  expect(post).toHaveBeenCalledWith(expect.objectContaining({ spec: "@acme/plugin-thing@2.0.0" }));
});

test("the three update kinds each say something different", async () => {
  renderCard({ updates: [
    { id: "a", kind: "registry", name: "@x/a", from: "1.0.0", to: "2.0.0" },
    { id: "b", kind: "embedded" },
    { id: "c", kind: "error", message: "could not reach the registry at http://mirror" },
  ]});
  expect(await screen.findByRole("button", { name: /update to 2\.0\.0/i })).toBeInTheDocument();
  expect(screen.getByText(/not updated from the registry/i)).toBeInTheDocument();
  expect(screen.getByText(/could not reach the registry at http:\/\/mirror/i)).toBeInTheDocument();
});

test("a viewer sees the plugins and none of the controls", () => {
  renderCard({ canManage: false, harnesses: [{ harnessId: "pi", name: "Pi", installed: true }] });
  expect(screen.getByText("Pi")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /remove/i })).not.toBeInTheDocument();
  expect(screen.queryByLabelText(/install from npm/i)).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `cd apps/server/web && bun test src/components/__tests__/node-harness-card.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Read the name off the row**

Replace `const name = catalog?.find((c) => c.id === h.harnessId)?.name ?? h.harnessId;` with `const name = h.name || h.harnessId;` and update the comment above the card explaining that identity now comes from the node's report, so a plugin this build never heard of renders by name. The catalog is still fetched, but only to offer installs.

- [ ] **Step 4: Build the install-by-name control**

New `install-by-name.tsx` exporting `InstallByName({ nodeName, catalogIds, pending, onInstall })`. It owns the input, decides whether a confirmation is needed, and renders it:

- Parse the typed value into a package name by stripping a trailing `@version`, being careful that a scoped name starts with `@` (`@scope/pkg@1.2.3` -> name `@scope/pkg`). Reuse the agent's rule rather than inventing one: read `parsePackageSpec` in `packages/pane-runtime/src/npm-registry.ts` and mirror its splitting logic in a small local helper, with a comment pointing at it. Do not import pane-runtime into the browser bundle.
- A value whose bare name is in `catalogIds` installs with no confirmation, since those bytes are embedded and no network is touched.
- Anything else opens a confirmation dialog (use the existing `components/ui` dialog primitive; find it with `ls apps/server/web/src/components/ui`) whose body names the package and the node and says: this downloads the package and runs its code as the node's OS user, with no sandbox. It can read that machine's files and every subshell launched on it. Cancel sends nothing.
- On confirm, call `onInstall(spec)`.

Give the module a doc comment recording WHY the split exists: friction belongs where the trust changes, and a catalog install changes none.

- [ ] **Step 5: Wire updates into the card**

Add a "Check for updates" button beside the card's existing controls (manage-only). On click, run `useCheckNodePluginUpdates`. Hold the resulting rows in local state keyed by id and render per row:

- `kind: "registry"` with `to` non-null: a button reading `Update to <to>`, which calls the install mutation with `{ pluginId: id, installed: true, spec: `${name}@${to}` }`. Say in a comment that the resolved version is pinned deliberately, so the install is the version the operator was shown.
- `kind: "registry"` with `to: null`: quiet text, already up to date.
- `kind: "embedded"`: text saying it came with the agent and is not updated from the registry.
- `kind: "error"`: the message verbatim, in the destructive style the row already uses for `broken`.

- [ ] **Step 6: Make read-only real**

`actionable` is already `canManage`. Extend it to gate the new field and the check button too, and render the rows regardless. Add the offline case: when `data?.inventoryStale` is true the existing banner shows; also disable the manage controls and say why, since a write would 409 anyway and offering a button that cannot work is worse than saying so.

- [ ] **Step 7: Run the suite**

Run: `cd apps/server/web && bun test`
Expected: PASS.

- [ ] **Step 8: Prove the confirmation**

Temporarily make `InstallByName` call `onInstall` directly without the dialog. The cancel test must fail. Restore and re-run.

- [ ] **Step 9: Commit**

```bash
git add apps/server/web
git commit
```

Message: `feat(web): the Plugins card installs by name, and says what that means`.

---

### Task 9: Setup step 2

**Files:**
- Modify: `apps/server/web/src/routes/setup.tsx`
- Modify or delete: `apps/server/web/src/components/harness-row.tsx` and `apps/server/web/src/hooks/use-harness-toggles.ts` (both exist to serve the old toggle; keep only what the new step uses)
- Test: `apps/server/web/src/routes/__tests__/setup.test.tsx` (create if absent)

**Interfaces:**
- Consumes: Tasks 5 and 7.
- Produces: nothing other tasks depend on.

**Context:** `STEPS = ["Account", "Harness"]`. Step 0 registers and calls `setStep(1)`. Step 1 currently lists every catalog harness with a toggle and says "switch it on", which has been wrong since phase 2b removed the enable concept. Installs now go to `POST /api/nodes/local/plugins` through `useSetNodePlugin("local")`.

Spec §2.5: the step leads with what the scan supports.

- [ ] **Step 1: Write the failing tests**

```tsx
test("leads with the found harness and installs it with one button", async () => {
  const { post } = renderSetupStep2({ catalog: [{ id: "claude-code", name: "Claude Code", installed: true, version: "2.1.266", installedHere: false }] });
  expect(await screen.findByText(/Found Claude Code 2\.1\.266/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /install/i }));
  expect(post).toHaveBeenCalledWith("/api/nodes/local/plugins", expect.objectContaining({ pluginId: "claude-code" }));
});

test("when the scan finds nothing it leads with enrolling a node", async () => {
  renderSetupStep2({ catalog: [{ id: "claude-code", name: "Claude Code", installed: false, installedHere: false }] });
  expect(await screen.findByRole("link", { name: /node/i })).toBeInTheDocument();
  expect(screen.getByText(/install command/i)).toBeInTheDocument();
});

test("the step is never a dead end when an install fails", async () => {
  renderSetupStep2({ catalog: [{ id: "claude-code", name: "Claude Code", installed: true, installedHere: false }], postFails: true });
  await userEvent.click(await screen.findByRole("button", { name: /install/i }));
  expect(await screen.findByRole("alert")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /finish/i })).toBeEnabled();
});

test("no copy tells anyone to switch anything on", async () => {
  renderSetupStep2({ catalog: [] });
  expect(screen.queryByText(/switch it on/i)).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `cd apps/server/web && bun test src/routes/__tests__/setup.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Rewrite step 1's body**

Rename the step label from `"Harness"` to `"Where subshells run"` in `STEPS`. Split the arm on the scan:

- **Found something** (`catalog.some((h) => h.installed)`): lead with the first found entry, `Found <name> <version>`, and one Install button calling `useSetNodePlugin("local")` with `{ pluginId: h.id, installed: true }` and no spec, so the embedded copy is used and no network is touched. Everything else collapses behind an "Add another" disclosure listing the remaining catalog entries with their own Install buttons.
- **Found nothing**: lead with the enrollment path (the existing `Link to="/nodes"`), then the catalog below with each entry's `install.command` and `install.docsUrl` from `HarnessInfo`.

Both arms keep the Finish button, and an install failure renders inline via `role="alert"` without blocking Finish.

Rewrite the step's prose. It must not mention enabling or switching on. Say what is true: a plugin teaches this machine to drive one agent CLI, installing it here uses the copy that shipped with this build, and it can be changed later on the node's page.

- [ ] **Step 4: Retire the dead toggle machinery**

If `HarnessRow` and `use-harness-toggles.ts` have no remaining consumer (`grep -rn "HarnessRow\|useHarnessToggles" apps/server/web/src`), delete both and their tests. If the profile editor still uses `HarnessRow`, leave it and only remove the toggle path.

- [ ] **Step 5: Run the suite**

Run: `cd apps/server/web && bun test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/web
git commit
```

Message: `feat(setup): step 2 asks where subshells will run`.

---

### Task 10: Desktop commands and the ACL

**Files:**
- Modify: `apps/client/desktop/src-tauri/src/control.rs` (the `AgentCommand` enum around line 100, its `args()`, and new `#[tauri::command]` functions near `node_service` at line 743)
- Modify: `apps/client/desktop/src-tauri/src/lib.rs` (the `invoke_handler` registration list)
- Modify: `apps/client/desktop/src-tauri/permissions/desktop.toml`
- Modify: `apps/client/desktop/src-tauri/capabilities/node.json`
- Modify: `apps/client/desktop/ui/src/lib/ipc.ts`
- Test: `apps/client/desktop/ui/src/__tests__/ipc-acl.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (it shells out to the agent CLI phase 3 shipped).
- Produces: `node_plugin_list`, `node_plugin_install`, `node_plugin_uninstall` commands and their TS wrappers.

**Context:** `ipc-acl.test.ts` pins EXACT SET EQUALITY, in both directions, between the commands `lib/ipc.ts` invokes, `commands.allow` across `permissions/desktop.toml`, and the `permissions` array in `capabilities/node.json`. Adding a command to two of the three fails. That is the point of the test; do not weaken it.

Spec §2.8: install, uninstall and list ONLY. No update checking and no settings on this surface.

The CLI these shell out to is `subshell plugin list --json`, `subshell plugin install <spec>`, `subshell plugin uninstall <id>`. `plugin list --json` prints rows of `{ id, version, broken?, package?, packageVersion? }`.

- [ ] **Step 1: Write the failing ACL test expectation**

Add the three command names to whatever list `ipc-acl.test.ts` uses as its expected set (if it derives all three sides from the files, simply adding the command to `ipc.ts` in step 4 will make it fail until the other two files agree, which is the correct red).

Run: `cd apps/client/desktop/ui && bun test`
Expected: FAIL, the three-way sets disagree.

- [ ] **Step 2: Add the Rust variants**

In `control.rs`, extend `AgentCommand`:

```rust
    /// `plugin list --json` — what this machine offers.
    PluginList,
    /// `plugin install <spec>` — the spec is a plugin id for a built-in, or an
    /// npm package name for anything else. The agent's own embedded-first
    /// rules decide which; this app makes no source decision.
    PluginInstall { spec: String },
    /// `plugin uninstall <id>` — removing one already absent succeeds.
    PluginUninstall { id: String },
```

and their `args()` arms:

```rust
            AgentCommand::PluginList => vec!["plugin".into(), "list".into(), "--json".into()],
            AgentCommand::PluginInstall { spec } => vec!["plugin".into(), "install".into(), spec.clone()],
            AgentCommand::PluginUninstall { id } => vec!["plugin".into(), "uninstall".into(), id.clone()],
```

- [ ] **Step 3: Add the three commands**

Following `node_service`'s shape exactly (resolve the agent, `run_agent`, `ActionResult::refused(NO_AGENT)` when absent):

```rust
/// What this machine currently offers, read from `plugin list --json`.
#[tauri::command(async)]
pub fn node_plugin_list(settings: State<'_, SettingsState>) -> ActionResult { /* ... */ }

/// Install a plugin. The page passes a built-in id or a typed package name;
/// the agent decides which is which, and refuses what it cannot install.
#[tauri::command(async)]
pub fn node_plugin_install(settings: State<'_, SettingsState>, spec: String) -> ActionResult { /* ... */ }

/// Remove a plugin. Removing one that is already absent succeeds.
#[tauri::command(async)]
pub fn node_plugin_uninstall(settings: State<'_, SettingsState>, id: String) -> ActionResult { /* ... */ }
```

Register all three in `lib.rs`'s `invoke_handler`.

- [ ] **Step 4: Add the TS wrappers**

In `ui/src/lib/ipc.ts`, following the existing wrappers' JSDoc style:

```ts
export async function nodePluginList(): Promise<ActionResult> {
  return invoke<ActionResult>("node_plugin_list");
}

export async function nodePluginInstall(args: { spec: string }): Promise<ActionResult> {
  return invoke<ActionResult>("node_plugin_install", args);
}

export async function nodePluginUninstall(args: { id: string }): Promise<ActionResult> {
  return invoke<ActionResult>("node_plugin_uninstall", args);
}
```

- [ ] **Step 5: Add the ACL entries**

Three `[[permission]]` blocks in `desktop.toml`, each with a `description` saying what it lets the page do and what the risk is, in the voice of the existing entries. The install one must state that a typed package name makes this machine download and execute third-party code as this user. Add the three identifiers to `capabilities/node.json`'s `permissions`.

- [ ] **Step 6: Run the ACL test and the Rust checks**

Run: `cd apps/client/desktop/ui && bun test` then, from the repo root, `bun run rust:check`
Expected: PASS on both. `rust:check` runs fmt, clippy with `-D warnings`, and tests across all three crates, and it stages the sidecar stub the Tauri build script needs.

- [ ] **Step 7: Prove the three-way pin**

Remove one identifier from `capabilities/node.json`. The ACL test must fail. Restore and re-run.

- [ ] **Step 8: Commit**

```bash
git add apps/client/desktop
git commit
```

Message: `feat(desktop): node_plugin_* commands, granted only to the bundled node page`.

---

### Task 11: The desktop Plugins card

**Files:**
- Create: `apps/client/desktop/ui/src/plugins-card.tsx`
- Modify: `apps/client/desktop/ui/src/app.tsx` (compose it beside the existing cards)
- Modify: `apps/client/desktop/ui/src/hooks/use-node-commands.ts` (add the three calls, following the file's plain-callback style; this app does NOT use TanStack Query)
- Test: `apps/client/desktop/ui/src/__tests__/plugins-card.test.tsx`

**Interfaces:**
- Consumes: Task 10.
- Produces: nothing.

**Context:** the node page is composed in `app.tsx` from `status-card`, `prefs-card`, `node-plane-card`, `plane-card`, `step-card`, `confirm-panel`, `enroll-fields`, `output-block`. State is plain React via `use-node-state.ts` and `use-node-commands.ts`. `confirm-panel.tsx` is the app's existing confirmation idiom, used for the destructive enroll; reuse it rather than introducing a dialog.

- [ ] **Step 1: Write the failing tests**

```tsx
test("lists what the agent reports", async () => {
  renderCard({ list: [{ id: "pi", version: "0.1.0" }, { id: "acme", version: "1.0.0", package: "@acme/plugin-acme", packageVersion: "1.0.0" }] });
  expect(await screen.findByText("pi")).toBeInTheDocument();
  expect(screen.getByText(/@acme\/plugin-acme/)).toBeInTheDocument();
});

test("a typed package name is confirmed before anything runs", async () => {
  const { install } = renderCard({ list: [] });
  await userEvent.type(screen.getByLabelText(/install/i), "@acme/plugin-thing");
  await userEvent.click(screen.getByRole("button", { name: /^install$/i }));
  expect(await screen.findByText(/runs as your user/i)).toBeInTheDocument();
  expect(install).not.toHaveBeenCalled();
});

test("a broken plugin shows why", async () => {
  renderCard({ list: [{ id: "bad", version: "", broken: "entry not found" }] });
  expect(await screen.findByText(/entry not found/)).toBeInTheDocument();
});

test("no agent installed is said, not crashed on", async () => {
  renderCard({ refused: true });
  expect(await screen.findByText(/agent/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `cd apps/client/desktop/ui && bun test src/__tests__/plugins-card.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Build the card**

Render the parsed `plugin list --json` rows: id, version, the package column when a `package` is present, `broken` in the error style, and a Remove button each. Below, an install field taking a built-in id or a package name, routed through `confirm-panel` when the value is not one of the built-in ids the list already offers. Copy must state that installing runs code as this user with no sandbox, and must contain no em dashes.

Surface `ActionResult::refused(NO_AGENT)` as the card's empty state saying the agent is not installed yet, pointing at the install step already on the page. Do not throw.

- [ ] **Step 4: Compose and run**

Add the card to `app.tsx` beside the others. Run: `cd apps/client/desktop/ui && bun test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/client/desktop
git commit
```

Message: `feat(desktop): a Plugins card on the node page`.

---

### Task 12: Docs, e2e, and the whole-suite pass

**Files:**
- Modify: `docs/security.md`, `.claude/rules/security-context.md`, `docs/node-protocol.md`, `docs/architecture.md`, `AGENTS.md`, `apps/server/api/AGENTS.md`, `apps/client/desktop/AGENTS.md`
- Modify: `e2e/tests/14-registry-install.spec.ts`
- Create: `e2e/tests/15-install-by-name.spec.ts`
- Modify: `docs/superpowers/plans/2026-09-10-plugins-phase4-ux.md` (tick the boxes)

- [ ] **Step 1: Docs**

- `docs/security.md`: the registry paragraph phase 3 added now needs the UI sentence. A browser button can make a machine download and execute third-party code; it is owner-only, it is confirmed for anything not shipped in the build, and it is the same trust decision as installing the CLI it drives. Also record that the anonymous first-run write window is GONE, so the only always-public routes are `GET /api/setup/status` and `GET /api/settings/instance`.
- `.claude/rules/security-context.md`: update the registry bullet to match, including the deleted setup writes. That file defers to `docs/security.md`, so the two must agree.
- `docs/node-protocol.md`: add the `plugin_check_updates` row and bump every protocol number the doc states.
- `docs/architecture.md` and the AGENTS files: the catalog moved to `GET /api/plugins/catalog`; the desktop node window has plugin commands; protocol is 3.

- [ ] **Step 2: Flip e2e spec 14**

Spec 14 asserts the demo plugin's row BY ID with a comment saying names do not render yet. Change it to assert the name and delete the comment. This is the cheapest possible proof Task 4 landed.

Run: `cd e2e && bunx playwright test 14`
Expected: PASS.

- [ ] **Step 3: New e2e for install-by-name**

`e2e/tests/15-install-by-name.spec.ts`, modelled on 14 and using the same fake registry (`e2e/fake-registry.ts`, a spawned bun child on port 3198 because the Playwright runner is Node and cannot host `Bun.serve` in process). Drive the browser: open `/nodes/local`, type the demo package name into the install field, confirm the dialog, and assert the row appears by name. Finish by uninstalling in a `finally`, since the suite shares one backend.

- [ ] **Step 4: Full verification**

```bash
bunx turbo build
bunx turbo run verify-types --force
bun run lint:check
bun run test
bun run rust:check
cd e2e && bunx playwright test
```

Everything green except the sanctioned `apps/server/api` ZERO-BYTE baseline. If an unrelated spec is red, re-run it alone to distinguish a flake from a break, and say which it was.

- [ ] **Step 5: Tick this plan's checkboxes and commit**

```bash
git add -A
git commit
```

Message: `docs(plugins): phase 4 is documented, and the e2e proves the names render`.

---

## Self-Review (plan author, 2026-09-10)

**Spec coverage.** §2.1 -> Task 5. §2.2 -> Tasks 1, 3, 6. §2.3 -> Task 2 (resolver) and Task 1 (wire type). §2.4 -> Task 4, proven again by Task 12's e2e flip. §2.5 -> Task 9. §2.6 -> Tasks 7, 8. §2.7 -> the check is a mutation hook in Task 7 and an explicit button in Task 8; the never-on-inventory half is pinned by Task 3's revert-proof. §2.8 -> Tasks 10, 11. §3's failure table -> Task 6 (409, 400), Task 8 (three update kinds, per-row errors), Task 9 (never a dead end). §4 -> Task 12. §5's test list is distributed across every task's own step 1. §6's landmines are Global Constraints plus the notes in Tasks 10 and 12.

**Known ambiguities, resolved here so an implementer does not have to guess.**
- The `local` branch of `checkNodePluginUpdates` needs the plugins root that `local-plugins.ts` owns. Task 6 step 3 says to reuse that module's helper rather than re-deriving a path, because deriving it twice is how the two hosts drift.
- Whether `HarnessRow` survives depends on whether the profile editor still uses it. Task 9 step 4 makes that a grep, not a judgment call.
- Web hook tests may not have an existing home. Task 7 says to fold those assertions into Task 8's component tests and note it in the commit, rather than inventing a harness.

**Type consistency.** `PluginUpdateWire` is defined once in Task 1 and imported by Tasks 2, 3 and 6; the browser mirror in Task 7 is a separate declaration on purpose (the web app does not import server or protocol packages for values) and its three variants match field for field. `resolvePluginUpdates` keeps its name and parameter shape and changes only its return type, which is why Task 2 owns both the resolver and its one consumer.

**What this plan does NOT do**, each deliberate: no settings schemas or settings pages (phase 5); no update affordances in the desktop window (§2.8); no `turbo.json` `outputs` declaration (phase 3 §8 parks it as its own task); no registry search, because typing a name is the whole third-party story this phase promises.
