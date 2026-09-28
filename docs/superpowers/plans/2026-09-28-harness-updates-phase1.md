# Harness Updates (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phase 1 of `docs/superpowers/specs/2026-09-28-harness-updates-design.md`: an Update button for harness CLIs on the control-plane host, a recorded harness version per pane, and a server-derived stale flag the UI renders as one detail line.

**Architecture:** The update action rides the existing built-in agent installer rails (manifest-declared command, cookie-admin-only NDJSON-streaming route, built-in id allowlist). A nullable `subshells.harness_version` column is compare-and-set stamped after every successful launch (exact via probe on `local`, inventory-derived on enrolled nodes with a scoped post-launch re-stamp). Staleness is derived once server-side from the node's inventory snapshot and rides the subshell view; clients only render it.

**Tech Stack:** Bun, TypeScript, Elysia, Kysely (bun:sqlite), plugin manifests as package.json data, React 19 + TanStack Query (web SPA in `apps/server/web`).

## Global Constraints

- Package manager is **Bun only** (`bun install`, `bun add`, `bunx`); all `package.json` versions stay pinned (no `^`/`~`).
- **No dynamic imports** (`await import(...)`) anywhere except the one named exception in `packages/pane-runtime/src/plugin-runtime.ts`.
- UI copy: **at most two sentences**, **no em dashes (U+2014)** anywhere in prose or shipped strings (`bun run lint:prose` enforces); type roles only (`text-detail`, `font-strong`, never raw px).
- Every Elysia `t` schema property carries a `description`.
- Migrations live in `apps/server/api/src/db/migrations/` **and** are registered in `apps/server/api/src/db/migrate.ts` in the same change.
- Tests colocate in `__tests__/` beside the code; run focused files while iterating, full `bun run verify-types && bun run lint:check && bun run lint:prose && bun run test` only at the boundary. Changes under `packages/` need `bunx turbo build` before dependent apps are type-checked.
- `bun test <paths>` silently skips nonexistent paths: **check the file count in the output**.
- Every user-visible subshell write calls `publishLive({ kind: "subshell.changed", id })` in the owning service.
- Work happens on the existing branch `docs/harness-updates-spec` (created by the spec commit); the PR carries spec + implementation.
- Spec deviations that are implementation facts (not design changes): the view carries THREE fields (`harnessVersion`, `harnessCurrentVersion`, `harnessStale`) because the spec's UI line renders both strings; stamping uses compare-and-set so a racing restart cannot be clobbered.

---

### Task 1: plugin-api manifest gains an `update` command

**Files:**
- Modify: `packages/plugin-api/src/manifest.ts`
- Test: `packages/plugin-api/src/__tests__/manifest.test.ts`

**Interfaces:**
- Produces: `SubshellManifest.update?: { command: string }` (parsed, privilege-checked). `UpdateSpec` exported type. Consumed by Task 2's adapter.

- [ ] **Step 1: Write the failing tests**

Append to `packages/plugin-api/src/__tests__/manifest.test.ts`. First read the file's top to reuse any existing minimal-manifest helper; if none exists, the fixture below is self-contained:

```ts
/** A package.json whose `subshell` block is valid except for the `update` under test. */
function pkgWithUpdate(update: unknown): Record<string, unknown> {
  return {
    name: "demo-plugin",
    version: "1.0.0",
    subshell: {
      apiVersion: 2,
      id: "demo",
      type: "agent-harness",
      name: "Demo",
      description: "demo",
      entry: "index.js",
      detect: { binaryName: "demo", envOverride: "DEMO_PATH", knownPaths: [] },
      update,
    },
  };
}

describe("subshell.update", () => {
  it("accepts a vendor update command", () => {
    const m = parseManifest(pkgWithUpdate({ command: "claude update" }));
    expect("error" in m).toBe(false);
    if (!("error" in m)) expect(m.update?.command).toBe("claude update");
  });

  it("omits update when the block is absent", () => {
    const pkg = pkgWithUpdate({ command: "claude update" });
    delete (pkg.subshell as Record<string, unknown>).update;
    const m = parseManifest(pkg);
    expect("error" in m).toBe(false);
    if (!("error" in m)) expect(m.update).toBeUndefined();
  });

  it("refuses an update command that needs privilege at ANY boundary", () => {
    // The line runs through `sh -c`, so a boundary hides a second command.
    const m = parseManifest(pkgWithUpdate({ command: "curl -fsSL https://x/install | sudo tee /dev/null" }));
    expect("error" in m).toBe(true);
    if ("error" in m) expect(m.error).toContain("sudo");
  });

  it("refuses a non-object update block", () => {
    expect("error" in parseManifest(pkgWithUpdate("claude update"))).toBe(true);
  });

  it("refuses an empty command (a heading with no words)", () => {
    expect("error" in parseManifest(pkgWithUpdate({ command: "  " }))).toBe(true);
  });
});
```

If the file does not already import it, add `import { parseManifest } from "../manifest.js";` (match the file's existing import).

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/plugin-api/src/__tests__/manifest.test.ts`
Expected: FAIL (the parser ignores unknown `update` today, so the accept-case assertion `m.update?.command` is `undefined`; the refusal cases return no error). Confirm the run reports this file, not `0 files`.

- [ ] **Step 3: Implement**

In `packages/plugin-api/src/manifest.ts`, after the `InstallSpec` interface, add:

```ts
/** How to move an already-installed program to a newer version, when the vendor ships one. */
export interface UpdateSpec {
  /**
   * The vendor's own update command, e.g. `claude update`.
   *
   * Like {@link InstallSpec.command}, this is a field a host RUNS through a
   * shell, so the same privilege refusal applies at parse time. It is separate
   * from `install` because for several vendors re-running the installer is
   * ALSO the update, and a plugin may honestly declare nothing here.
   */
  command: string;
}
```

In `SubshellManifest`, after the `install?: InstallSpec;` member, add:

```ts
  /** The vendor's self-update command; absent when updating is a re-run of {@link install} */
  update?: UpdateSpec;
```

In `parseManifest`, directly after the `install` parsing block (which ends with `install = { command: i.command, docsUrl: i.docsUrl };` + closing brace), add:

```ts
  // A SECOND field a host will RUN (`sh -c`), so the same boundary-aware
  // privilege refusal lands here as on `install.command`. An empty command is
  // refused, not dropped: a row that offers "Update" must have something to
  // run, and a plugin that ships `update: {}` is a plugin that means to.
  let update: UpdateSpec | undefined;
  if (block.update !== undefined) {
    const u = block.update;
    if (!isRecord(u) || typeof u.command !== "string" || u.command.trim() === "") {
      return { error: "`subshell.update` needs a non-empty command" };
    }
    if (needsPrivileges(u.command)) {
      return {
        error:
          "`subshell.update.command` must not need sudo, doas or pkexec — the host runs it through a shell and has no terminal for a password prompt",
      };
    }
    update = { command: u.command };
  }
```

In the return object, add `...(update ? { update } : {}),` after `...(install ? { install } : {}),`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/plugin-api/src/__tests__/manifest.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-api
git commit -m "feat(plugin-api): manifest update command, privilege-checked like install"
```

---

### Task 2: adapter `updateHint`, claude-code manifest, `HarnessInfo.update` payload

**Files:**
- Modify: `packages/pane-runtime/src/types.ts` (HarnessPlugin interface)
- Modify: `packages/pane-runtime/src/plugin-adapter.ts`
- Modify: `packages/plugins/claude-code/package.json` (the `subshell` block)
- Modify: `apps/server/api/src/api/models.ts` (`HarnessInfoSchema`)
- Modify: `apps/server/api/src/api/harness-utils.ts` (`harnessInfo`)
- Test: `packages/pane-runtime/src/__tests__/plugin-adapter.test.ts`, `packages/pane-runtime/src/__tests__/install-hints.test.ts`, `apps/server/api/src/api/__tests__/setup-route.test.ts`

**Interfaces:**
- Consumes: Task 1's `manifest.update`.
- Produces: `HarnessPlugin.updateHint?: string`; `HarnessInfoSchema` (and thus `GET /api/setup/harnesses` rows) gain optional `update: string`. Consumed by Tasks 3 (command fallback) and 8 (web card).

- [ ] **Step 1: Write the failing tests**

In `packages/pane-runtime/src/__tests__/plugin-adapter.test.ts`, follow the file's existing pattern of building a manifest + fake plugin and calling `adaptPlugin`. Add a case (adapt the manifest literal to the file's existing builder if one exists):

```ts
it("carries the manifest update command as updateHint, and only when declared", () => {
  const base = {
    apiVersion: 2,
    id: "demo",
    type: "agent-harness" as const,
    name: "Demo",
    description: "demo",
    entry: "index.js",
  };
  const noUpdate = adaptPlugin({ ...base }, {} as never);
  expect(noUpdate.updateHint).toBeUndefined();
  const withUpdate = adaptPlugin({ ...base, update: { command: "claude update" } }, {} as never);
  expect(withUpdate.updateHint).toBe("claude update");
});
```

In `packages/pane-runtime/src/__tests__/install-hints.test.ts` (which iterates the built-ins), add:

```ts
it("claude-code declares the vendor's own update; the others lean on the install fallback", () => {
  const byId = new Map(builtInHarnesses().map((h) => [h.id, h]));
  expect(byId.get("claude-code")?.updateHint).toBe("claude update");
  for (const id of ["codex", "opencode", "hermes", "pi"]) {
    // Declared or not, an installed row of these must have SOMETHING to run:
    // the update falls back to the install command, which these all have.
    const h = byId.get(id);
    expect(h).toBeDefined();
    expect((h?.updateHint ?? h?.installHint.command ?? "").trim()).not.toBe("");
  }
  // terminal drives a program with no install and no update at all.
  expect(byId.get("terminal")?.updateHint).toBeUndefined();
});
```

Match the file's existing import of `builtInHarnesses` (it already reads the built-in registry).

In `apps/server/api/src/api/__tests__/setup-route.test.ts`, find the existing case that GETs `/api/setup/harnesses` and asserts rows (read the file; it already authenticates somehow), and extend the claude-code row assertion with:

```ts
expect(claudeRow.update).toBe("claude update");
```

or add one small `it` following the file's existing fetch/auth helper shape if no per-row assertions exist yet.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/pane-runtime/src/__tests__/plugin-adapter.test.ts packages/pane-runtime/src/__tests__/install-hints.test.ts apps/server/api/src/api/__tests__/setup-route.test.ts`
Expected: FAIL on the `updateHint`/`update` assertions.

- [ ] **Step 3: Implement**

`packages/pane-runtime/src/types.ts`, in `HarnessPlugin`, right after `installHint: InstallHint;`:

```ts
  /**
   * The vendor's own self-update command from the manifest's `update` block,
   * or absent when the plugin declares none. Absent-not-undefined, like
   * {@link detectSpec}: a surface reading `in` must be able to tell "the
   * vendor ships an updater" from "updating here is a re-run of
   * {@link installHint}'s command" (that fallback decision lives in the
   * install service, and the copy line shows whichever string it picked).
   */
  updateHint?: string;
```

`packages/pane-runtime/src/plugin-adapter.ts`, in the `adaptPlugin` literal, right after the `installHint:` line:

```ts
    ...(manifest.update ? { updateHint: manifest.update.command } : {}),
```

`packages/plugins/claude-code/package.json`, inside the `subshell` block, add after the `install` object:

```json
    "update": { "command": "claude update" },
```

(Keep JSON key order sane; run `bun run lint` afterwards if biome reformats package.json.)

`apps/server/api/src/api/models.ts`, in `HarnessInfoSchema`, after the `install:` property:

```ts
  update: t.Optional(
    t.String({
      description:
        "Vendor self-update command (e.g. `claude update`); absent when the plugin declares none, which makes updating a re-run of the install command",
    }),
  ),
```

`apps/server/api/src/api/harness-utils.ts`, in `harnessInfo`'s return literal, after `install: h.installHint,`:

```ts
    // Optional, not null: "no vendor updater" and "an updater whose text is
    // empty" are the same nothing, and the surface falls back either way.
    ...(h.updateHint ? { update: h.updateHint } : {}),
```

- [ ] **Step 4: Build packages so dependents see the type, then run tests**

```bash
bunx turbo build --filter=@internal/pane-runtime --filter=@subshell-ai/plugin-api
bun test packages/pane-runtime/src/__tests__/plugin-adapter.test.ts packages/pane-runtime/src/__tests__/install-hints.test.ts apps/server/api/src/api/__tests__/setup-route.test.ts
```
Expected: PASS. (`bunx turbo build` may name the pane-runtime package differently; read the `name` field of `packages/pane-runtime/package.json` if the filter matches nothing, and confirm the build ran on the file count the summary prints.)

- [ ] **Step 5: Commit**

```bash
git add packages/pane-runtime packages/plugins/claude-code/package.json apps/server/api/src/api/models.ts apps/server/api/src/api/harness-utils.ts
git commit -m "feat(harnesses): update hint reaches the adapter and the setup payload"
```

---

### Task 3: install service grows a command kind

**Files:**
- Modify: `apps/server/api/src/services/agent-install.service.ts`
- Test: `apps/server/api/src/services/__tests__/agent-install.service.test.ts`

**Interfaces:**
- Consumes: Task 2's `updateHint`.
- Produces: `export type AgentInstallKind = "install" | "update"`; `refuseAgentCommand(id: string, kind: AgentInstallKind, deps?: AgentInstallDeps): Promise<AgentInstallRefused | undefined>`; `runBuiltInAgentCommand(id: string, kind: AgentInstallKind, deps?: AgentInstallDeps, onLine?: (line: string) => void): Promise<AgentInstallResult>`; `AgentInstallDeps.commandFor: (id: string, kind: AgentInstallKind) => Promise<string | undefined>`. `refuseInstall` / `installBuiltInAgent` stay as thin wrappers (existing callers unchanged). Consumed by Task 4.

- [ ] **Step 1: Write the failing tests**

First read `apps/server/api/src/services/__tests__/agent-install.service.test.ts` and note how its existing success run and in-flight refusal cases fake `AgentInstallDeps`. Mechanical fix: any `commandFor: async (id) => …` in that file stays valid (extra parameter is fine); if any dep literal is typed with an explicit two-arg signature, add the kind. Then add:

```ts
describe("update kind", () => {
  it("asks the seam for the update command; install stays on the install command", async () => {
    const seen: AgentInstallKind[] = [];
    const deps: AgentInstallDeps = {
      commandFor: async (_id, kind) => {
        seen.push(kind);
        return "true"; // exits 0 in one spawn, like the file's success case
      },
      timeoutMs: 30_000,
      extraPath: async () => [],
    };
    const updated = await runBuiltInAgentCommand("demo", "update", deps);
    const installed = await installBuiltInAgent("demo", deps);
    expect(updated.ok).toBe(true);
    expect(installed.ok).toBe(true);
    expect(seen).toEqual(["update", "install"]);
  });

  it("refuses a command that is empty after the fallback, and says update in the sentence", async () => {
    const deps: AgentInstallDeps = {
      commandFor: async () => "  ",
      timeoutMs: 30_000,
      extraPath: async () => [],
    };
    const refusal = await refuseAgentCommand("demo", "update", deps);
    expect(refusal?.message).toContain("nothing to update");
    expect(refusal?.status).toBe(400);
  });

  it("shares the per-id single flight across kinds", async () => {
    const deps: AgentInstallDeps = {
      commandFor: async () => "sleep 0.2",
      timeoutMs: 30_000,
      extraPath: async () => [],
    };
    const running = runBuiltInAgentCommand("demo", "update", deps);
    const refusal = await refuseAgentCommand("demo", "install", deps);
    expect(refusal?.message).toContain("already being updated");
    expect(refusal?.status).toBe(409);
    await running;
    // And the set drains: a second update after completion is allowed.
    expect(await refuseAgentCommand("demo", "update", deps)).toBeUndefined();
  });

  it("the default seam routes update to updateHint ?? install, non-built-ins to undefined", async () => {
    // defaultDeps is not exported; exercise it through the real commandFor shape:
    // an installed third-party id is NOT a built-in, so BOTH kinds refuse.
    const refusal = await refuseAgentCommand("definitely-not-a-built-in-plugin-id", "update");
    expect(refusal?.message).toContain("not a plugin this build carries");
  });
});
```

Add `AgentInstallKind`, `refuseAgentCommand`, `runBuiltInAgentCommand` to the file's existing import from `@/services/agent-install.service.js`.

- [ ] **Step 2: Run to verify they fail**

Run: `bun test apps/server/api/src/services/__tests__/agent-install.service.test.ts`
Expected: FAIL (the new exports do not exist; the test file fails to import).

- [ ] **Step 3: Implement**

In `apps/server/api/src/services/agent-install.service.ts`:

Add above `AgentInstallDeps`:

```ts
/** Which manifest command this run executes: the installer, or the vendor's updater. */
export type AgentInstallKind = "install" | "update";
```

Change the deps interface member:

```ts
  /** The command for a BUILT-IN id and kind, or undefined for an id this build does not carry. */
  commandFor: (id: string, kind: AgentInstallKind) => Promise<string | undefined>;
```

Change `defaultDeps.commandFor`:

```ts
const defaultDeps: AgentInstallDeps = {
  commandFor: async (id, kind) => {
    if (!(await builtInIds()).includes(id)) return undefined;
    const h = getHarness(id);
    if (!h) return undefined;
    // The fallback IS the update story for most vendors: their install
    // one-liner installs the latest, so a plugin that declares no `update`
    // re-runs what the Install button would.
    return kind === "update" ? (h.updateHint ?? h.installHint.command) : h.installHint.command;
  },
  timeoutMs: DEFAULT_TIMEOUT_MS,
  extraPath: loginPathEntries,
};
```

Rename `refuseInstall` → `refuseAgentCommand` with the kind parameter, then `installBuiltInAgent`'s body → `runBuiltInAgentCommand` with the kind parameter, and keep both install names as wrappers. Full replacement bodies (everything else in the two functions is unchanged, including the shared `inFlight` set and the `sh -c` run):

```ts
/** Past-tense verb for the "already running" sentence, per kind. */
const RUNNING_WORD: Record<AgentInstallKind, string> = { install: "installed", update: "updated" };

export async function refuseAgentCommand(
  id: string,
  kind: AgentInstallKind,
  deps: AgentInstallDeps = defaultDeps,
): Promise<AgentInstallRefused | undefined> {
  const command = await deps.commandFor(id, kind);
  if (command === undefined) return new AgentInstallRefused(`"${id}" is not a plugin this build carries`, 400);
  if (command.trim() === "") return new AgentInstallRefused(`"${id}" has nothing to ${kind}`, 400);
  if (inFlight.has(id))
    return new AgentInstallRefused(`"${id}" is already being ${RUNNING_WORD[kind]}`, 409);
  return undefined;
}

/** @deprecated spelling kept for the install route and the wizard tests; equals `refuseAgentCommand(id, "install")`. */
export async function refuseInstall(
  id: string,
  deps: AgentInstallDeps = defaultDeps,
): Promise<AgentInstallRefused | undefined> {
  return refuseAgentCommand(id, "install", deps);
}

export async function runBuiltInAgentCommand(
  id: string,
  kind: AgentInstallKind,
  deps: AgentInstallDeps = defaultDeps,
  onLine?: (line: string) => void,
): Promise<AgentInstallResult> {
  const command = await deps.commandFor(id, kind);
  if (command === undefined) throw new AgentInstallRefused(`"${id}" is not a plugin this build carries`, 400);
  if (command.trim() === "") throw new AgentInstallRefused(`"${id}" has nothing to ${kind}`, 400);
  if (inFlight.has(id)) throw new AgentInstallRefused(`"${id}" is already being ${RUNNING_WORD[kind]}`, 409);
  inFlight.add(id);
  try {
    // A plugin's install/update hint is a SHELL LINE (`curl … | bash`, or a
    // plain `claude update`), so it is run through `sh -c`.
    return await runInstaller(["sh", "-c", command], {
      timeoutMs: deps.timeoutMs,
      extraPath: deps.extraPath,
      onLine,
    });
  } finally {
    inFlight.delete(id);
  }
}

export async function installBuiltInAgent(
  id: string,
  deps: AgentInstallDeps = defaultDeps,
  onLine?: (line: string) => void,
): Promise<AgentInstallResult> {
  return runBuiltInAgentCommand(id, "install", deps, onLine);
}
```

Keep the original JSDoc blocks (move them onto the renamed functions, extending the sentence about what the kind means; `refuseInstall`/`installBuiltInAgent` wrappers get a one-line pointer JSDoc). Preserve the original refusal strings for the install kind exactly ("nothing to install", "already being installed", "not a plugin this build carries") because `setup-agent-install.route.test.ts` asserts them.

- [ ] **Step 4: Run tests (new and existing)**

Run: `bun test apps/server/api/src/services/__tests__/agent-install.service.test.ts apps/server/api/src/api/__tests__/setup-agent-install.route.test.ts`
Expected: PASS (route file still compiles against the wrapper names unchanged).

- [ ] **Step 5: Commit**

```bash
git add apps/server/api/src/services
git commit -m "feat(install): agent-command kinds with a shared per-id single flight"
```

---

### Task 4: `POST /api/setup/agents/:pluginId/update`

**Files:**
- Create: `apps/server/api/src/api/setup-agent-update.route.ts`
- Modify: `apps/server/api/src/api/routes.ts` (mount, after `.use(setupAgentInstallRoute)` at ~line 50)
- Modify: `.claude/rules/security-context.md` and `docs/security.md` §10 audit list (add `agent.update` beside `agent.install`)
- Test: `apps/server/api/src/api/__tests__/setup-agent-update.route.test.ts` (new), `setup-agent-install.route.test.ts` (unchanged, rerun)

**Interfaces:**
- Consumes: Task 3's `refuseAgentCommand` / `runBuiltInAgentCommand`, Task 2's `harnessInfo` payload.
- Produces: the endpoint Task 8's web card POSTs; audit action `agent.update` with metadata `{ok, exitCode, durationMs}`.

- [ ] **Step 1: Write the failing test**

Create `apps/server/api/src/api/__tests__/setup-agent-update.route.test.ts`. Copy the fixture machinery from `setup-agent-install.route.test.ts` VERBATIM (the app build, `bearerRequest`, `install()` helper renamed to `update(pluginId)` hitting `/api/setup/agents/${pluginId}/update`, `authedRequest`/`signIn` helpers, the audit reader renamed to `agentUpdateAudit` matching on `action === "agent.update"`), but import the seam + route from the new module:

```ts
import { setAgentUpdateDepsForTests, setupAgentUpdateRoute } from "@/api/setup-agent-update.route.js";

const app = new Elysia().use(errorHandlerPlugin).use(setupAgentUpdateRoute);
```

`setAgentUpdateDepsForTests` takes the SAME `AgentInstallDeps` type; use the same fake shape the install test uses. Cases to assert (each mirroring a case that exists in the install route's test; keep that file's auth helpers):

```ts
// 1. No session, users exist: 401/403 refusal, never public even with zero users —
//    setHasUsersProbeForTests(() => false) then expect the refusal anyway (same
//    first-run case the install file proves; a bearer token: 403).
// 2. Admin cookie, unknown id: 400 with a JSON ApiError body, content-type NOT
//    x-ndjson ("refusal is a status, not a frame").
expect(res.status).toBe(400);
expect(res.headers.get("content-type")).toContain("application/json");
// 3. Admin cookie, command empty after fallback: 400 containing "nothing to update".
// 4. Admin cookie, runnable command ("true"): 200, content-type x-ndjson, and the
//    stream ends with a done frame carrying ok:true and a harness row.
const frames = (await res.text()).trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
expect(frames.at(-1)).toMatchObject({ type: "done", ok: true, exitCode: 0 });
expect((frames.at(-1) as { harness: Record<string, unknown> }).harness.id).toBe("demo-harness-id");
// 5. Single flight shared with INSTALL: while an update runs (commandFor returns
//    "sleep 0.2"), an install POST for the same id answers 409 "already being updated".
// 6. Audit: exactly one `agent.update` row for the id, metadata carries ok:true,
//    and NO `agent.install` row was written by the update.
```

Replace `"demo-harness-id"` / the fake `commandFor` with whatever built-in id + shape the install test uses (it fakes a built-in id already; reuse it, and have `commandFor: async (_id, kind) => kind === "update" ? "true" : "sleep 99"` where a non-run value is wanted).

- [ ] **Step 2: Run to verify it fails**

Run: `bun test apps/server/api/src/api/__tests__/setup-agent-update.route.test.ts`
Expected: import fails (module missing).

- [ ] **Step 3: Implement the route**

Create `apps/server/api/src/api/setup-agent-update.route.ts`. It mirrors `setup-agent-install.route.ts` structure for structure (read it once as the template; keep its comment load in spirit, but the module doc names the differences). Full body:

```ts
import { BackendErrorCodes } from "@internal/backend-errors";
import { Elysia, t } from "elysia";
import { ForbiddenError } from "@/api/auth-guard.js";
import { harnessInfo } from "@/api/harness-utils.js";
import { resolveSetupActor } from "@/api/setup.route.js";
import { IS_TEST } from "@/constants.js";
import { apiErrorBody } from "@/lib/api-error.js";
import { resolveCookieSession } from "@/lib/session-cookie.js";
import { apiModels } from "@/schema/index.js";
import {
  type AgentInstallDeps,
  refuseAgentCommand,
  runBuiltInAgentCommand,
} from "@/services/agent-install.service.js";
import { audit } from "@/services/audit.js";
import { localPluginReports } from "@/services/nodes/local-plugins.js";

let depsOverride: AgentInstallDeps | undefined;

/**
 * Test seam, same discipline as `setAgentInstallDepsForTests`: refuses outside
 * the suite; a mis-wired production import must not be able to redirect what
 * this route runs on the host.
 * @internal
 */
export function setAgentUpdateDepsForTests(deps: AgentInstallDeps | null): void {
  if (!IS_TEST) throw new Error("setAgentUpdateDepsForTests is a test-only seam");
  depsOverride = deps ?? undefined;
}

/** Mirror of the install route's `codeForRefusalStatus` (see its comment). */
function codeForRefusalStatus(status: 400 | 409): BackendErrorCodes {
  return status === 409 ? BackendErrorCodes.EXISTS_ERROR : BackendErrorCodes.INPUT_VALIDATION_ERROR;
}

/**
 * `POST /api/setup/agents/:pluginId/update` (spec 2026-09-28 §2). The update
 * twin of the install route and bound by the same rules: admin COOKIE only,
 * built-in id allowlist, what-runs fixed by this repo, every 4xx decided
 * before the NDJSON body opens, single flight SHARED with install through the
 * id (one binary, one filesystem, one run at a time).
 *
 * The command is the plugin's manifest `update.command` when declared, else
 * a re-run of its install command; on an enrolled NODE nothing here can run
 * (the route acts on the control-plane host only, like install), which is why
 * the card shows a copy line, not a button, for agent nodes.
 */
export const setupAgentUpdateRoute = new Elysia({ prefix: "/api/setup/agents" }).use(apiModels).post(
  "/:pluginId/update",
  async ({ request, params, status }) => {
    if ((await resolveSetupActor(request)) !== "admin") throw new ForbiddenError();
    const refusal = await refuseAgentCommand(params.pluginId, "update", depsOverride);
    if (refusal) {
      return status(
        refusal.status,
        apiErrorBody({ code: codeForRefusalStatus(refusal.status), message: refusal.message }),
      );
    }

    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        /** One NDJSON frame; a gone reader must not throw into the run. */
        const send = (frame: unknown) => {
          try {
            controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
          } catch {
            // The page navigated. The update carries on; abandoning a binary
            // swap half-done is worse than finishing unobserved.
          }
        };
        try {
          const result = await runBuiltInAgentCommand(params.pluginId, "update", depsOverride, (line) =>
            send({ type: "line", text: line }),
          );
          const actor = await resolveCookieSession(request.headers.get("cookie") ?? "");
          await audit({
            actorUserId: actor?.user.id ?? null,
            action: "agent.update",
            targetType: "plugin",
            targetId: params.pluginId,
            metadataJson: JSON.stringify({ ok: result.ok, exitCode: result.exitCode, durationMs: result.durationMs }),
          });
          const installedHere = (await localPluginReports()).some((r) => r.id === params.pluginId && !r.broken);
          send({ type: "done", ...result, harness: await harnessInfo(params.pluginId, installedHere) });
        } catch (err) {
          send({ type: "error", message: err instanceof Error ? err.message : "The update failed." });
        } finally {
          controller.close();
        }
      },
    });
    return new Response(body, {
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store, no-transform",
        "x-accel-buffering": "no",
      },
    });
  },
  {
    params: t.Object({ pluginId: t.String({ description: "Built-in plugin id whose harness CLI to update" }) }),
    response: {
      400: "ApiErrorResponse",
      401: "ApiErrorResponse",
      403: "ApiErrorResponse",
      409: "ApiErrorResponse",
    },
    detail: {
      operationId: "updateSetupAgent",
      tags: ["setup"],
      description:
        "Runs the vendor update command of one built-in agent CLI on the control-plane host, as the server's own user (falling back to re-running its install command). Admin cookie only, never public, audited. STREAMS application/x-ndjson: a {type:line,text} per command line, then one terminal {type:done,...} with ok/exitCode/harness, or {type:error,message}.",
    },
  },
);
```

In `apps/server/api/src/api/routes.ts`, after `.use(setupAgentInstallRoute)`, add `.use(setupAgentUpdateRoute)` and the matching import (same style as the install route's import line).

Audit docs: in `.claude/rules/security-context.md`, the audit-names line for plugins/installers contains "`agent.install`, `tmux.install`": so it becomes "`agent.install`, `agent.update`, `tmux.install`". Do the same addition in `docs/security.md` §10 where `agent.install` is listed (grep it).

- [ ] **Step 4: Run tests**

Run: `bun test apps/server/api/src/api/__tests__/setup-agent-update.route.test.ts apps/server/api/src/api/__tests__/setup-agent-install.route.test.ts`
Expected: PASS both files.

- [ ] **Step 5: Commit**

```bash
git add apps/server/api/src/api .claude/rules/security-context.md docs/security.md
git commit -m "feat(setup): harness update route on the install rails, audited as agent.update"
```

---

### Task 5: `subshells.harness_version` column + compare-and-set repository write

**Files:**
- Create: `apps/server/api/src/db/migrations/0040-subshell-harness-version.ts`
- Modify: `apps/server/api/src/db/migrate.ts` (import + registry entry, following the 0039 lines at ~40/114)
- Modify: `apps/server/api/src/db/types/subshells.db-types.ts` (`SubshellTable` field; add `"harnessVersion"` to the `NewSubshell` Omit list at ~line 94)
- Modify: `apps/server/api/src/db/repositories/subshells.repository.ts` (mirror default in `create`; add `casHarnessVersion`)
- Test: `apps/server/api/src/db/repositories/__tests__/subshells-harness-version.repository.test.ts` (new)

**Interfaces:**
- Produces: `SubshellTable.harnessVersion: string | null`; `SubshellsRepository.casHarnessVersion(id: string, expected: string | null, value: string | null): Promise<boolean>`. Consumed by Tasks 6 and 7.

- [ ] **Step 1: Write the failing test**

Create `subshells-harness-version.repository.test.ts`. Copy the `freshDb()` helper VERBATIM from `__tests__/subshells-waiting.repository.test.ts` (its migration chain: 0001, 0003, 0014, 0016, 0017, 0019, 0027, 0039), adding the import and chain entry for `0040-subshell-harness-version`, and copy that file's raw `seed()` inserter verbatim (it inserts a minimal running row through `db as Kysely<any>`). Then:

```ts
describe("casHarnessVersion", () => {
  it("writes while the row is running and still carries the expected value", async () => {
    const db = await freshDb();
    await seed(db, "s1", null); // copied seeder: id, userId "u", presetId "p", harnessId "h", /tmp, running
    const repo = new SubshellsRepository(db);
    expect(await repo.casHarnessVersion("s1", null, "2.1.283")).toBe(true);
    expect((await repo.findById("s1"))?.harnessVersion).toBe("2.1.283");
  });

  it("a stale expected value loses the race and writes nothing", async () => {
    const db = await freshDb();
    await seed(db, "s1", null);
    const repo = new SubshellsRepository(db);
    expect(await repo.casHarnessVersion("s1", null, "283")).toBe(true);
    // A second writer that still believes the pre-283 value cannot land: a
    // launch's late stamp must never clobber a restart's fresh one.
    expect(await repo.casHarnessVersion("s1", null, "284")).toBe(false);
    expect((await repo.findById("s1"))?.harnessVersion).toBe("283");
    // And the true owner can still move it.
    expect(await repo.casHarnessVersion("s1", "283", "284")).toBe(true);
  });

  it("a terminated row is not stamped", async () => {
    const db = await freshDb();
    await seed(db, "s1", null);
    const repo = new SubshellsRepository(db);
    await repo.markTerminated("s1", new Date().toISOString());
    expect(await repo.casHarnessVersion("s1", null, "283")).toBe(false);
  });

  it("a seeded row reads back with an unknown (null) version", async () => {
    const db = await freshDb();
    await seed(db, "s1", null);
    expect((await new SubshellsRepository(db).findById("s1"))?.harnessVersion).toBeNull();
  });
});
```

The copied `seed()` writes through `db as Kysely<any>`, so it keeps compiling without the new column in its literal; `markTerminated` is the repository's existing retire path.

- [ ] **Step 2: Run to verify it fails**

Run: `bun test apps/server/api/src/db/repositories/__tests__/subshells-harness-version.repository.test.ts`
Expected: FAIL (migration/casHarnessVersion absent). File count in output must be 1.

- [ ] **Step 3: Implement**

`apps/server/api/src/db/migrations/0040-subshell-harness-version.ts`:

```ts
import type { Kysely } from "kysely";

/**
 * `harness_version`: the version of the harness CLI the pane's CURRENT process
 * started on, as stamped by the server after a successful launch (issue #250
 * Phase 1). Null means unknown, which is its own honest answer for rows that
 * predate the column, panes whose version probe found nothing, and every pane
 * until its first successful stamp lands.
 *
 * It follows the PROCESS, not the row: a restart overwrites it with the
 * version the new process started on. Nothing here is a claim about the node
 * (the node's current version is the inventory's job); the comparison between
 * the two is derived at read time and stored nowhere.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("subshells").addColumn("harness_version", "text").execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("subshells").dropColumn("harness_version").execute();
}
```

`apps/server/api/src/db/migrate.ts`: add next to the 0039 lines:

```ts
import * as subshellHarnessVersionMigration from "@/db/migrations/0040-subshell-harness-version.js";
```

and in the migration map, after `"0039-subshell-cross-agent"`:

```ts
          "0040-subshell-harness-version": subshellHarnessVersionMigration,
```

`db/types/subshells.db-types.ts`, in `SubshellTable` beside `harnessId`:

```ts
  /**
   * Harness CLI version this pane's current process started on (null =
   * unknown). Written only by the post-launch stamp (compare-and-set), and
   * overwritten by every restart: it describes the running process.
   */
  harnessVersion: string | null;
```

and in the `NewSubshell` Omit union add a line `"harnessVersion" |`.

`db/repositories/subshells.repository.ts`: in `create`'s values, next to the other mirrored defaults:

```ts
        // The launch stamp lands after a SUCCESSFUL spawn (spec 2026-09-28 §3);
        // at insert the process has not started, so the honest value is null.
        harnessVersion: null,
```

and as a new method on the class:

```ts
  /**
   * Compare-and-set `harness_version`: the write lands only while the row is
   * `running` and still carries `expected`. That guard is the whole contract:
   * a create's late stamp must never clobber a restart's fresh one, and a
   * terminated row gets no stamp at all.
   * @returns true when this writer won (exactly one caller ever does per value)
   */
  async casHarnessVersion(id: string, expected: string | null, value: string | null): Promise<boolean> {
    const res = await this.db
      .updateTable("subshells")
      .set({ harnessVersion: value })
      .where("id", "=", id)
      .where("status", "=", "running")
      // SQLite `IS` compares nulls equal, which `=` never does: `expected` is
      // null on the create path, and the create path is the common one.
      .where("harnessVersion", "is", expected)
      .executeTakeFirst();
    return (res?.numUpdatedRows ?? 0n) > 0n;
  }
```

- [ ] **Step 4: Run tests**

Run: `bun test apps/server/api/src/db/repositories/__tests__/subshells-harness-version.repository.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/api/src/db
git commit -m "feat(db): subshells.harness_version with a compare-and-set stamp"
```

---

### Task 6: stamp the version on every successful launch (and re-stamp after remote launches)

**Files:**
- Modify: `apps/server/api/src/services/nodes/node-launcher.ts` (interface + doc)
- Modify: `apps/server/api/src/services/nodes/local-launcher.ts`
- Modify: `apps/server/api/src/services/nodes/remote-launcher.ts`
- Modify: `apps/server/api/src/services/nodes/inventory.ts` (`DetectOnNodeDeps.reStamp`, applied in `detectOnNode`)
- Modify: `apps/server/api/src/services/subshell-manager.service.ts` (new `#stampHarnessVersion`; call after `launcher.launch(...)` succeeds in `createSubshell` (~line 453) and in `#reviveRow` after its launch (~line 1215))
- Test: `apps/server/api/src/services/nodes/__tests__/inventory-detect.test.ts`, `apps/server/api/src/services/nodes/__tests__/remote-launcher.test.ts`, `apps/server/api/src/services/nodes/__tests__/local-launcher.test.ts`, and the manager's create/restart test file (`__tests__/subshell-manager*`; read `ls apps/server/api/src/services/__tests__ | grep -i manager` and extend the file that already fakes a launcher)

**Interfaces:**
- Consumes: Task 5's `casHarnessVersion`.
- Produces on the `NodeLauncher` seam: `launchedHarnessVersion(harness: HarnessPlugin, binary: string | null): Promise<string | null>` and `kickHarnessVersionRefresh(subshellId: string, expected: string | null): void`; `detectOnNodeBestEffort(nodeId: string, opts?: { reStamp?: { subshellId: string; expected: string | null } }): void`. Consumed by Task 7 (which reads the stamped column into views).

- [ ] **Step 1: Write the failing tests**

(a) `inventory-detect.test.ts` (it already drives `detectOnNode` with a fake `send` seam): add a case that pre-creates a running subshell row (its `harnessVersion` pre-stamped `null` via repository, like the repo test does), runs `detectOnNode` with `deps.reStamp = { subshellId: id, expected: null }` and a fake answer carrying `rawVersion` for that harness, and asserts the row now holds the parsed version; plus the negative: a reStamp whose `expected` no longer matches writes nothing.

```ts
it("re-stamps the one pane that kicked the detect, and only while its stamp still matches", async () => {
  // Arrange a running row with harnessVersion null; the fake `send` answers
  // one detect row { harnessId, installed: true, binaryPath: "/x/claude",
  // rawVersion: "2.1.284" }.
  await detectOnNode(NODE_ID, { send: fakeSend, reStamp: { subshellId, expected: null } });
  expect((await subshells.findById(subshellId))?.harnessVersion).toBe("2.1.284");
  // A second reStamp still expecting null now misses (the row holds 284):
  await detectOnNode(NODE_ID, { send: fakeSend, reStamp: { subshellId, expected: null } });
  expect((await subshells.findById(subshellId))?.harnessVersion).toBe("2.1.284");
});
```

(b) `remote-launcher.test.ts`: a case for `launchedHarnessVersion` reading the version off the node's cached inventory row (seed `nodes.inventory_json` the way the file's existing resolveBinary-from-inventory cases seed `binaryPath`), returning `null` with no entry; and a case that `kickHarnessVersionRefresh` calls the injected `deps.detect` seam (extend the seam's recorded call args to carry the second argument and assert `reStamp` rode through).

(c) `local-launcher.test.ts`: `launchedHarnessVersion(harness, "/p/bin")` calls `versionAt` (fake harness); `(harness, null)` resolves null; `kickHarnessVersionRefresh` is a no-op that does not throw.

(d) Manager create-path test (the file that fake-launches): after a successful create with a fake launcher whose `launchedHarnessVersion` resolves `"2.1.283"`, assert the row reads `"2.1.283"` and `kickHarnessVersionRefresh` received `(id, "2.1.283")`; with a fake launcher that resolves null, the row stays null.

- [ ] **Step 2: Run to verify they fail**

Run each of the four test files above (exact paths from the Files list).
Expected: FAIL (missing interface members / no stamping).

- [ ] **Step 3: Implement**

`node-launcher.ts`, in the `NodeLauncher` interface after `resolveBinary`:

```ts
  /**
   * The version string to stamp the row with after a successful launch
   * (spec 2026-09-28 §3). `local` PROBES the binary it just used (exact);
   * the remote launcher answers from the node's cached inventory, which is
   * the same snapshot the launch's binary resolution believed in. Null means
   * "unknown" and the row says so.
   */
  launchedHarnessVersion(harness: HarnessPlugin, binary: string | null): Promise<string | null>;
  /**
   * After a stamp lands, ask the node to re-detect and re-stamp THIS pane
   * once (no-op on `local`, whose stamp came from a live probe). `expected`
   * is the value just written: the re-stamp is compare-and-set against it,
   * so a restart that has since re-stamped the row is never laundered.
   */
  kickHarnessVersionRefresh(subshellId: string, expected: string | null): void;
```

`local-launcher.ts`:

```ts
  /** Probes the resolved binary; null when there is no path to probe. */
  async launchedHarnessVersion(harness: HarnessPlugin, binary: string | null): Promise<string | null> {
    return binary ? harness.versionAt(binary) : null;
  }

  /** `local` stamped from a live probe; there is nothing fresher to ask. */
  kickHarnessVersionRefresh(): void {}
```

`remote-launcher.ts` (uses the file's existing `#deps.nodes ?? getRequestlessContext().repos.nodes` pattern and `readAgentInventory`; `detectOnNodeBestEffort` is already imported for `#kickDetect`):

```ts
  /** The version the cached inventory says this harness holds; null with no entry. */
  async launchedHarnessVersion(harness: HarnessPlugin): Promise<string | null> {
    const nodes = this.#deps.nodes ?? getRequestlessContext().repos.nodes;
    const node = await nodes.findById(this.#nodeId);
    if (!node) return null;
    return readAgentInventory(node).entries.get(harness.id)?.version ?? null;
  }

  /**
   * One scoped detect kick after a remote launch (spec §3): the cached entry
   * can predate a manual update by up to the TTL, so a pane born seconds after
   * one is born with a stale-looking stamp. The re-stamp rides the SAME detect
   * driver as every other kick, compare-and-set guarded so only THIS pane and
   * only its just-written value are touched.
   */
  kickHarnessVersionRefresh(subshellId: string, expected: string | null): void {
    try {
      (this.#deps.detect ?? detectOnNodeBestEffort)(this.#nodeId, { reStamp: { subshellId, expected } });
    } catch (err: unknown) {
      logger.withError(err).debug(`node ${this.#nodeId}: version re-stamp kick failed`);
    }
  }
```

Widen the `detect` seam type on the deps interface if it is declared as `typeof detectOnNodeBestEffort`-shaped with one parameter.

`inventory.ts`: in `DetectOnNodeDeps`, add:

```ts
  /**
   * Re-stamp ONE pane with the version this answer reports (spec 2026-09-28
   * §3): the pane that kicked the detect after its launch, and the stamp
   * value that launch wrote (the compare-and-set expectation). Absent for
   * every other caller. @internal paired with `RemoteLauncher.kickHarnessVersionRefresh`.
   */
  reStamp?: { subshellId: string; expected: string | null };
```

At the END of `detectOnNode`, after the env stash, add:

```ts
  // The scoped re-stamp (spec §3): only the pane that kicked, only while its
  // just-written stamp still matches, and only a POSITIVE fresh answer. A
  // missing entry, an `installed: false`, or a version-less probe leaves the
  // launch stamp standing: this pass corrects staleness, it never erases.
  if (deps.reStamp) {
    try {
      const subshells = new SubshellsRepository(db);
      const pane = await subshells.findById(deps.reStamp.subshellId);
      const entry = pane ? merged.get(pane.harnessId) : undefined;
      if (pane && pane.status === "running" && entry?.installed && entry.version) {
        await subshells.casHarnessVersion(pane.id, deps.reStamp.expected, entry.version);
      }
    } catch (err: unknown) {
      logger.withError(err).debug(`node ${nodeId}: harness version re-stamp failed`);
    }
  }
```

Import `SubshellsRepository` (the file already imports `NodesRepository` and `db`; add `logger` if absent (it uses debug lines already via detectOnNodeBestEffort, which lives in the same file).. Change `detectOnNodeBestEffort` signature:

```ts
export function detectOnNodeBestEffort(
  nodeId: string,
  opts: { reStamp?: DetectOnNodeDeps["reStamp"] } = {},
): void {
  void detectOnNode(nodeId, opts).catch((err: unknown) => {
```

`subshell-manager.service.ts`: add the helper near the other private helpers:

```ts
  /**
   * Records the harness version the just-launched process started on
   * (spec 2026-09-28 §3). Compare-and-set against the row's pre-launch value,
   * so a racing restart always wins; when this writer lands, it hands off the
   * scoped re-stamp kick (a no-op on `local`). Failures are debug-only: the
   * pane is RUNNING and correct; a missing annotation is never a launch
   * failure.
   */
  async #stampHarnessVersion(
    row: SubshellTable,
    launcher: NodeLauncher,
    harness: HarnessPlugin,
    binary: string | null,
  ): Promise<void> {
    try {
      const before = row.harnessVersion ?? null;
      const stamp = await launcher.launchedHarnessVersion(harness, binary);
      if (await this.#subshells.casHarnessVersion(row.id, before, stamp)) {
        launcher.kickHarnessVersionRefresh(row.id, stamp);
        publishLive({ kind: "subshell.changed", id: row.id });
      }
    } catch (err: unknown) {
      logger.withError(err).debug(`subshell ${row.id}: harness version stamp failed`);
    }
  }
```

Call it in `createSubshell` immediately after `await launcher.launch({ ... })` succeeds (before the prompt delivery), using the row returned by `this.#subshells.create(...)`:

```ts
      await this.#stampHarnessVersion(row, launcher, harness, binary);
```

and in `#reviveRow` after its `await launcher.launch({...})` succeeds, with the same argument sources in that scope (the parked row variable, the launcher, the harness, the resolved binary variable name as it exists there). If `createSubshell`'s created-row variable is not currently bound to a name (the insert result is discarded today), bind it: `const row = await this.#subshells.create({...});`.

- [ ] **Step 4: Run tests**

Run the four touched test files, plus `bun test apps/server/api/src/services/__tests__` (manager suite neighborhood) once green.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/api/src/services
git commit -m "feat(subshells): stamp the harness version each pane launches on, restamped after remote detect"
```

---

### Task 7: staleness derived server-side (local snapshot + view fields)

**Files:**
- Modify: `apps/server/api/src/services/nodes/inventory.ts` (`recordLocalInventorySnapshot`)
- Modify: `apps/server/api/src/services/nodes/inventory-refresh.ts` (schedule it beside the agent pass)
- Modify: `apps/server/api/src/services/subshell-manager.service.ts` (`#harnessVersionMaps`, wire into `toViews` and `getSubshell`; `toSubshellView` gains fields + one param)
- Modify: `apps/server/api/src/api/models.ts` (`SubshellSchema`)
- Test: `apps/server/api/src/services/nodes/__tests__/inventory-refresh.test.ts`, `apps/server/api/src/services/nodes/__tests__/inventory.test.ts` (snapshot writer), the manager view test file (`__tests__/subshell-manager-view.test.ts` if present, else the file that already tests `toSubshellView` output)

**Interfaces:**
- Consumes: Task 5's column, Task 6's stamps, `readAgentInventory`.
- Produces: view fields `harnessVersion: string | null`, `harnessCurrentVersion: string | null`, `harnessStale: boolean` on `SubshellSchema`; `recordLocalInventorySnapshot(): Promise<void>`; `InventoryRefreshDeps.detectLocal(): () => Promise<void>` seam. Consumed by Tasks 8-9 (web renders them).

- [ ] **Step 1: Write the failing tests**

(a) `inventory.test.ts`: `recordLocalInventorySnapshot()` (run against scratch state the way the file already fakes plugin catalogs / probes) writes the local node's `inventory_json` through `applyInventory` and the stored JSON parses to the probed entries.

(b) `inventory-refresh.test.ts` (the file already fakes `online/detect/schedule`): the armed tick also calls the new `detectLocal` seam once per pass.

(c) View derivation (the manager-view file): build rows/views with `toSubshellView` directly; the function is exported:

```ts
it("stale only when stamp and current are both known and differ", () => {
  const versions = new Map([["claude-code", "2.1.284"]]);
  const base = { /* copy the file's existing minimal row literal */ };
  const stale = toSubshellView({ ...base, harnessVersion: "2.1.283" }, "running", [], "owner", false, versions);
  expect(stale.harnessStale).toBe(true);
  expect(stale.harnessVersion).toBe("2.1.283");
  expect(stale.harnessCurrentVersion).toBe("2.1.284");
  expect(toSubshellView({ ...base, harnessVersion: null }, "running", [], "owner", false, versions).harnessStale).toBe(false);
  expect(toSubshellView({ ...base, harnessVersion: "2.1.283" }, "running", [], "owner", false, new Map()).harnessStale).toBe(false);
  const same = toSubshellView({ ...base, harnessVersion: "2.1.284" }, "running", [], "owner", false, versions);
  expect(same.harnessStale).toBe(false);
  expect(same.harnessCurrentVersion).toBe("2.1.284");
});
```

(Read the file's existing call of `toSubshellView` to match its argument style; new params are optional so existing calls keep compiling and read `harnessStale: false`.)

- [ ] **Step 2: Run to verify they fail**

Run the three test files. Expected: FAIL.

- [ ] **Step 3: Implement**

`inventory.ts`, appended near `detectOnNodeBestEffort`:

```ts
/**
 * Probe THIS host's harnesses and store the answer in the local node's
 * `inventory_json` (spec 2026-09-28 §4). The local node's own VIEWS keep
 * probing live (`effectiveHarnessStates` never reads this column for local);
 * the snapshot exists so the cheap per-read question a pane asks, "what does
 * this node's harness hold now?", has a stored answer at all. Freshness
 * matches the agent pass: one probe per refresh cycle.
 */
export async function recordLocalInventorySnapshot(): Promise<void> {
  const catalog = await enabledHarnessPlugins();
  const probe = await probeLocally(catalog);
  await new NodesRepository(db).applyInventory(LOCAL_NODE_ID, JSON.stringify([...probe.entries.values()]));
}
```

(Add the `LOCAL_NODE_ID` import if absent.)

`inventory-refresh.ts`: extend the seam interface and defaults, and the timer body:

```ts
export interface InventoryRefreshDeps {
  online(): string[];
  detect(nodeId: string): void;
  /** The control-plane host's own snapshot pass. Production: {@link recordLocalInventorySnapshot}. */
  detectLocal(): Promise<void>;
  schedule(tick: () => void, everyMs: number): { stop(): void };
}

const defaultDeps: InventoryRefreshDeps = {
  online: listOnline,
  detect: detectOnNodeBestEffort,
  detectLocal: recordLocalInventorySnapshot,
  schedule: (tick, everyMs) => {
    const timer = setInterval(tick, everyMs);
    timer.unref?.();
    return { stop: () => clearInterval(timer) };
  },
};
```

In `startInventoryRefresh`'s scheduled callback, after the agent pass try/catch, add:

```ts
    // The host's own snapshot rides the same cadence: a pane asking "is my
    // node's harness newer now?" deserves an answer at least as fresh on the
    // machine the plane CAN probe as on one it has to ask.
    void deps()
      .detectLocal()
      .catch((err: unknown) => {
        logger.withError(err).debug("local harness inventory snapshot failed; the last one stands");
      });
```

(Import `recordLocalInventorySnapshot`. `refreshOnlineNodeInventories` itself stays synchronous and untouched.)

`subshell-manager.service.ts`, in `toSubshellView`: add to the row parameter type `harnessVersion?: string | null;` and to the signature (after `nodeOffline = false`):

```ts
  /**
   * The node's CURRENT harness versions (harnessId to version), from its
   * inventory snapshot. Absent map = nothing known, which is every unknown
   * reading this function returns: never a stale claim, only ever a fact.
   */
  nodeHarnessVersions?: ReadonlyMap<string, string>,
```

and in the returned object (next to `harnessId`):

```ts
    // issue #250: the version this pane's process started on, the version the
    // node now reports, and the ONE derived comparison between them. Clients
    // render; none of them decides. Two nulls are an absence, not a
    // disagreement, so an unprobed pair never raises the flag.
    harnessVersion: row.harnessVersion ?? null,
    harnessCurrentVersion,
    harnessStale: row.harnessVersion != null && harnessCurrentVersion != null && row.harnessVersion !== harnessCurrentVersion,
```

with `const harnessCurrentVersion = nodeHarnessVersions?.get(row.harnessId) ?? null;` computed at the top of the return expression's enclosing function body.

Add the map builder + wiring to the manager class:

```ts
  /** Current-version snapshots for every node the given rows live on, one read per distinct node. */
  async #harnessVersionMaps(rows: { nodeId: string }[]): Promise<Map<string, ReadonlyMap<string, string>>> {
    const out = new Map<string, ReadonlyMap<string, string>>();
    for (const nodeId of new Set(rows.map((r) => r.nodeId))) {
      if (out.has(nodeId)) continue;
      try {
        const node = await new NodesRepository(db).findById(nodeId);
        if (!node) {
          out.set(nodeId, new Map());
          continue;
        }
        const m = new Map<string, string>();
        for (const [harnessId, entry] of readAgentInventory(node).entries) {
          if (entry.installed && entry.version) m.set(harnessId, entry.version);
        }
        out.set(nodeId, m);
      } catch {
        // A snapshot read is a decoration: unknown is fine, a crashed list is not.
        out.set(nodeId, new Map());
      }
    }
    return out;
  }
```

In `toViews`, before the per-row loop: `const versions = await this.#harnessVersionMaps(rows);` and pass `versions.get(row.nodeId)` as the new final `toSubshellView` argument. In `getSubshell` (single row): compute `await this.#harnessVersionMaps([row])` and pass the same way. Import `readAgentInventory` and `NodesRepository`/`db` if the manager does not already hold them (check `grep -n "NodesRepository\|readAgentInventory" services/subshell-manager.service.ts`).

`api/models.ts`, in `SubshellSchema` next to `harnessId`:

```ts
  harnessVersion: t.Union([t.String({ description: "Harness CLI version this pane's current process started on (null = unknown)" }), t.Null()]),
  harnessCurrentVersion: t.Union([t.String({ description: "The node's current inventory version for this pane's harness (null = unknown)" }), t.Null()]),
  harnessStale: t.Boolean({
    description:
      "True when the pane started on a different harness version than the node now reports; the operator's existing Restart (which resumes) is the remedy",
  }),
```

- [ ] **Step 4: Run tests + rebuild the client types**

```bash
bun test apps/server/api/src/services/nodes/__tests__/inventory-refresh.test.ts apps/server/api/src/services/nodes/__tests__/inventory.test.ts apps/server/api/src/services/__tests__
bunx turbo build --filter=@internal/backend-client
```
Expected: PASS; the Eden client re-infers the new view fields from the rebuilt backend types.

- [ ] **Step 5: Commit**

```bash
git add apps/server/api/src
git commit -m "feat(subshells): server-derived stale-harness flag on the view"
```

---

### Task 8: web node card, Update button on `local`, copy line on enrolled nodes

**Files:**
- Modify: `apps/server/web/src/hooks/use-install-agent.ts` (generalize the stream mutation; keep `useInstallAgent` working)
- Modify: `apps/server/web/src/types/harness.ts` (`HarnessInfo.update?: string`)
- Modify: `apps/server/web/src/components/nodes/node-harness-card.tsx`
- Test: `apps/server/web/src/hooks/__tests__/use-install-agent.test.ts` (exists; keep green); plus new assertions only if the file already tests the fetch URL (read it; `readInstallStream` unit tests are unaffected).

**Interfaces:**
- Consumes: Task 2's `HarnessInfo.update` (in the JSON), Task 4's update endpoint.
- Produces: `export type AgentCommandKind = "install" | "update"`, `useAgentCommand(kind, onLine)` (mutation on `id`), `useInstallAgent` unchanged signature.

- [ ] **Step 1: Generalize the hook**

In `apps/server/web/src/hooks/use-install-agent.ts`, replace `useInstallAgent` with (everything else in the file, `readInstallStream` included, is unchanged):

```ts
/** Which built-in-agent command a stream runs: the installer or the vendor's updater. */
export type AgentCommandKind = "install" | "update";

/**
 * Runs one built-in agent command on the control-plane host (admin only),
 * streaming its output; shared by the Install and Update buttons, which post
 * to `/{kind}` and read the same frame protocol `readInstallStream` exists for.
 */
export function useAgentCommand(kind: AgentCommandKind, onLine?: (id: string, line: string) => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string): Promise<AgentInstallResult> => {
      let res: Response;
      try {
        res = await fetch(`/api/setup/agents/${id}/${kind}`, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
        });
      } catch (err) {
        throw new NetworkError(err);
      }
      if (!res.ok) {
        const { message, code, errId } = parseErrorBody(await res.text().catch(() => ""));
        throw new ApiError(res.status, message, { code, errId });
      }
      if (!res.body) throw new ApiError(res.status, "The server sent no output.");
      return await readInstallStream(res.body, (line) => onLine?.(id, line));
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: HARNESS_QUERY_KEY }),
  });
}

/** The install spelling every existing caller keeps. */
export function useInstallAgent(onLine?: (id: string, line: string) => void) {
  return useAgentCommand("install", onLine);
}
```

(`"The server sent no output."` replaces `"The server sent no install output."`; if the hook test asserts the old sentence, update the assertion to the new one in the same edit.)

- [ ] **Step 2: Harness type**

`apps/server/web/src/types/harness.ts`, in `HarnessInfo`, after `install:`:

```ts
  /** Vendor self-update command; when absent, updating re-runs `install.command` */
  update?: string;
```

- [ ] **Step 3: Card changes**

In `node-harness-card.tsx`:

(a) Imports: replace `import { useInstallAgent } from "@/hooks/use-install-agent";` with:

```ts
import { type AgentCommandKind, type AgentInstallResult, useAgentCommand } from "@/hooks/use-install-agent";
```

(b) Module-level helpers, next to `installableHere`:

```ts
/**
 * The command an Update affordance would run for this plugin: the vendor's
 * own if declared, else a re-run of the installer, exactly the service's
 * fallback. Undefined when neither exists (terminal): no button, no copy
 * line, mirroring the route's own "nothing to update" refusal.
 */
function updateCommandFor(info: HarnessInfo | undefined): string | undefined {
  if (!info || info.type !== "agent-harness") return undefined;
  const cmd = info.update ?? info.install.command;
  return cmd.trim() !== "" ? cmd : undefined;
}

/** A run that RAN and said no: it either never started or exited non-zero. */
function runFailure(data: AgentInstallResult): { message: string; output: string } {
  return {
    message:
      data.exitCode === null
        ? "The command could not be started."
        : `The command exited with code ${data.exitCode}.`,
    output: data.output,
  };
}
```

(c) Replace the component's install wiring (the block from `/** The installer's latest line, per plugin id … */` through the `const installFailure = …` derivation, i.e. current lines ~123-167) with:

```ts
  /** The running command's own line, keyed `kind:id`. */
  const [cmdLines, setCmdLines] = useState<Record<string, string>>({});
  // A blank line is spacing in a command's output, not progress; showing one
  // would blank the only thing on screen that is saying anything. (Same rule
  // the install button had; it now serves both kinds.)
  const noteLine = (kind: AgentCommandKind) => (id: string, line: string) => {
    if (line.trim() !== "") setCmdLines((prev) => ({ ...prev, [`${kind}:${id}`]: line }));
  };
  const install = useAgentCommand("install", noteLine("install"));
  const update = useAgentCommand("update", noteLine("update"));
  /** Whichever command is running, so exactly one row spins. */
  const active = install.isPending
    ? { kind: "install" as const, id: install.variables }
    : update.isPending
      ? { kind: "update" as const, id: update.variables }
      : undefined;
  /**
   * Why the last command did not work, under whichever row ran it. The two
   * different failures said differently, as before: the CALL failing is
   * `.error`, while a command that RAN and exited non-zero is `data.ok:false`
   * carrying its own output.
   */
  const failure: { id: string; kind: AgentCommandKind; message: string; output?: string } | undefined =
    install.error && install.variables
      ? { id: install.variables, kind: "install" as const, message: errMessage(install.error, "Couldn't run the installer.") }
      : update.error && update.variables
        ? { id: update.variables, kind: "update" as const, message: errMessage(update.error, "Couldn't run the updater.") }
        : install.data && !install.data.ok && install.variables
          ? { id: install.variables, kind: "install" as const, ...runFailure(install.data) }
          : update.data && !update.data.ok && update.variables
            ? { id: update.variables, kind: "update" as const, ...runFailure(update.data) }
            : undefined;
```

If the file's `AgentInstallResult` is not exported from the hook module yet, export it there in the same edit (it already is).

(d) Row body: inside `harnesses.map`, directly after the existing `offerInstall` line:

```ts
            const cmdText = updateCommandFor(info);
            // Update is for a program that IS here (unlike Install, which is
            // for one that is not); gate-mirrored like install: local + admin.
            const offerUpdate = h.installed && canInstallHere && cmdText !== undefined;
            // The honest half on a node the server cannot drive: the exact
            // command to run there, printed, never run (spec 2026-09-28 §2;
            // Phase 2 turns this line into a button via a signed command).
            const showCopyLine = h.installed && data?.kind === "agent" && cmdText !== undefined;
```

(e) Action cell: extend the existing Install conditional so the cell renders Install (missing program) or Update (ready program), each disabled while ANY command runs (the server's per-id single flight answers a second press 409; a press that can only fail is worse than a disabled one):

```tsx
                {offerInstall && info ? (
                  <Button
                    type="button"
                    size="sm"
                    disabled={active !== undefined}
                    onClick={() => install.mutate(h.harnessId)}
                  >
                    {active?.kind === "install" && active.id === h.harnessId && (
                      <LoaderCircle aria-hidden className="motion-safe:animate-spin" />
                    )}
                    {active?.kind === "install" && active.id === h.harnessId ? "Installing…" : "Install"}
                  </Button>
                ) : offerUpdate && cmdText !== undefined ? (
                  <Button
                    type="button"
                    size="sm"
                    disabled={active !== undefined}
                    onClick={() => update.mutate(h.harnessId)}
                  >
                    {active?.kind === "update" && active.id === h.harnessId && (
                      <LoaderCircle aria-hidden className="motion-safe:animate-spin" />
                    )}
                    {active?.kind === "update" && active.id === h.harnessId ? "Updating…" : "Update"}
                  </Button>
                ) : (
                  <span aria-hidden />
                )}
```

(f) Statement lines: keep the existing `offerInstall` "Runs …" line untouched; add its update twin plus the enrolled copy line immediately after it:

```tsx
                {offerUpdate && cmdText !== undefined && (
                  <p className="col-span-full text-detail text-muted-foreground">
                    Runs <code className="font-mono">{cmdText}</code> on this machine, as the user the server runs as.
                  </p>
                )}
                {showCopyLine && cmdText !== undefined && (
                  <p className="col-span-full text-detail text-muted-foreground">
                    Run <code className="font-mono">{cmdText}</code> on this machine. The server can't do it on a node
                    yet.
                  </p>
                )}
```

(g) Streaming and failure blocks: replace the existing two per-row blocks (`installingId === h.harnessId && …` and `settledId === h.harnessId && installFailure && …`) with the kind-aware twins:

```tsx
                {active?.id === h.harnessId && (
                  // The command's own words, one line, verbatim (unchanged rule):
                  // there is no percentage to derive from `curl … | bash`.
                  <p aria-live="polite" className="col-span-full truncate font-mono text-detail text-muted-foreground">
                    {cmdLines[`${active.kind}:${h.harnessId}`] ??
                      (active.kind === "update" ? "Running the update…" : "Starting the installer…")}
                  </p>
                )}
                {failure?.id === h.harnessId && (
                  <div className="col-span-full space-y-1">
                    <p className="text-destructive text-detail">{failure.message}</p>
                    {failure.output !== undefined && failure.output.trim() !== "" && (
                      <details className="text-sm">
                        <summary className="cursor-pointer text-detail text-muted-foreground">
                          What the command printed
                        </summary>
                        <pre className="mt-1 max-h-48 overflow-auto text-detail">{failure.output}</pre>
                      </details>
                    )}
                  </div>
                )}
```

Delete the now-unused `installLines`/`installingId`/`settledId`/`installFailure` identifiers and the `useInstallAgent` import (the wizard keeps its own import site untouched). Update the `NodeHarnessCard` doc comment to say, in two sentences, that a ready row on `local` also offers Update (vendor command, installer re-run as fallback) and an enrolled node shows the command as a copy line instead.

- [ ] **Step 4: Verify**

```bash
bun test apps/server/web/src/hooks/__tests__/use-install-agent.test.ts
bunx turbo verify-types --filter=<the apps/server/web package name from its package.json>
bun run lint:check apps/server/web
```
Expected: PASS. (Component has no test file; its logic mirrors server-side gates already tested.)

- [ ] **Step 5: Commit**

```bash
git add apps/server/web/src
git commit -m "feat(web): harness Update button on the control-plane host, copy line on nodes"
```

---

### Task 9: stale-harness line on the subshell card

**Files:**
- Modify: `apps/server/web/src/types/subshell.ts` (mirror the three view fields)
- Modify: `apps/server/web/src/components/subshell-card.tsx` (one detail line)

**Interfaces:**
- Consumes: Task 7's `harnessVersion` / `harnessCurrentVersion` / `harnessStale`.

- [ ] **Step 1: Type mirror**

`apps/server/web/src/types/subshell.ts`, beside `harnessId` (match the file's comment density):

```ts
  /** Harness CLI version this pane's process started on; null = unknown */
  harnessVersion: string | null;
  /** The node's current inventory version for this pane's harness; null = unknown */
  harnessCurrentVersion: string | null;
  /** Server-derived: started on a different harness version than the node now reports */
  harnessStale: boolean;
```

- [ ] **Step 2: Render**

`apps/server/web/src/components/subshell-card.tsx`: where `const nodeOffline = …` is defined (~line 39), add:

```ts
  // One fact, already derived server-side: this pane is running an older
  // harness than its node now has. Restart (which resumes) is the remedy.
  const staleHarness = subshell.harnessStale && subshell.status === "running";
```

Immediately after the `workingDir` `<p>` (~line 54), add:

```tsx
      {staleHarness && subshell.harnessVersion && subshell.harnessCurrentVersion && (
        <p className="truncate text-detail text-muted-foreground">
          Harness {subshell.harnessVersion} · node now on {subshell.harnessCurrentVersion}
        </p>
      )}
```

- [ ] **Step 3: Verify**

```bash
bunx turbo verify-types --filter=<the apps/server/web package name>
bun run lint:check apps/server/web
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/server/web/src
git commit -m "feat(web): stale-harness detail line on the subshell card"
```

---

### Task 10: changeset, docs, full verification at the boundary

**Files:**
- Create: `.changeset/harness-updates.md`
- Modify: `apps/server/api/docs/self-management.md` (one line in the inventory-refresh description: the pass now also stores a local snapshot the pane-side stale flag reads)

**Interfaces:**
- Consumes: everything above.
- Produces: a release-ready PR.

- [ ] **Step 1: Changeset with the workspace names that actually changed**

```bash
grep -H '"name"' packages/plugin-api/package.json packages/pane-runtime/package.json packages/plugins/claude-code/package.json apps/server/api/package.json apps/server/web/package.json
```

Write `.changeset/harness-updates.md` using those exact names (one `minor:` per changed workspace package; the format is the standard changeset front-matter the released changesets in git history used, e.g. `git show 3c0313a8:.changeset/pane-mode-mirror-and-renderer-suggestion.md` shows a shipped one). Body text:

```md
Harness updates: an Update button for harness CLIs on the control-plane host (vendor command where one exists, re-run installer otherwise), the harness version each pane launched on recorded per subshell, and a stale-harness line on the card when the node has moved on. Restart resumes, as before.
```

- [ ] **Step 2: Docs line**

In `apps/server/api/docs/self-management.md`, in the paragraph describing the periodic inventory refresh, append one sentence: the pass also probes the control-plane host itself into the local node's inventory snapshot, which is what the pane-side stale flag compares against (the local node's own views still probe live).

- [ ] **Step 3: Full boundary verification**

```bash
bun run verify-types
bun run lint:check
bun run lint:prose
bun run test
bunx turbo build
```

Expected: all green, with the FILE COUNTS in the test output including every new test file (bun silently skips paths that do not exist). `rust:check` and `test:cli` are not required (no Rust, no CLI verb changed). If a failure traces to a stale build of a `packages/` dependency, run `bunx turbo build` first and re-run.

- [ ] **Step 4: Commit and push the branch**

```bash
git add .changeset apps/server/api/docs/self-management.md
git commit -m "chore: changeset and docs for the harness-updates phase 1"
git push -u origin docs/harness-updates-spec
gh pr create --title "Harness updates phase 1: update action, version stamping, stale flag (issue #250)" --body "Implements Phase 1 of docs/superpowers/specs/2026-09-28-harness-updates-design.md. Phase 2 (remote-node update command, exact at-spawn versions, turn-end auto-restart) is reserved in the spec, not built here."
```

Per repo memory: do NOT use `gh pr merge --auto` (it merges immediately, not wait-for-green); watch CI with `gh run watch` and merge by hand.
