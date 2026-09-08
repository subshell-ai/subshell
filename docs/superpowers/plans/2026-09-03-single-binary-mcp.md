# Single-binary MCP (`subshell-server mcp`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retire the paired `subshell-mcp-<triple>` release artifact by making `subshell-server mcp` a real subcommand, possible because the server import graph becomes IO-free at import time.

**Architecture:** The entry's safety property flips from "commands exit synchronously" to "no module does IO at import" — implemented by making `betterAuth()` construction lazy (the graph's only import-time offender). The CLI dispatches `mcp` to `@internal/mcp-core`'s stdio server; `resolveMcpLaunch`'s ladder collapses to env override → self → client-on-PATH → error. Releases, CI, and docs go back to a single server binary.

**Tech Stack:** Bun 1.4.0, TypeScript, `bun test`, Elysia, better-auth 1.7.x, GitHub Actions (release.yml), `@internal/mcp-core` (workspace).

**Spec:** `docs/superpowers/specs/2026-09-03-single-binary-mcp-design.md`

## Global Constraints

- No dynamic imports (`await import(...)`) anywhere — project rule (breaks `bun build --compile`).
- Bun floor 1.4.0 (bytecode release flag; `assertBunFloor("1.4.0")` stays).
- All dependency versions pinned exact; use `bun install` / `bunx` only.
- Every task ends with: `bun run verify-types && bun run lint:check` green (from repo root), plus the task's own tests. Full `bun run test` at least at Tasks 2, 4, and 7.
- **SPIKE GATE (Task 1) must pass before Tasks 2–7 are implemented.** If it fails, STOP — the fallback (embed-and-extract) is a different spec; do not improvise.
- Spec performance budget: compiled `subshell-server mcp` without pane env must error with `SUBSHELL_API_KEY` in < 500 ms wall, < 200 MB RSS, creating zero files in CWD.
- Do not touch `apps/client` — the client's `subshell mcp` already works and is out of scope.

---

### Task 1: Spike gate — measure full-graph-evaluate cost BEFORE the refactor

Purpose: the design assumes evaluating the whole server module graph (Elysia, better-auth, Kysely class definitions) in the suspension window costs < 500 ms / < 200 MB. Measure it. The DB-litter this spike WILL show is expected (auth is still eager) — we are measuring SPEED and MEMORY only. The spike's edits are THROWAWAY; revert them at the end.

**Files:**
- Temporarily modify: `apps/server/src/cli.ts` (add a provisional `mcp` case)

**Interfaces:**
- Consumes: `runSubshellMcp(): Promise<void>` exported from `@internal/mcp-core` (barrel re-exports `./server.js`)
- Produces: a recorded measurement decision (continue / abort) in the task-report — no code artifacts

- [ ] **Step 1: Add the provisional subcommand**

In `apps/server/src/cli.ts`, after the `case "status":` block inside the `switch (command) {` in `dispatchCli`, add:

```ts
    // SPIKE (revert with the spike): measure full-graph evaluate cost.
    case "mcp": {
      const { runSubshellMcp } = await import("@internal/mcp-core");
      await runSubshellMcp();
      exit(0);
      return true;
    }
```

(This spike block MAY use a dynamic import purely as a measurement shortcut — it is reverted in Step 5 and never committed; the real Task 3 implementation uses a static top-level import.)

- [ ] **Step 2: Build the host compiled binary**

Run: `cd apps/server && bun run compile`
Expected: `dist/subshell-server` built (the second `subshell-mcp` build in the script may also run; irrelevant).

- [ ] **Step 3: Measure**

Run:

```bash
SPIKE=$(mktemp -d) && cd "$SPIKE" \
  && echo | /usr/bin/time -f "RSS=%MkB elapsed=%es" "$OLDPWD/../../apps/server/dist/subshell-server" mcp </dev/null 2>&1 | tail -5 \
  && echo "cwd litter:" && find . -type f | head
```

(Adjust the binary path if `mktemp` lost your `$PWD`; the point is: run `dist/subshell-server mcp` with EMPTY stdin and a CWD that is a fresh empty dir.)

Expected: output contains `SUBSHELL_API_KEY` (the mcp-core contract error) — capture the `RSS=` and `elapsed=` line. A `./data/subshell.db` appearing in the litter list is the KNOWN eager-auth issue Task 2 fixes — record it but do not fail the gate on it.

- [ ] **Step 4: Apply the gate**

PASS (proceed to Task 2) iff: elapsed < 0.5 s AND RSS < 204800 kB AND the process exited non-zero with the `SUBSHELL_API_KEY` error (not a hang, not a crash/stack-overflow).
FAIL → STOP, report numbers, do not implement Tasks 2–7; the fallback design (embed-and-extract) needs a new spec decision.

- [ ] **Step 5: Revert the spike**

Run: `git checkout -- apps/server/src/cli.ts && git status --short`
Expected: empty status (nothing committed, tree clean).

---

### Task 2: Lazy auth — `getAuth()` singleton (the one real refactor)

**Files:**
- Modify: `apps/server/src/auth.ts:113-114` (the `export const auth = betterAuth(AUTH_OPTIONS);` line + comment)
- Modify (import swap `auth` → `getAuth()`): `apps/server/src/api/auth-guard.ts:4`, `apps/server/src/plugins/auth.plugin.ts:2`, `apps/server/src/api/auth-rate-limit.route.ts:5`, `apps/server/src/api/system-keys.route.ts:6`, `apps/server/src/api/nodes/enroll.route.ts:6`, `apps/server/src/api/nodes/rotate-node-key.route.ts:7`, `apps/server/src/services/subshell-tokens.ts:3`, `apps/server/src/services/nodes/node-ws-handler.ts:10`, `apps/server/src/lib/session-cookie.ts:2`
- Test: `apps/server/src/__tests__/auth-lazy.test.ts` (create)

**Interfaces:**
- Consumes: existing `AUTH_OPTIONS` (unchanged, still exported — `auth-migrations.ts` imports it and must keep working)
- Produces: `getAuth(): Auth` (memoized better-auth instance; `type Auth = ReturnType<typeof buildAuth>` NOT exported — consumers use the return value's inferred type) and `resetAuthForTests(): void` (`@internal`).

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/__tests__/auth-lazy.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { getAuth, resetAuthForTests } from "@/auth.js";

/**
 * The lazy-auth contract (spec 2026-09-03 §2): better-auth construction is
 * the graph's only import-time IO (its constructor opens SQLite), so it must
 * happen on FIRST USE, never at module evaluation. These tests run under
 * SUBSHELL_TEST_MODE (bunfig preload) with the per-process temp DB.
 */
describe("getAuth", () => {
  test("is memoized: the same instance on every call", () => {
    const a = getAuth();
    expect(a).toBe(getAuth());
  });

  test("resetAuthForTests drops the memo (test isolation seam)", () => {
    const a = getAuth();
    resetAuthForTests();
    expect(getAuth()).not.toBe(a);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/server && bun test src/__tests__/auth-lazy.test.ts`
Expected: FAIL — `getAuth` is not exported.

- [ ] **Step 3: Implement the singleton**

In `apps/server/src/auth.ts`, replace lines 113-114:

```ts
/** The better-auth instance built from {@link AUTH_OPTIONS}. */
export const auth = betterAuth(AUTH_OPTIONS);
```

with:

```ts
/** Builds the better-auth instance. Its constructor OPENS SQLite — so this
 *  never runs at module evaluation (import-purity invariant, spec 2026-09-03):
 *  the entry graph must stay IO-free for the `mcp` subcommand's lifetime. */
function buildAuth() {
  return betterAuth(AUTH_OPTIONS);
}

type Auth = ReturnType<typeof buildAuth>;
let instance: Auth | undefined;

/**
 * The better-auth instance (singleton per the code-style rule), built on
 * FIRST USE. Everything that needs auth does so at boot or per-request —
 * both well after module evaluation — so the laziness is invisible in
 * behavior and visible only in the absence of import-time side effects.
 */
export function getAuth(): Auth {
  instance ??= buildAuth();
  return instance;
}

/**
 * Drops the memoized instance. Only for tests that need a fresh build.
 * @internal
 */
export function resetAuthForTests(): void {
  instance = undefined;
}
```

- [ ] **Step 4: Swap the nine importers**

In each of the 9 files listed under **Files:** change
`import { auth } from "@/auth.js";` (or the `../auth.js` variant) →
`import { getAuth } from "@/auth.js";` and each use `auth.X(...)` →
`getAuth().X(...)`. Example for `auth-guard.ts`:

```ts
import { getAuth } from "@/auth.js";
// …
const session = await getAuth().api.getSession({ headers: c.request.headers });
```

`auth.plugin.ts` mounts the handler: `app.use(auth as any)` style becomes `getAuth().handler`. `plugins/auth.plugin.ts` composes at `createApp()` time (boot) — correct under laziness. If a file captures `auth` in a module-level Elysia instance construction (e.g. `api.auth.listKeys(...)` inside a handler body), that body already runs per-request — swap in place.
NOT touched: `db/auth-migrations.ts` (`AUTH_OPTIONS` only) and `index.ts` (`setAuthPolicyDb` only).

- [ ] **Step 5: Verify**

Run: `bun test src/__tests__/auth-lazy.test.ts && bun test src/api/__tests__/auth-guard-bearer.test.ts src/api/__tests__/settings-route.test.ts src/services/__tests__/subshell-tokens.test.ts`
Expected: all pass (the three suites are the auth-heavy nets; fix call sites until green).

- [ ] **Step 6: Full gate + commit**

Run from repo root: `bun run verify-types && bun run lint:check && bun run test` — all green.

```bash
git add -A && git commit -m "refactor(server): lazy getAuth() — better-auth construction moves off import time

The graph's only import-time IO (the betterAuth() constructor opens SQLite)
becomes a first-use singleton per the code-style pattern; 9 importers swap
to getAuth(). This is what makes async CLI subcommands safe: the entry graph
is now IO-free at evaluation (spec 2026-09-03 single-binary MCP, §2)."
```

---

### Task 3: The `mcp` subcommand + the import-purity regression net

**Files:**
- Modify: `apps/server/src/cli.ts` (imports, `CliDeps`, `dispatchCli` switch, header comment)
- Test: `apps/server/src/__tests__/cli.test.ts` (in-process case)
- Test: `apps/server/src/__tests__/cli-entry.test.ts` (subprocess purity case)

**Interfaces:**
- Consumes: `runSubshellMcp(): Promise<void>` from `@internal/mcp-core` (static import; the package is already a dependency and its module evaluation is IO-free — it only reads env when `runSubshellMcp` is CALLED)
- Produces: subcommand `mcp` (pane-env driven: `SUBSHELL_API_KEY` etc.); new `CliDeps.mcpRun?: () => Promise<void>` seam; the invariant comment text Tasks 4–6 quote.

- [ ] **Step 1: Write the failing subprocess purity test**

In `apps/server/src/__tests__/cli-entry.test.ts`, after the malformed-args test added by PR #7, add (same `describe`, same `runCli`/`walk` helpers):

```ts
  test(
    "mcp without pane env: clean contract refusal, no db litter, no port bind",
    async () => {
      // The import-purity regression net (spec 2026-09-03 §1): `mcp` is a
      // long-running command — it suspends by nature. Safety now rests on the
      // graph being IO-free at import (lazy getAuth), NOT on sync-exit. This
      // must hold ACROSS the real entry: no ./data/subshell.db, and the
      // pinned SERVER_PORT never gains a listener.
      const cwd = mkdtempSync(join(tmpdir(), `subshell-entry-mcp-${process.pid}-`));
      const port = await freePort();
      const run = await runCli(["mcp"], {
        cwd,
        env: {
          SERVER_PORT: String(port),
          SUBSHELL_SERVER_CONFIG_DIR: join(cwd, "cfg"),
          PATH: "/usr/bin:/bin",
        },
      });
      expect(run.code).not.toBe(0);
      expect(`${run.stdout}${run.stderr}`).toContain("SUBSHELL_API_KEY");
      expect(walk(cwd).filter((f) => /\.(db|db-wal|db-shm)$/.test(f))).toEqual([]);
    },
    TIMEOUT,
  );
```

- [ ] **Step 2: Write the failing in-process test**

In `apps/server/src/__tests__/cli.test.ts` (inside the file's `describe` for dispatch), add:

```ts
  test("mcp runs the injected stdio server and reports handled", async () => {
    let calls = 0;
    const { deps, exits } = collectingDeps({ mcpRun: async () => { calls++; } });
    // dispatchCli must await it: the fake resolves immediately, so this pins
    // the dispatch → run → exit wiring without a real stdio loop.
    expect(await dispatchCli(["mcp"], deps)).toBe(true);
    expect(calls).toBe(1);
    expect(exits).toEqual([0]);
  });
```

- [ ] **Step 3: Run both to verify they fail**

Run: `cd apps/server && bun test src/__tests__/cli.test.ts src/__tests__/cli-entry.test.ts -t "mcp"`
Expected: FAIL — unknown subcommand path (the `mcp` word hits the usage error).

- [ ] **Step 4: Implement**

In `apps/server/src/cli.ts`:

1. Add to the top-level imports (static — the rule that makes this whole spec legal):

```ts
import { runSubshellMcp } from "@internal/mcp-core";
```

2. Add to `CliDeps` (next to `mcpIo`):

```ts
  /**
   * stdio MCP server runner for the `mcp` subcommand (default:
   * `runSubshellMcp` from `@internal/mcp-core`). Injectable so tests pin the
   * dispatch wiring without opening a real stdio loop.
   */
  mcpRun?: () => Promise<void>;
```

3. Add the case to the `switch (command)` after `"status"`:

```ts
    // The pane-spawned MCP stdio server (spec 2026-09-03): the ONLY
    // long-running command — legal because the graph evaluates IO-free (lazy
    // getAuth) and `isCliEngaged()` (set above, synchronously) keeps the boot
    // body from running in the suspension window. cli-bootstrap's
    // `.then(handled ⇒ exit 0)` is the natural end once stdin closes.
    case "mcp":
      try {
        await (deps.mcpRun ?? runSubshellMcp)();
      } catch (err: unknown) {
        error(`subshell mcp: fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
        exit(1);
      }
      exit(0);
      return true;
```

4. Update the module-header comment: invariant 1 now reads — handled commands exit synchronously **except `mcp`**, which is long-running by contract and safe because the entry graph is IO-free at import (the `@/auth.js` caveat is historical: construction is lazy since Task 2; keep the "async commands must never do IO at import" duty as invariant 3).

- [ ] **Step 5: Verify**

Run: `bun test src/__tests__/cli.test.ts src/__tests__/cli-entry.test.ts` — all pass (the new subprocess case proves `data/subshell.db` does NOT appear post-Task-2).
Manual compiled-binary spot check: `cd apps/server && bun run compile && (cd "$(mktemp -d)" && <repo>/apps/server/dist/subshell-server mcp </dev/null; echo exit=$?)` → `SUBSHELL_API_KEY` error, non-zero, no files created.

- [ ] **Step 6: Full gate + commit**

`bun run verify-types && bun run lint:check && bun run test` green, then:

```bash
git add -A && git commit -m "feat(server): mcp subcommand — the server binary serves its own MCP shim

Long-running by contract, legal because the entry graph is now IO-free at
import (Task 2) and isCliEngaged keeps the boot body out of the suspension
window. Pinned by a subprocess purity test (no db litter, clean contract
refusal) and an injected-runner dispatch test."
```

---

### Task 4: Resolver collapse — self-reference replaces sibling + dist rungs

**Files:**
- Modify: `apps/server/src/services/mcp-resolve.ts`
- Test: `apps/server/src/services/__tests__/mcp-resolve.test.ts` (rewrite ladder cases)
- Test: `apps/server/src/__tests__/cli.test.ts` (the two status mcp cases from PR #7 change expectations)

**Interfaces:**
- Consumes: `McpLaunchSpec` (unchanged shape from `@internal/harnesses`)
- Produces: `probeMcpLaunch(env?, io?)` with `McpLaunchSource = "env" | "self" | "client-on-path"`; `McpResolveIo { exists?, which?, execPath?, argv1? }`; `resolveMcpLaunch` / `resolveMcpLaunchForDisplay` signatures unchanged (new optional `io.argv1` seam). Pane configs therefore contain `subshell-server mcp` (compiled) or `<bun> <abs entry> mcp` (interpreted).

- [ ] **Step 1: Rewrite the failing ladder tests**

Replace the rung tests in `mcp-resolve.test.ts` (keep env-override + malformed-args + display-placeholder tests as-is):

```ts
  it("self (compiled): the server binary re-invokes itself with mcp", () => {
    const probe = probeMcpLaunch({}, { execPath: "/srv/bin/subshell-server", exists: () => false, which: () => null });
    expect(probe).toEqual({ spec: { command: "/srv/bin/subshell-server", args: ["mcp"] }, source: "self" });
  });

  it("self (compiled, triple-suffixed): the release artifact name still self-resolves", () => {
    const probe = probeMcpLaunch({}, { execPath: "/srv/bin/subshell-server-darwin-arm64", exists: () => false, which: () => null });
    expect(probe.source).toBe("self");
  });

  it("self (bun-interpreted): absolute entry + mcp argv — safe from any pane cwd", () => {
    const probe = probeMcpLaunch(
      {},
      { execPath: "/usr/local/bin/bun", argv1: "dist/index.js", exists: () => true, which: () => null },
    );
    expect(probe.source).toBe("self");
    expect(probe.spec?.args[0]).toBe(join(process.cwd(), "dist/index.js"));
    expect(probe.spec?.args[1]).toBe("mcp");
  });

  it("bun-interpreted without a usable argv1 skips self (never bake a bogus entry)", () => {
    const probe = probeMcpLaunch(
      {},
      { execPath: "/usr/local/bin/bun", argv1: "", exists: () => false, which: () => null },
    );
    expect(probe.spec).toBeNull();
  });

  it("client-on-PATH remains the last rung", () => {
    const probe = probeMcpLaunch(
      {},
      { execPath: "/usr/local/bin/bun", argv1: "", exists: () => false, which: (n) => (n === "subshell" ? "/usr/local/bin/subshell" : null) },
    );
    expect(probe).toEqual({ spec: { command: "/usr/local/bin/subshell", args: ["mcp"] }, source: "client-on-path" });
  });

  it("a bare `subshell` on PATH never beats the self rung", () => {
    const probe = probeMcpLaunch(
      {},
      { execPath: "/srv/subshell-server", exists: () => false, which: () => "/usr/bin/subshell", argv1: "" },
    );
    expect(probe.source).toBe("self");
  });
```

(Delete the compiled-sibling and dist-entry `it` blocks — the rungs they pinned no longer exist. The "in-repo autodetection" test becomes: default `probeMcpLaunch({})` under `bun test` yields `source: "self"` — bun execPath + real argv1. Note `bun test` sets `process.argv[1]` to the test runner's file; if that makes this non-deterministic, pin it via `io.argv1 = "src/index.ts"` and assert self.)

- [ ] **Step 2: Run to verify failure**

Run: `bun test src/services/__tests__/mcp-resolve.test.ts`
Expected: FAIL (`source: "self"` unknown; sibling/dist cases removed so old code may still compile — failures come from the new assertions).

- [ ] **Step 3: Implement the new ladder**

In `mcp-resolve.ts`: delete `SERVER_BINARY`/sibling logic and the `../mcp/main.*` loop. The new ladder body inside `probeMcpLaunch` after the env block:

```ts
  // 2. SELF: the server binary IS the MCP server (`subshell-server mcp`,
  //    spec 2026-09-03) — possible because the entry graph is IO-free at
  //    import. Compiled builds self-reference by execPath; bun-interpreted
  //    ones (dev `bun src/index.ts`, dist `bun dist/index.js`) need the
  //    entry script too, ABSOLUTE: pane configs spawn in the subshell's cwd,
  //    where a relative argv[1] would not exist.
  if (basename(execPath).startsWith(SERVER_PRODUCT)) {
    return { spec: { command: execPath, args: ["mcp"] }, source: "self" };
  }
  if (argv1) {
    return { spec: { command: execPath, args: [resolve(argv1), "mcp"] }, source: "self" };
  }
  // 3. LAST RUNG: the `subshell` node agent carries the same mcp-core server.
  //    Covers hosts whose server predates the self rung.
  const client = which(CLIENT_BINARY);
  if (client) return { spec: { command: client, args: ["mcp"] }, source: "client-on-path" };
  return { spec: null, error: `cannot locate the ${MCP_BINARY} entrypoint; set SUBSHELL_MCP_COMMAND` };
```

with `const SERVER_PRODUCT = "subshell-server";` replacing `SERVER_BINARY`, `McpResolveIo` gaining `argv1?: string`, the destructure `const argv1 = io.argv1 ?? process.argv[1] ?? ""`, imports updated (`resolve` from `node:path`; drop `dirname`, `join`, `existsSync`, `fileURLToPath` if now unused — `exists` seam stays for callers' sake or is dropped from the interface if no rung uses it: IT IS NO LONGER USED → remove `exists` from `McpResolveIo` and update all test fakes). Update `McpLaunchSource` to `"env" | "self" | "client-on-path"`. Rewrite the module + function doc comments to the new ladder, and the stale rationale comments on `CLIENT_BINARY` / `MCP_LAUNCH_PLACEHOLDER` (the placeholder now names the retired artifact: change it to `{ command: "subshell-server", args: ["mcp"] }`? NO — placeholder is the DISPLAY fallback when unresolved; keep it honest: `{ command: MCP_BINARY, args: [] }` is dead naming; replace its value with `{ command: "subshell-server", args: ["mcp"] }` and keep `MCP_BINARY` exported only if still referenced — Task 5 deletes `MCP_BINARY`/`subshell-mcp` naming entirely; in THIS task update the placeholder's pin-test accordingly).

- [ ] **Step 4: Update the two status tests in cli.test.ts**

Resolved case: fake io `{ execPath: "/srv/bin/subshell-server", which: () => null }` — a `subshell-server*` execPath always self-resolves (no fs needed), so expect the line to contain `/srv/bin/subshell-server mcp` and `(via self)` (rename the test from "compiled-sibling" wording).
UNRESOLVED case: execPath self-resolution cannot be forced to fail on its own, so pin the miss through the non-compiled shape: `{ execPath: "/usr/bin/other", argv1: "", which: () => null }` and expect `UNRESOLVED` + `SUBSHELL_MCP_COMMAND` as before.

- [ ] **Step 5: Verify**

Run: `bun test src/services/__tests__/mcp-resolve.test.ts src/__tests__/cli.test.ts src/services/__tests__/subshell-manager-mcp.test.ts src/api/subshells/__tests__/` — pass. (`registerSubshellMcp` keeps calling `resolveMcpLaunch` unchanged.)

- [ ] **Step 6: Full gate + commit**

```bash
git add -A && git commit -m "refactor(server)!: mcp resolver collapses to self-reference

env override → self (compiled execPath, or absolute bun+argv1 entry — never a
pane-relative path) → subshell-on-PATH. The compiled-sibling and dist-entry
rungs are retired: there is one binary now (spec 2026-09-03)."
```

---

### Task 5: Retire the companion binary (build + protocol cleanup)

**Files:**
- Modify: `apps/server/package.json:20` (`compile` — single outfile)
- Delete: `apps/server/src/mcp/main.ts`
- Modify: `apps/server/src/scripts/release.ts` (drop `mcpBuildArgs` + the pair loop → single build per triple, map keyed by triple)
- Modify: `apps/server/src/scripts/__tests__/release.test.ts` (revert the doubled expectations; delete the mcp argv test)
- Modify: `packages/subshell-protocol/src/paths.ts` (delete `serverMcpArtifactFileName`), `packages/subshell-protocol/src/index.ts` (barrel), `packages/subshell-protocol/src/__tests__/paths.test.ts` (delete its test)
- Modify: `apps/server/src/services/mcp-resolve.ts` (delete now-unused `MCP_BINARY` export + placeholder naming comment)

**Interfaces:**
- Consumes: nothing from earlier tasks beyond merged state
- Produces: release output = exactly the 3 `subshell-server-<triple>` binaries + sidecars; `bun run compile` emits only `dist/subshell-server`.

- [ ] **Step 1: Write the failing expectations** (test-first: the release suite pins the reverted contract)

In `release.test.ts`: delete `mcpBuildArgs` import + its `test(...)`; delete the "failing MCP half" test; restore the doubled expectations to singles — `"all succeed → one artifact per triple"` (keyed by triple, `size === SERVER_TARGETS.length`, `artifact.path === join(outDir, serverArtifactFileName(triple))`), scope test `keys === scope` / `calls.length === scope.length` / `scope[i]`, runRelease success test back to `SERVER_TARGETS.length` (both calls + published size), sign test `signed.length === SERVER_TARGETS.length` AND restore the index-free `expected-sign-${i++}` naming (keep that fix), publish-primitive test back to `subshell-server-<triple>` + sidecars only, and the `stubRunBuild(failTriple)` signature back to the plain `serverArtifactFileName(triple)` matcher (delete `serverFails` helper usage added in PR #7? keep — cosmetic, but drop the now-wrong "MCP half" comments).

- [ ] **Step 2: Run to verify failure** — `bun test src/scripts/__tests__/release.test.ts` → FAIL on size assertions (code still builds pairs).

- [ ] **Step 3: Implement**

`release.ts`: delete `mcpBuildArgs` + `serverMcpArtifactFileName` import; `buildAll` inner loop becomes the single server build (restore `artifacts.set(target.triple, …)` keyed by triple; drop the name-keyed comment); restore the main() summary to print `serverArtifactFileName(triple)`; revert the `buildTargets` doc ("one artifact per triple"). `paths.ts`/barrel/protocol test: delete the MCP-name helper + its test + export line. `package.json` compile:

```json
"compile": "bun build --compile --target=bun --bytecode --minify --sourcemap ./src/index.ts --outfile ./dist/subshell-server",
```

`git rm apps/server/src/mcp/main.ts`. In `mcp-resolve.ts`: delete `MCP_BINARY` (its last references died with Tasks 4/5) and re-word the placeholder comment (the constant now names the SELF command, not a retired binary).

- [ ] **Step 4: Verify** — `bun test src/scripts/__tests__/release.test.ts && bunx turbo build` at root; protocol barrel export removed cleanly (verify-types will catch strays).

- [ ] **Step 5: Full gate + commit**

```bash
git commit -am "refactor(server)!: retire the subshell-mcp companion artifact

Single binary ships again: compile:release drops the per-triple MCP companion,
the protocol name helper and src/mcp/main.ts die with it (the mcp subcommand
is the entrypoint now)."
```

---

### Task 6: CI + docs alignment

**Files:**
- Modify: `.github/workflows/release.yml` (drop `MCP_BIN` checks, `mcp_smoke`, companion magic check; timeout 60 → 45 with comment updated; job-summary text)
- Modify: `AGENTS.md` (root: release assets back to 3 binaries; the "Release assets" bullet from PR #7)
- Modify: `apps/server/AGENTS.md` ("MCP entrypoint resolution" — self ladder, one-file install; "Embedded SPA + release dance" — drop the PAIR text)
- Modify: `docs/architecture.md` (ladder sentence → env → self → PATH)
- Modify: `docs/subshell-rollout.md` (Mac bullet: back to one binary, no pair)

**Interfaces:**
- Consumes: Task 4's `source` strings for the docs' status-line examples
- Produces: CI whose server shard publishes/asserts exactly `subshell-server-<triple>`(+`.sha256`)

- [ ] **Step 1: Edit release.yml** — delete the two `if [ "$APP" = "server" ]` companion blocks and the `mcp_smoke` function + its `if/fi` call; restore `timeout-minutes: 45` (comment: one sign+notarize round trip). Everything else (ephemeral keychain, globs) untouched.
- [ ] **Step 2: Rewrite the four doc passages** to the one-binary story; the server `AGENTS.md` MCP section's final ladder sentence: `SUBSHELL_MCP_COMMAND/_ARGS` → self (`subshell-server mcp`, absolute bun+entry under `bun run`) → `subshell` on PATH → throw; replace the "why a subcommand is impossible" paragraph with its inverse (import-purity is what makes it possible; the companion era is history).
- [ ] **Step 3: Verify** — `bunx js-yaml .github/workflows/release.yml > /dev/null` and `grep -rn "subshell-mcp-" AGENTS.md apps/server/AGENTS.md docs/` returns nothing (docs no longer instruct installing a companion; a stale reference in a CHANGELOG is acceptable and expected — CHANGELOGs are history).
- [ ] **Step 4: Commit** — `git commit -am "docs+ci: single-binary MCP alignment (retire companion assets, self-rung ladder)"`

---

### Task 7: Release-readiness — changeset + end-to-end proof

**Files:**
- Create: `.changeset/<slug>.md`

- [ ] **Step 1: Changeset** — `bunx changeset` → `@internal/server` **minor**; summary: mcp subcommand, resolver self-ladder, single-binary releases, lazy auth note. Commit.
- [ ] **Step 2: End-to-end proof (local)** — `cd apps/server && bun run compile`, then in a fresh temp dir: `subshell-server status` must print `mcp entrypoint = <…>/dist/subshell-server mcp  (via self)` and create zero files; `subshell-server mcp </dev/null` must print the `SUBSHELL_API_KEY` refusal. Record both outputs in the PR body.
- [ ] **Step 3: Full gates** — `bun run verify-types && bun run lint:check && bun run test` + `bun run test:e2e` (it boots the real server; the create path now resolves self under `bun src/index.ts` — a PASS is the strongest integration proof).
- [ ] **Step 4: Branch + PR + merge** per repo flow; after merge, cut via `gh workflow run release.yml -f app=server` when the version PR lands.

## Self-Review (plan author, completed at write time)

- Spec §1–§6 each map to Tasks 3/2/3–4/5–6/4–5/1–3–7 respectively — covered.
- Placeholder scan: clean (all code inline).
- Type consistency: `getAuth`/`resetAuthForTests` (Task 2) match Task 3's narrative; `McpLaunchSource` values used identically in Tasks 3–4 and 6 docs; `resolve` import added in Task 4 matches its code block.
- Known intentional wart: Task 1's spike uses a dynamic import — flagged as throwaway/reverted; justified because measuring pre-refactor needs async dispatch without touching committed code.
