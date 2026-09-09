# Plugins Phase 0: Detection Says Why and When

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make harness detection explain itself, so "Claude Code is not installed" while it is becomes an answerable question rather than a dead end.

**Architecture:** Detection gains two facts and loses one duplication. A lookup that fails returns *why* (`not-on-path` vs `override-invalid`) instead of `null`; every scan stamps *when* it ran; and the server's hand-rolled probe in `harness-utils.ts` is replaced by the same `scanOne` the agent already uses, so both sides produce one entry shape. The version probe gains a deadline it does not have today.

**Tech Stack:** Bun, TypeScript, ElysiaJS + TypeBox, React 19 + TanStack Query, Tailwind, `bun test`.

**Spec:** `docs/superpowers/specs/2026-09-09-plugin-architecture-design.md` (§7, §15 phase 0)

## Global Constraints

- **Phase 0 ships alone.** No plugin loader, no npm, no protocol version bump, no table drops. Anything from §4 to §12 of the spec is out of scope here.
- **No em dashes** in any user-facing copy or code comment added by this plan.
- **No dynamic imports** (`await import(...)`); they break `bun build --compile`.
- **Pinned dependency versions**, no `^` or `~`. This plan adds no dependencies.
- **Every Elysia `t` schema property carries a `description`.**
- **Wire additions are optional fields.** An agent older than this change reports entries without `reason` or `checkedAt`; every reader must treat absence as "unknown", never as an error and never as a default that asserts something false.
- **`packages/harnesses` is Apache-2.0**, outside `apps/server/**`. Nothing in this plan moves a file across that boundary.
- Verification after every task: `bun run verify-types`, `bun run lint:check`, `bun run test`.

---

### Task 1: Detection reasons in the binary lookup

`findBinaryWithOptions` answers `string | null`. The `null` collapses two very different situations: nothing was found anywhere, and an explicit env override was set but points at something missing or not executable. The second currently renders an install command that cannot possibly help.

**Files:**
- Modify: `packages/harnesses/src/binary-lookup.ts`
- Test: `packages/harnesses/src/__tests__/binary-lookup.test.ts`

**Interfaces:**
- Produces: `type DetectionReason = "not-on-path" | "override-invalid"`; `type DetectionResult = { path: string; reason?: undefined } | { path: null; reason: DetectionReason }`; `detectBinaryWithOptions(name, envName, knownPaths, options): Promise<DetectionResult>`; `detectBinary(name, envName, knownPaths): Promise<DetectionResult>`. `findBinary` and `findBinaryWithOptions` keep their current signatures and delegate.

- [ ] **Step 1: Write the failing test**

Add to `packages/harnesses/src/__tests__/binary-lookup.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { detectBinaryWithOptions } from "../binary-lookup.js";

describe("detectBinaryWithOptions", () => {
  it("reports override-invalid when the env override points at nothing", async () => {
    const result = await detectBinaryWithOptions("claude", "CLAUDE_PATH", [], {
      env: { CLAUDE_PATH: "/nonexistent/claude", HOME: "/tmp" },
      pathEntries: [],
    });
    expect(result.path).toBeNull();
    expect(result.reason).toBe("override-invalid");
  });

  it("reports not-on-path when nothing is found and no override is set", async () => {
    const result = await detectBinaryWithOptions("claude", "CLAUDE_PATH", [], {
      env: { HOME: "/tmp" },
      pathEntries: [],
    });
    expect(result.path).toBeNull();
    expect(result.reason).toBe("not-on-path");
  });

  it("returns the path with no reason when found on PATH", async () => {
    const dir = `/tmp/detect-${crypto.randomUUID()}`;
    await Bun.write(`${dir}/faketool`, "#!/bin/sh\n");
    await Bun.spawn(["chmod", "+x", `${dir}/faketool`]).exited;
    const result = await detectBinaryWithOptions("faketool", "FAKETOOL_PATH", [], {
      env: { HOME: "/tmp" },
      pathEntries: [dir],
    });
    expect(result.path).toBe(`${dir}/faketool`);
    expect(result.reason).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd packages/harnesses && bun test src/__tests__/binary-lookup.test.ts`
Expected: FAIL, `detectBinaryWithOptions` is not exported.

- [ ] **Step 3: Implement**

In `packages/harnesses/src/binary-lookup.ts`, add the types above the existing functions:

```typescript
/**
 * Why a binary was not found. The distinction is the point: an invalid
 * explicit override is a configuration mistake the user can fix, while
 * `not-on-path` is a missing install. Rendering an install command for the
 * first is unhelpful, which is what this exists to stop.
 */
export type DetectionReason = "not-on-path" | "override-invalid";

/** A lookup's full answer: the path, or the reason there is not one. */
export type DetectionResult = { path: string; reason?: undefined } | { path: null; reason: DetectionReason };
```

Rename the body of `findBinaryWithOptions` to `detectBinaryWithOptions`, returning `DetectionResult`: the explicit-override branch answers `{ path: null, reason: "override-invalid" }`, every successful rung answers `{ path: candidate }`, and the final fallthrough answers `{ path: null, reason: "not-on-path" }`. Then keep the two original names as delegations:

```typescript
/** {@link detectBinaryWithOptions} against the live process env. */
export async function detectBinary(name: string, envName: string, knownPaths: string[]): Promise<DetectionResult> {
  return detectBinaryWithOptions(name, envName, knownPaths, {
    env: process.env,
    pathEntries: (process.env.PATH ?? "").split(":"),
  });
}

/** Path-only view of {@link detectBinary}, for callers that cannot act on a reason. */
export async function findBinary(name: string, envName: string, knownPaths: string[]): Promise<string | null> {
  return (await detectBinary(name, envName, knownPaths)).path;
}

/** Path-only view of {@link detectBinaryWithOptions}. */
export async function findBinaryWithOptions(
  name: string,
  envName: string,
  knownPaths: string[],
  options: BinaryLookupOptions,
): Promise<string | null> {
  return (await detectBinaryWithOptions(name, envName, knownPaths, options)).path;
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd packages/harnesses && bun test src/__tests__/binary-lookup.test.ts`
Expected: PASS, including every pre-existing case in that file (the delegations must keep them green).

- [ ] **Step 5: Export the new names**

In `packages/harnesses/src/index.ts`, add to the existing export block:

```typescript
export { detectBinary, type DetectionReason, type DetectionResult } from "./binary-lookup.js";
```

- [ ] **Step 6: Verify and commit**

```bash
bun run verify-types && bun run lint:check
git add packages/harnesses
git commit -m "feat(harnesses): binary lookup reports why a binary was not found"
```

---

### Task 2: A bounded version probe

Every plugin's `getVersion` spawns `<binary> --version` with no deadline. One wedged binary hangs a request on a surface that is polled. `login-path.ts` already solves this exact problem; this generalises its pattern.

**Files:**
- Create: `packages/harnesses/src/version-probe.ts`
- Modify: `packages/harnesses/src/{claude-code,codex,hermes,opencode,pi}.ts`
- Modify: `packages/harnesses/src/index.ts`
- Test: `packages/harnesses/src/__tests__/version-probe.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `probeVersion(binary: string, args?: string[], timeoutMs?: number): Promise<string | null>`.

- [ ] **Step 1: Write the failing test**

Create `packages/harnesses/src/__tests__/version-probe.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { probeVersion } from "../version-probe.js";

describe("probeVersion", () => {
  it("returns trimmed stdout", async () => {
    expect(await probeVersion("/bin/echo", ["1.2.3"])).toBe("1.2.3");
  });

  it("returns null for a non-zero exit", async () => {
    expect(await probeVersion("/bin/false", [])).toBeNull();
  });

  it("returns null for a binary that does not exist", async () => {
    expect(await probeVersion("/nonexistent/tool", ["--version"])).toBeNull();
  });

  it("gives up rather than hanging", async () => {
    const started = Date.now();
    expect(await probeVersion("/bin/sh", ["-c", "sleep 30"], 200)).toBeNull();
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd packages/harnesses && bun test src/__tests__/version-probe.test.ts`
Expected: FAIL, cannot resolve `../version-probe.js`.

- [ ] **Step 3: Implement**

Create `packages/harnesses/src/version-probe.ts`:

```typescript
/**
 * Reading a harness's version without letting it wedge the caller.
 *
 * Every plugin's `getVersion` spawns `<binary> --version`, and until this
 * existed none of them had a deadline. The surfaces that call it are polled
 * (the harness list refetches, a node re-check scans every plugin), so one
 * binary that blocks on a prompt or a network call held a request open
 * indefinitely. A version is a nice-to-have, so the right answer to a slow
 * one is to stop asking. Same reasoning, and the same shape, as
 * `login-path.ts`.
 */

/** How long a version probe may take before it is abandoned. */
export const VERSION_PROBE_TIMEOUT_MS = 4000;

/**
 * Runs `<binary> <args>` and returns its trimmed stdout.
 *
 * Total: a missing binary, a non-zero exit, empty output and a timeout all
 * answer `null`. The caller has already established that the binary exists,
 * so there is nothing here an operator would act on.
 * @param binary - absolute path to the executable
 * @param args - version arguments (default `["--version"]`)
 * @param timeoutMs - deadline (default {@link VERSION_PROBE_TIMEOUT_MS})
 */
export async function probeVersion(
  binary: string,
  args: string[] = ["--version"],
  timeoutMs: number = VERSION_PROBE_TIMEOUT_MS,
): Promise<string | null> {
  try {
    const proc = Bun.spawn({ cmd: [binary, ...args], stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    try {
      const text = await new Response(proc.stdout).text();
      await proc.exited;
      if (proc.exitCode !== 0) return null;
      return text.trim() || null;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd packages/harnesses && bun test src/__tests__/version-probe.test.ts`
Expected: PASS, four cases.

- [ ] **Step 5: Route all five plugins through it**

In each of `claude-code.ts`, `codex.ts`, `hermes.ts`, `opencode.ts`, `pi.ts`, replace the body of `getVersion` with the delegation. Add `import { probeVersion } from "./version-probe.js";` to each file. Claude Code, for example, becomes:

```typescript
  async getVersion(): Promise<string | null> {
    const binary = await this.findBinary();
    return binary ? await probeVersion(binary) : null;
  }
```

Check each plugin's existing `getVersion` for a non-default argument before replacing it. Where a plugin passes something other than `--version`, keep that value: `probeVersion(binary, ["version"])`.

- [ ] **Step 6: Export and verify**

Add to `packages/harnesses/src/index.ts`:

```typescript
export { probeVersion, VERSION_PROBE_TIMEOUT_MS } from "./version-probe.js";
```

Run: `cd packages/harnesses && bun test` (the whole package, to catch a plugin whose version arguments were not `--version`).
Expected: PASS.

- [ ] **Step 7: Verify and commit**

```bash
bun run verify-types && bun run lint:check
git add packages/harnesses
git commit -m "feat(harnesses): bound the version probe so a wedged binary cannot hang a request"
```

---

### Task 3: `detect()` on the plugin interface

`scanOne` cannot report a reason it never sees. Rather than five plugins each re-deriving one, the interface grows a `detect()` that returns the full result, and `findBinary()` becomes its path-only view. The two plugins with a test override seam keep it.

**Files:**
- Modify: `packages/harnesses/src/types.ts`
- Modify: `packages/harnesses/src/{claude-code,codex,hermes,opencode,pi}.ts`
- Test: `packages/harnesses/src/__tests__/plugins-detect.test.ts`

**Interfaces:**
- Consumes: `DetectionResult`, `detectBinary` from Task 1.
- Produces: `HarnessPlugin.detect(): Promise<DetectionResult>`, implemented by all five. `HarnessPlugin.findBinary()` keeps its `Promise<string | null>` signature.

- [ ] **Step 1: Write the failing test**

Create `packages/harnesses/src/__tests__/plugins-detect.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { ALL_HARNESSES } from "../index.js";

describe("every plugin implements detect()", () => {
  for (const plugin of ALL_HARNESSES) {
    it(`${plugin.id} answers a DetectionResult whose path agrees with findBinary()`, async () => {
      const result = await plugin.detect();
      const path = await plugin.findBinary();
      expect(result.path).toBe(path);
      if (result.path === null) {
        expect(["not-on-path", "override-invalid"]).toContain(result.reason);
      } else {
        expect(result.reason).toBeUndefined();
      }
    });
  }
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd packages/harnesses && bun test src/__tests__/plugins-detect.test.ts`
Expected: FAIL, `plugin.detect is not a function`.

- [ ] **Step 3: Add the method to the interface**

In `packages/harnesses/src/types.ts`, add to `HarnessPlugin` directly above `findBinary`, and import the type at the top of the file:

```typescript
  /**
   * Resolves the binary, reporting WHY when there is not one. The reason is
   * what lets a surface distinguish "install it" from "your CLAUDE_PATH is
   * wrong", which are the same `null` to {@link findBinary}.
   */
  detect(): Promise<DetectionResult>;
```

- [ ] **Step 4: Implement in the three plugins with no override seam**

In `hermes.ts`, `opencode.ts` and `pi.ts`, replace `findBinary` with the pair. Change the `findBinary` import to `detectBinary`. Hermes, for example:

```typescript
  async detect(): Promise<DetectionResult> {
    return detectBinary(this.binaryName, "HERMES_PATH", PLUGIN_KNOWN_PATHS);
  }

  async findBinary(): Promise<string | null> {
    return (await this.detect()).path;
  }
```

Keep each plugin's own env-override name and its own `PLUGIN_KNOWN_PATHS` constant. Do not consolidate them in this task.

- [ ] **Step 5: Implement in the two plugins with an override seam**

`claude-code.ts` and `codex.ts` hold a `#binaryOverride` injected by tests. The override branch answers `override-invalid` when the injected path does not exist, which is exactly what the reason means:

```typescript
  async detect(): Promise<DetectionResult> {
    if (this.#binaryOverride) {
      return (await Bun.file(this.#binaryOverride).exists())
        ? { path: this.#binaryOverride }
        : { path: null, reason: "override-invalid" };
    }
    return detectBinary(this.binaryName, "CLAUDE_PATH", PLUGIN_KNOWN_PATHS);
  }

  async findBinary(): Promise<string | null> {
    return (await this.detect()).path;
  }
```

Use `CODEX_PATH` and codex's own known-paths constant in `codex.ts`.

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `cd packages/harnesses && bun test`
Expected: PASS, including the pre-existing plugin tests that construct with an override.

- [ ] **Step 7: Verify and commit**

```bash
bun run verify-types && bun run lint:check
git add packages/harnesses
git commit -m "feat(harnesses): plugins report a detection reason via detect()"
```

---

### Task 4: `scanOne` carries the reason and the timestamp

The inventory entry is the shape both the agent and (after Task 5) the server produce. It gains the two facts every surface needs, both optional on the wire so an older agent stays readable.

**Files:**
- Modify: `packages/harnesses/src/inventory.ts`
- Modify: `packages/subshell-protocol/src/node-frames.ts:244-248`
- Test: `packages/harnesses/src/__tests__/inventory.test.ts`

**Interfaces:**
- Consumes: `HarnessPlugin.detect()` from Task 3.
- Produces: `HarnessInventoryEntry` gains `reason?: DetectionReason` and `checkedAt?: string` (ISO 8601). `scanOne(h: HarnessPlugin, now?: Date)` keeps its name and gains the optional clock argument.

- [ ] **Step 1: Write the failing test**

Add to `packages/harnesses/src/__tests__/inventory.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { scanOne } from "../inventory.js";
import type { HarnessPlugin } from "../types.js";

function stub(over: Partial<HarnessPlugin>): HarnessPlugin {
  return {
    id: "stub",
    detect: async () => ({ path: null, reason: "not-on-path" }),
    findBinary: async () => null,
    isInstalled: async () => false,
    getVersion: async () => null,
    ...over,
  } as unknown as HarnessPlugin;
}

describe("scanOne", () => {
  const at = new Date("2026-09-09T12:00:00.000Z");

  it("stamps checkedAt on a not-found entry and carries the reason", async () => {
    const entry = await scanOne(stub({}), at);
    expect(entry).toEqual({
      harnessId: "stub",
      installed: false,
      reason: "not-on-path",
      checkedAt: "2026-09-09T12:00:00.000Z",
    });
  });

  it("carries override-invalid through", async () => {
    const entry = await scanOne(stub({ detect: async () => ({ path: null, reason: "override-invalid" }) }), at);
    expect(entry.reason).toBe("override-invalid");
  });

  it("stamps checkedAt on a found entry and omits the reason", async () => {
    const entry = await scanOne(
      stub({
        detect: async () => ({ path: "/usr/bin/stub" }),
        findBinary: async () => "/usr/bin/stub",
        isInstalled: async () => true,
        getVersion: async () => "9.9.9",
      }),
      at,
    );
    expect(entry).toEqual({
      harnessId: "stub",
      installed: true,
      binaryPath: "/usr/bin/stub",
      version: "9.9.9",
      checkedAt: "2026-09-09T12:00:00.000Z",
    });
  });

  it("degrades a throwing probe to not-installed and still stamps it", async () => {
    const entry = await scanOne(
      stub({
        detect: async () => {
          throw new Error("weird filesystem");
        },
      }),
      at,
    );
    expect(entry.installed).toBe(false);
    expect(entry.checkedAt).toBe("2026-09-09T12:00:00.000Z");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd packages/harnesses && bun test src/__tests__/inventory.test.ts`
Expected: FAIL, entries carry neither `reason` nor `checkedAt`.

- [ ] **Step 3: Implement**

In `packages/harnesses/src/inventory.ts`, extend the interface and rewrite `scanOne` around `detect()`. Note the single `detect()` call: the old body called `isInstalled()` and then `findBinary()`, which walked the PATH twice.

```typescript
/** One row of a node's harness inventory (spec 2026-08-31 §3.3, extended by 2026-09-09 §7). */
export interface HarnessInventoryEntry {
  /** Harness plugin id */
  harnessId: string;
  /** CLI binary found and executable from this machine's perspective */
  installed: boolean;
  /** `<binary> --version` output when installed and readable */
  version?: string;
  /** Resolved binary path when installed */
  binaryPath?: string;
  /**
   * Why the binary was not found. Absent when installed, and absent from
   * entries reported by an agent older than this field, which is why every
   * reader treats it as unknown rather than as a default.
   */
  reason?: DetectionReason;
  /** ISO 8601 stamp of when this entry was probed. Absent from pre-2026-09-09 agents. */
  checkedAt?: string;
}

export async function scanOne(h: HarnessPlugin, now: Date = new Date()): Promise<HarnessInventoryEntry> {
  const checkedAt = now.toISOString();
  try {
    const found = await h.detect();
    if (found.path === null) return { harnessId: h.id, installed: false, reason: found.reason, checkedAt };
    const version = await h.getVersion();
    return {
      harnessId: h.id,
      installed: true,
      binaryPath: found.path,
      ...(version ? { version } : {}),
      checkedAt,
    };
  } catch {
    // One broken plugin must never fail an entire scan. It reports as not
    // installed with no reason, because we genuinely do not have one.
    return { harnessId: h.id, installed: false, checkedAt };
  }
}
```

Give `scanHarnesses` the same optional clock and pass it through, so one batch shares one stamp:

```typescript
export async function scanHarnesses(now: Date = new Date()): Promise<HarnessInventoryEntry[]> {
  return Promise.all(ALL_HARNESSES.map((h) => scanOne(h, now)));
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd packages/harnesses && bun test`
Expected: PASS.

- [ ] **Step 5: Widen the wire shape**

In `packages/subshell-protocol/src/node-frames.ts`, the `inventory` event's element type gains the two optional fields:

```typescript
  | {
      type: "inventory";
      harnesses: {
        harnessId: string;
        installed: boolean;
        version?: string;
        binaryPath?: string;
        reason?: "not-on-path" | "override-invalid";
        checkedAt?: string;
      }[];
      ts: string;
    }
```

Do **not** bump `NODE_PROTOCOL_VERSION`. These are additive optional fields on an event the server already tolerates unknown keys on; the version bump belongs to phase 2, which adds commands an older agent genuinely cannot serve.

- [ ] **Step 6: Verify and commit**

```bash
bun run verify-types && bun run lint:check && bun run test
git add packages/harnesses packages/subshell-protocol
git commit -m "feat(harnesses): inventory entries carry a detection reason and a timestamp"
```

---

### Task 5: One detection code path on the server

`harnessInfo` hand-rolls its own probe: `isInstalled()` then `getVersion()`, no memo, no stamp, no reason, and a second PATH walk. The agent has had the right implementation all along. This deletes the duplicate.

**Files:**
- Modify: `apps/server/api/src/api/harness-utils.ts:75-95`
- Modify: `apps/server/api/src/api/models.ts:162-175`
- Test: `apps/server/api/src/api/__tests__/setup-route.test.ts`

**Interfaces:**
- Consumes: `scanOne` from Task 4.
- Produces: `HarnessInfoSchema` gains `reason?: "not-on-path" | "override-invalid"` and `checkedAt?: string`. `harnessInfo(id, enabled)` keeps its signature.

- [ ] **Step 1: Write the failing test**

Add to `apps/server/api/src/api/__tests__/setup-route.test.ts`:

```typescript
it("reports checkedAt on every harness, and a reason on the ones not found", async () => {
  const res = await app.handle(new Request("http://localhost/api/setup/harnesses"));
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    id: string;
    installed: boolean;
    checkedAt?: string;
    reason?: string;
  }[];
  expect(body.length).toBeGreaterThan(0);
  for (const h of body) {
    expect(typeof h.checkedAt).toBe("string");
    expect(Number.isFinite(Date.parse(h.checkedAt ?? ""))).toBe(true);
    if (h.installed) expect(h.reason).toBeUndefined();
    else expect(["not-on-path", "override-invalid"]).toContain(h.reason);
  }
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd apps/server/api && bun test src/api/__tests__/setup-route.test.ts`
Expected: FAIL, `checkedAt` is undefined.

- [ ] **Step 3: Widen the schema**

In `apps/server/api/src/api/models.ts`, add to `HarnessInfoSchema` after `version`:

```typescript
  reason: t.Optional(
    t.Union([t.Literal("not-on-path"), t.Literal("override-invalid")], {
      description: "Why the binary was not found: absent from PATH and the known locations, or an env override that does not point at an executable",
    }),
  ),
  checkedAt: t.Optional(t.String({ description: "ISO 8601 stamp of when detection last ran for this harness" })),
```

- [ ] **Step 4: Replace the hand-rolled probe**

In `apps/server/api/src/api/harness-utils.ts`, rewrite `harnessInfo` to delegate. Import `scanOne` from `@internal/harnesses`.

```typescript
/**
 * Report one plugin with fresh detection. The probe itself is
 * {@link scanOne}, the SAME function the node agent runs against its own
 * filesystem, so a local row and an agent row cannot disagree about what an
 * entry means. This used to be a second implementation here, which is how the
 * server came to report neither a reason nor a timestamp while the agent
 * reported both.
 */
export async function harnessInfo(id: string, enabled: boolean): Promise<Static<typeof HarnessInfoSchema>> {
  const h = getHarness(id);
  if (!h) throw new HarnessStateError("Unknown harness", 404);
  const entry = await scanOne(h);
  return {
    id: h.id,
    name: h.name,
    binary: h.binaryName,
    description: h.description,
    icon: h.icon,
    installed: entry.installed,
    version: entry.version,
    reason: entry.reason,
    checkedAt: entry.checkedAt,
    enabled,
    install: h.installHint,
  };
}
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `cd apps/server/api && bun test src/api/__tests__/setup-route.test.ts`
Expected: PASS.

- [ ] **Step 6: Verify and commit**

```bash
bun run verify-types && bun run lint:check && bun run test
git add apps/server/api
git commit -m "feat(server): harness detection goes through the agent's own scanOne"
```

---

### Task 6: The node view carries both facts per entry

`NodeHarnessViewSchema` has no room for either fact, and `effectiveHarnessStates` drops them on both branches. Per-entry rather than per-node, because unlike `inventoryStale` these differ row to row: one harness can be found while its neighbour has a broken override.

**Files:**
- Modify: `apps/server/api/src/api/nodes/node-view.ts:37-45`
- Modify: `apps/server/api/src/services/nodes/inventory.ts`
- Test: `apps/server/api/src/services/nodes/__tests__/inventory.test.ts`

**Interfaces:**
- Consumes: `HarnessInventoryEntry` from Task 4, `scanOne` from Task 5.
- Produces: `EffectiveHarnessState` gains `reason?: DetectionReason` and `checkedAt?: string`; `NodeHarnessViewSchema` gains the matching optional properties.

- [ ] **Step 1: Write the failing test**

Add to `apps/server/api/src/services/nodes/__tests__/inventory.test.ts`:

```typescript
it("carries reason and checkedAt from an agent's inventory entries", async () => {
  const node = {
    id: "n1",
    kind: "agent",
    inventoryJson: JSON.stringify([
      { harnessId: "claude-code", installed: false, reason: "override-invalid", checkedAt: "2026-09-09T12:00:00.000Z" },
    ]),
    inventoryAt: new Date().toISOString(),
  } as unknown as NodeTable;

  const report = await effectiveHarnessStates(node);
  const claude = report.harnesses.find((h) => h.harnessId === "claude-code");
  expect(claude?.reason).toBe("override-invalid");
  expect(claude?.checkedAt).toBe("2026-09-09T12:00:00.000Z");
});

it("stamps the local branch from its own live probe", async () => {
  const node = { id: "local", kind: "local" } as unknown as NodeTable;
  const report = await effectiveHarnessStates(node);
  for (const h of report.harnesses) {
    expect(typeof h.checkedAt).toBe("string");
  }
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd apps/server/api && bun test src/services/nodes/__tests__/inventory.test.ts`
Expected: FAIL, both fields undefined.

- [ ] **Step 3: Widen the view schema**

In `apps/server/api/src/api/nodes/node-view.ts`, add to `NodeHarnessViewSchema`:

```typescript
  reason: t.Optional(
    t.Union([t.Literal("not-on-path"), t.Literal("override-invalid")], {
      description: "Why the binary was not found, when it was not. Per entry, because one harness can be missing while another has a bad env override",
    }),
  ),
  checkedAt: t.Optional(
    t.String({ description: "ISO 8601 stamp of when this entry was probed. Absent from nodes running an agent older than this field" }),
  ),
```

- [ ] **Step 4: Carry both through the merge**

In `apps/server/api/src/services/nodes/inventory.ts`, add the two optional properties to `EffectiveHarnessState` with doc comments, then:

- **local branch:** replace the inline `installed: await h.isInstalled()` map with `scanOne(h, now)` for a shared `now`, and copy `installed`, `version`, `reason` and `checkedAt` off the entry.
- **agent branch:** copy `entry.reason` and `entry.checkedAt` alongside the existing `entry.version`, each only when present.

Import `scanOne` from `@internal/harnesses`.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `cd apps/server/api && bun test src/services/nodes/__tests__/inventory.test.ts`
Expected: PASS.

- [ ] **Step 6: Verify and commit**

```bash
bun run verify-types && bun run lint:check && bun run test
git add apps/server/api
git commit -m "feat(server): node harness rows carry the detection reason and timestamp"
```

---

### Task 7: The UI says why, and when

Two facts reach the screen. A bad env override stops being answered with an install command, and every list says how old its answer is.

**Files:**
- Create: `apps/server/web/src/lib/checked-at.ts`
- Test: `apps/server/web/src/lib/__tests__/checked-at.test.ts`
- Modify: `apps/server/web/src/types/harness.ts`
- Modify: `apps/server/web/src/types/node.ts`
- Modify: `apps/server/web/src/components/harness-install-help.tsx`
- Modify: `apps/server/web/src/components/harness-row.tsx`
- Modify: `apps/server/web/src/components/nodes/node-harness-card.tsx`
- Test: `apps/server/web/src/components/__tests__/harness-row.test.tsx`
- Test: `apps/server/web/src/components/__tests__/node-harness-card.test.tsx`

**Interfaces:**
- Consumes: the API fields from Tasks 5 and 6.
- Produces: `HarnessInfo` and `NodeHarness` each gain `reason?: "not-on-path" | "override-invalid"` and `checkedAt?: string`.

- [ ] **Step 1: Write the failing tests**

Add to `apps/server/web/src/components/__tests__/harness-row.test.tsx`:

The file's existing fixture is `const base: HarnessInfo` and it describes the **pi** harness (`id: "pi"`, `binary: "pi"`, install command `npm i -g @mariozechner/pi`), so the override name these cases expect is `PI_PATH`. Add inside the existing `describe("HarnessRow", ...)` block, which already calls `afterEach(cleanup)`:

```tsx
  it("names the env override instead of offering an install command", () => {
    render(
      <HarnessRow
        harness={{ ...base, installed: false, reason: "override-invalid" }}
        pending={false}
        onToggle={noop}
        onRecheck={noop}
      />,
    );
    expect(screen.getByText(/PI_PATH/)).toBeDefined();
    expect(screen.queryByText(/@mariozechner\/pi/)).toBeNull();
  });

  it("shows when detection last ran", () => {
    render(
      <HarnessRow
        harness={{ ...base, checkedAt: new Date().toISOString() }}
        pending={false}
        onToggle={noop}
        onRecheck={noop}
      />,
    );
    expect(screen.getByText(/^checked /)).toBeDefined();
  });

  it("says nothing about checking when the node reported no stamp", () => {
    render(<HarnessRow harness={base} pending={false} onToggle={noop} onRecheck={noop} />);
    expect(screen.queryByText(/^checked /)).toBeNull();
  });

- [ ] **Step 2: Run them and confirm they fail**

Run: `cd apps/server/web && bun test src/components/__tests__/harness-row.test.tsx`
Expected: FAIL, neither string is rendered.

- [ ] **Step 3: Widen the two frontend types**

In `apps/server/web/src/types/harness.ts`, add to `HarnessInfo`:

```typescript
  /** Why the binary was not found, when it was not */
  reason?: "not-on-path" | "override-invalid";
  /** ISO 8601 stamp of when detection last ran; absent from an older node */
  checkedAt?: string;
```

Add the same two properties, with the same comments, to `NodeHarness` in `apps/server/web/src/types/node.ts`.

- [ ] **Step 4: Branch the install help on the reason**

In `apps/server/web/src/components/harness-install-help.tsx`, add a branch above the existing not-installed body:

```tsx
  if (harness.reason === "override-invalid") {
    return (
      <div className="space-y-2">
        <p className="text-muted-foreground text-xs">
          The <code className="font-mono">{envOverrideName(harness.binary)}</code> environment variable is set, but it
          does not point at an executable file. Fix it or unset it, then re-check. Installing again will not help.
        </p>
        <Button type="button" variant="link" size="sm" className={denseLink} onClick={onRecheck} disabled={rechecking}>
          {rechecking ? "Checking…" : "Re-check"}
        </Button>
      </div>
    );
  }
```

Add the helper in the same file, since the override name is derivable and no endpoint carries it:

```tsx
/**
 * The env var a harness honours as an explicit binary override, from its
 * binary name. Every plugin follows `<BINARY>_PATH` (`CLAUDE_PATH`,
 * `CODEX_PATH`), which is a convention worth stating out loud because this is
 * the only place the UI needs the name and no endpoint reports it.
 */
function envOverrideName(binary: string): string {
  return `${binary.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_PATH`;
}
```

- [ ] **Step 5: Render the timestamp**

Add a shared helper at `apps/server/web/src/lib/checked-at.ts`:

```typescript
import { relativeElapsed } from "@/components/subshell-status";

/**
 * "checked 2m ago" for a detection stamp, or null when there is none.
 *
 * Absent is not an error: a node running an agent older than the field simply
 * has nothing to say, and a surface must render that as silence rather than as
 * "checked never", which would read as a failure.
 *
 * `relativeElapsed` answers "just now" under a minute and a bare "2m" / "3h"
 * above it, so the suffix cannot be unconditional or a fresh scan reads
 * "checked just now ago".
 */
export function checkedAtLabel(checkedAt: string | undefined): string | null {
  if (!checkedAt) return null;
  if (!Number.isFinite(Date.parse(checkedAt))) return null;
  const elapsed = relativeElapsed(checkedAt);
  return elapsed === "just now" ? "checked just now" : `checked ${elapsed} ago`;
}
```

`relativeElapsed(iso: string): string` is exported from
`apps/server/web/src/components/subshell-status.tsx:12` and takes the ISO
string directly, not a `Date`.

Give it a test at `apps/server/web/src/lib/__tests__/checked-at.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { checkedAtLabel } from "@/lib/checked-at";

describe("checkedAtLabel", () => {
  it("is silent when there is no stamp", () => {
    expect(checkedAtLabel(undefined)).toBeNull();
  });

  it("is silent for an unparseable stamp", () => {
    expect(checkedAtLabel("not a date")).toBeNull();
  });

  it("does not append 'ago' to 'just now'", () => {
    expect(checkedAtLabel(new Date().toISOString())).toBe("checked just now");
  });

  it("appends 'ago' to an elapsed duration", () => {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    expect(checkedAtLabel(tenMinutesAgo)).toBe("checked 10m ago");
  });
});
```

In `harness-row.tsx`, render it after the description:

```tsx
        {checkedAtLabel(harness.checkedAt) && (
          <p className="text-muted-foreground text-xs">{checkedAtLabel(harness.checkedAt)}</p>
        )}
```

In `node-harness-card.tsx`, render the same label on each row beside the installed badge.

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `cd apps/server/web && bun test src/lib/__tests__/checked-at.test.ts src/components/__tests__/harness-row.test.tsx src/components/__tests__/node-harness-card.test.tsx`
Expected: PASS.

- [ ] **Step 7: Verify and commit**

```bash
bun run verify-types && bun run lint:check && bun run test
git add apps/server/web
git commit -m "feat(web): harness lists say why a binary was not found and when detection ran"
```

---

### Task 8: Changeset and documentation

**Files:**
- Create: `.changeset/<generated>.md`
- Modify: `docs/security.md` (no change expected; confirm and note)

- [ ] **Step 1: Add the changeset**

Run `bunx changeset`, select `@internal/server` and `@internal/node`, choose **patch** for both, and describe it as: "Harness detection now reports why a binary was not found and when it was last checked, and the version probe can no longer hang a request."

- [ ] **Step 2: Confirm nothing security-relevant moved**

Phase 0 adds no endpoint, no credential path and no new exposure. `docs/security.md` needs no edit. Confirm by grepping for the harness section and reading it against this diff, and record in the commit message that it was checked.

- [ ] **Step 3: Full verification**

```bash
bun run verify-types && bun run lint:check && bun run test && bun run lint:licenses
```
Expected: all green. `rust:check` is not needed; no Rust changed.

- [ ] **Step 4: Commit**

```bash
git add .changeset
git commit -m "chore: changeset for harness detection reasons"
```
