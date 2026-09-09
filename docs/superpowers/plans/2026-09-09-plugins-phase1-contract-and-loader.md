# Plugins Phase 1: The Contract, the Loader, and the Rename

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the five compiled-in harness classes into five loadable plugin packages behind a published contract, with nothing user-visible changing.

**Architecture:** Three moves, in an order chosen so each is independently verifiable. First a new published contract package that nothing consumes yet. Then `packages/harnesses` becomes `packages/pane-runtime`, a pure mechanical rename across two dependents. Then a loader inside it, and the five plugins move out one at a time, each proving parity before the next. The static `ALL_HARNESSES` array is deleted last, when a loaded registry can replace it.

**Tech Stack:** Bun, TypeScript, tsdown, turbo, `bun test`.

**Spec:** `docs/superpowers/specs/2026-09-09-plugin-architecture-design.md` (§4, §5, §14, §15 phase 1)

## Global Constraints

- **Nothing user-visible changes in this phase.** No endpoint, no schema, no protocol version, no UI. If a change is visible, it belongs to phase 2 or later.
- **`await import()` is permitted in exactly one file**, `pane-runtime`'s plugin loader, and the exception is recorded in `.claude/rules/code-style.md`. Anywhere else it still breaks `bun build --compile`.
- **A plugin cannot import anything of ours.** Measured: a compiled binary loading a module from disk cannot resolve a bare specifier from it. Everything reaches a plugin through the host object. This is pinned by a test, not left as a convention.
- **`@subshell-ai/plugin-api` is types plus PURE helpers only.** A plugin bundles it in at build time, so anything with runtime behaviour freezes at the version the plugin was built against. Filesystem probes belong on the host object.
- **Published packages carry `"publishConfig": { "access": "public" }`** and are removed from the changeset `ignore` list. Every `@internal/*` workspace stays private and stays ignored.
- **Pinned dependency versions**, no `^` or `~`. New packages copy the exact devDependency versions in `packages/harnesses/package.json`.
- **Apache-2.0** on every new package, and none of them may live under `apps/server/**`. `bun run lint:licenses` enforces both.
- Verification after every task: `bun run verify-types`, `bun run lint:check`, `bun run test`. Also `bun run lint:licenses` on any task touching a `package.json`.
- **A known-failing test exists on main**: `uploads relay ... a ZERO-BYTE upload` in `@internal/server`. It is unrelated to this work. Do not treat it as a regression, and do not fix it here.

---

### Task 1: `@subshell-ai/plugin-api`, the contract nothing consumes yet

A new published package holding the types a plugin author compiles against. It is deliberately first and deliberately unconsumed: it can be reviewed as a contract, in isolation, before anything depends on its shape.

**Files:**
- Create: `packages/plugin-api/package.json`
- Create: `packages/plugin-api/tsconfig.json`
- Create: `packages/plugin-api/tsdown.config.ts`
- Create: `packages/plugin-api/src/index.ts`
- Create: `packages/plugin-api/src/types.ts`
- Create: `packages/plugin-api/src/manifest.ts`
- Test: `packages/plugin-api/src/__tests__/manifest.test.ts`

**Interfaces:**
- Produces: `SubshellPlugin`, `PluginHost`, `PluginType`, `PluginCapability`, `SubshellManifest`, `PLUGIN_API_VERSION`, and `parseManifest(pkgJson: unknown): SubshellManifest | { error: string }`.
- Consumes: nothing. This task adds no dependency to any existing package.

- [ ] **Step 1: Scaffold the package**

Copy `packages/harnesses/package.json` and change only what must differ. It is published, so it is NOT `private`:

```json
{
  "name": "@subshell-ai/plugin-api",
  "description": "The contract a Subshell plugin implements",
  "version": "0.1.0",
  "license": "Apache-2.0",
  "type": "module",
  "publishConfig": { "access": "public" },
  "main": "dist/index.js",
  "exports": { ".": { "types": "./dist/index.d.mts", "import": "./dist/index.mjs" } },
  "types": "dist/index.d.ts",
  "files": ["dist"],
  "scripts": {
    "build": "tsdown",
    "build:dev": "hash-runner",
    "clean": "rm -rf .turbo node_modules dist .hashes.json",
    "lint": "biome check --write --unsafe src && biome format src --write && biome lint src --fix",
    "lint:check": "biome check --no-errors-on-unmatched src",
    "lint:staged": "biome check --no-errors-on-unmatched --write --unsafe --staged src",
    "test": "bun test",
    "verify-types": "tsc --project tsconfig.json --noEmit"
  },
  "devDependencies": {
    "@internal/tsconfig": "workspace:*",
    "@types/bun": "1.3.14",
    "hash-runner": "4.0.0",
    "tsdown": "0.22.14",
    "typescript": "7.0.2"
  }
}
```

Copy `tsconfig.json` and `tsdown.config.ts` verbatim from `packages/harnesses/`.

- [ ] **Step 2: Write the manifest parser's failing test**

The manifest is the one runtime behaviour this package has, and it is pure, which is why it is allowed here. Create `packages/plugin-api/src/__tests__/manifest.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { PLUGIN_API_VERSION, parseManifest } from "../manifest.js";

/** A package.json that a valid plugin would ship. */
function pkg(over: Record<string, unknown> = {}): unknown {
  return {
    name: "@subshell-ai/plugin-claude-code",
    version: "1.0.0",
    subshell: {
      apiVersion: PLUGIN_API_VERSION,
      id: "claude-code",
      type: "agent-harness",
      name: "Claude Code",
      description: "Anthropic's agentic coding assistant",
      entry: "dist/index.js",
      detect: { binaryName: "claude", envOverride: "CLAUDE_PATH", knownPaths: [".local/bin/claude"] },
      install: { command: "npm i -g @anthropic-ai/claude-code", docsUrl: "https://example.invalid" },
      ...over,
    },
  };
}

describe("parseManifest", () => {
  it("accepts a well-formed manifest", () => {
    const result = parseManifest(pkg());
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.id).toBe("claude-code");
    expect(result.type).toBe("agent-harness");
    expect(result.detect.binaryName).toBe("claude");
  });

  it("rejects a package.json with no subshell key", () => {
    const result = parseManifest({ name: "x", version: "1.0.0" });
    expect("error" in result).toBe(true);
  });

  it("rejects an apiVersion this host cannot serve", () => {
    const result = parseManifest(pkg({ apiVersion: PLUGIN_API_VERSION + 1 }));
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    // The message must name both numbers: an operator seeing this needs to
    // know whether to upgrade the plugin or the agent.
    expect(result.error).toContain(String(PLUGIN_API_VERSION));
    expect(result.error).toContain(String(PLUGIN_API_VERSION + 1));
  });

  it("rejects an unknown plugin type rather than guessing", () => {
    expect("error" in parseManifest(pkg({ type: "wat" }))).toBe(true);
  });

  it("rejects an id that is not a safe path segment", () => {
    // The id becomes a directory name under <dataDir>/plugins/.
    expect("error" in parseManifest(pkg({ id: "../escape" }))).toBe(true);
    expect("error" in parseManifest(pkg({ id: "has space" }))).toBe(true);
  });

  it("rejects an entry that escapes the package directory", () => {
    expect("error" in parseManifest(pkg({ entry: "../../etc/passwd" }))).toBe(true);
    expect("error" in parseManifest(pkg({ entry: "/absolute/index.js" }))).toBe(true);
  });

  it("accepts a manifest with no detect block, for a plugin that needs no binary", () => {
    const bare = pkg();
    delete (bare as { subshell: Record<string, unknown> }).subshell.detect;
    expect("error" in parseManifest(bare)).toBe(false);
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `cd packages/plugin-api && bun test`
Expected: FAIL, cannot resolve `../manifest.js`.

- [ ] **Step 4: Write `src/types.ts`**

Transcribe the existing `packages/harnesses/src/types.ts` interfaces, with three changes: `HarnessPlugin` becomes `SubshellPlugin`, the capability methods become explicitly optional per §4.4, and `PluginHost` is added. Import nothing.

```typescript
/**
 * The contract a Subshell plugin implements.
 *
 * A plugin is loaded from disk by a compiled binary, which means it CANNOT
 * import anything of ours at runtime: measured on bun 1.4.2, a bare specifier
 * from a plugin file fails to resolve because there is no node_modules beside
 * it. Everything a plugin needs therefore arrives through {@link PluginHost},
 * handed to the factory. This file is types plus pure helpers ONLY, because a
 * plugin bundles it in at build time and anything with runtime behaviour would
 * freeze at the version the plugin was built against.
 */

/** What kind of thing a plugin provides. For humans: grouping, labels, catalog filters. */
export type PluginType = "agent-harness" | "terminal";

/**
 * What a plugin can DO. For code: the launch pipeline branches on these and
 * never on {@link PluginType}, so adding a type touches labels while adding a
 * capability touches the pipeline.
 */
export type PluginCapability = "mcp" | "resume" | "attention" | "settings";
```

Then carry over, unchanged in meaning: `ProfileDefinition`, `ProfileValidationIssue`, `ProfileValidationResult`, `BuildCommandInput`, `HarnessResume`, `McpLaunchSpec`, `McpRegistration`, `McpSetupStep`, `McpSetupInfo`, `SettingsField`, `InstallHint`, `MCP_SERVER_NAME`. Keep every JSDoc comment: they carry reasoning that is not re-derivable.

Add the host object:

```typescript
/**
 * Everything the host lends a plugin, because a plugin can import none of it.
 *
 * This is also the version boundary: a host at a higher `apiVersion` keeps
 * older plugins working by keeping the fields they were compiled against, so
 * fields are added here and never removed or retyped.
 */
export interface PluginHost {
  /** The API version this host implements. Always >= the plugin's own. */
  readonly apiVersion: number;
  /** Resolve a binary by the plugin's own detect rules, with the full ladder. */
  findBinary(name: string, envOverride: string, knownPaths: string[]): Promise<string | null>;
  /** Run a short command with a deadline and return trimmed stdout, or null. */
  probeVersion(binary: string, args?: string[]): Promise<string | null>;
  /** POSIX-quote one argument for a shell command line. */
  shellQuote(value: string): string;
  /** Structured logging, namespaced to the plugin. */
  log: { debug(msg: string): void; warn(msg: string): void };
}

/** The plugin itself. Only the first four members are required. */
export interface SubshellPlugin {
  buildCommand(input: BuildCommandInput): string[];
  validateProfile(profile: ProfileDefinition): ProfileValidationResult;
  /** Which optional members below are meaningful on this plugin. */
  capabilities(): PluginCapability[];
  /** Maps a harness exit code to a human label (null = unknown). */
  exitStatus?(code: number): string | null;

  detect?(): Promise<{ path: string } | { path: null; reason: string }>;
  resume?: HarnessResume;
  supportsAttentionHooks?: boolean;
  mcpRegistration?(launch: McpLaunchSpec, configPath: string): McpRegistration;
  mcpSetup?(launch: McpLaunchSpec): McpSetupInfo;
  profileSettings?(): SettingsField[];
  suggestedEnv?(): { key: string; description: string }[];
  suggestedFlags?(): { flag: string; description: string }[];
}

/** What a plugin module default-exports. */
export type PluginFactory = (host: PluginHost) => SubshellPlugin;
```

- [ ] **Step 5: Write `src/manifest.ts`**

```typescript
import type { PluginType } from "./types.js";

/** The contract version this package describes. Bumped only for a breaking change to `SubshellPlugin`. */
export const PLUGIN_API_VERSION = 1;

/** Ids become directory names under `<dataDir>/plugins/`, so they are path segments and nothing else. */
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const TYPES: readonly PluginType[] = ["agent-harness", "terminal"];

/** How a host finds this plugin's binary, as data, so a scan loads no plugin code. */
export interface DetectSpec {
  binaryName: string;
  envOverride: string;
  knownPaths: string[];
}

/** The `subshell` block of a plugin's package.json. */
export interface SubshellManifest {
  apiVersion: number;
  id: string;
  type: PluginType;
  name: string;
  description: string;
  icon?: string;
  entry: string;
  detect?: DetectSpec;
  install?: { command: string; docsUrl: string };
}

/**
 * Reads and validates the `subshell` block of a plugin's package.json.
 *
 * Returns `{ error }` rather than throwing, because every caller is reporting
 * a broken plugin to a person rather than handling an exception: the node
 * marks it broken and renders the message.
 */
export function parseManifest(pkgJson: unknown): SubshellManifest | { error: string } {
  if (typeof pkgJson !== "object" || pkgJson === null) return { error: "package.json is not an object" };
  const block = (pkgJson as { subshell?: unknown }).subshell;
  if (typeof block !== "object" || block === null) {
    return { error: "package.json has no `subshell` block, so it is not a Subshell plugin" };
  }
  const m = block as Record<string, unknown>;

  if (typeof m.apiVersion !== "number" || !Number.isInteger(m.apiVersion)) {
    return { error: "`subshell.apiVersion` must be an integer" };
  }
  if (m.apiVersion > PLUGIN_API_VERSION) {
    // Name BOTH numbers: the reader has to decide whether to upgrade the
    // plugin or the agent, and one number cannot tell them.
    return {
      error: `plugin needs plugin-api ${m.apiVersion}, this host implements ${PLUGIN_API_VERSION}; upgrade the agent`,
    };
  }
  if (typeof m.id !== "string" || !ID_RE.test(m.id)) {
    return { error: "`subshell.id` must be lowercase letters, digits and hyphens (it becomes a directory name)" };
  }
  if (typeof m.type !== "string" || !TYPES.includes(m.type as PluginType)) {
    return { error: `\`subshell.type\` must be one of: ${TYPES.join(", ")}` };
  }
  if (typeof m.name !== "string" || m.name.trim() === "") return { error: "`subshell.name` must be a non-empty string" };
  if (typeof m.description !== "string") return { error: "`subshell.description` must be a string" };
  if (m.icon !== undefined && typeof m.icon !== "string") return { error: "`subshell.icon` must be a string" };

  if (typeof m.entry !== "string" || m.entry.trim() === "") {
    return { error: "`subshell.entry` must be a non-empty relative path" };
  }
  // The entry is joined onto the plugin's directory and imported, so it must
  // not be able to name a file outside it. The loader re-checks the RESOLVED
  // path as well; this is the cheap first gate, not the only one.
  if (m.entry.startsWith("/") || m.entry.split("/").includes("..")) {
    return { error: "`subshell.entry` must stay inside the package (no leading / and no `..` segment)" };
  }

  let detect: DetectSpec | undefined;
  if (m.detect !== undefined) {
    const d = m.detect as Record<string, unknown>;
    if (
      typeof d !== "object" ||
      d === null ||
      typeof d.binaryName !== "string" ||
      typeof d.envOverride !== "string" ||
      !Array.isArray(d.knownPaths) ||
      !d.knownPaths.every((k) => typeof k === "string")
    ) {
      return { error: "`subshell.detect` needs binaryName, envOverride and a knownPaths array of strings" };
    }
    detect = { binaryName: d.binaryName, envOverride: d.envOverride, knownPaths: d.knownPaths as string[] };
  }

  let install: { command: string; docsUrl: string } | undefined;
  if (m.install !== undefined) {
    const i = m.install as Record<string, unknown>;
    if (typeof i !== "object" || i === null || typeof i.command !== "string" || typeof i.docsUrl !== "string") {
      return { error: "`subshell.install` needs a command and a docsUrl" };
    }
    install = { command: i.command, docsUrl: i.docsUrl };
  }

  return {
    apiVersion: m.apiVersion,
    id: m.id,
    type: m.type as PluginType,
    name: m.name,
    description: m.description,
    ...(typeof m.icon === "string" ? { icon: m.icon } : {}),
    entry: m.entry,
    ...(detect ? { detect } : {}),
    ...(install ? { install } : {}),
  };
}
```

Note the test asserts `result.detect.binaryName` on the happy path, so narrow
the union before reading it, or widen the test with a non-null assertion. The
first is better: `detect` really is optional.

- [ ] **Step 6: Write `src/index.ts` re-exporting both modules, then run the tests**

Run: `cd packages/plugin-api && bun test`
Expected: PASS, seven cases.

- [ ] **Step 7: Verify and commit**

```bash
bun run verify-types && bun run lint:check && bun run lint:licenses
git add packages/plugin-api
git commit -m "feat(plugin-api): the contract a Subshell plugin implements"
```

---

### Task 2: `packages/harnesses` becomes `packages/pane-runtime`

Pure mechanical rename, done on its own so its diff is reviewable as one. Measured blast radius: **two** real dependents (`apps/server/api`, 27 files; `apps/node/agent`, 11 files). `packages/subshell-protocol`, `packages/mcp-core` and `apps/server/web` mention the old name only in COMMENTS, and those are updated for accuracy, not correctness.

**Files:**
- Move: `packages/harnesses/` → `packages/pane-runtime/`
- Modify: `packages/pane-runtime/package.json` (name, description)
- Modify: `apps/server/api/package.json`, `apps/node/agent/package.json` (the dependency)
- Modify: 38 source files' import specifiers
- Modify: comment mentions in `packages/subshell-protocol/src/node-frames.ts:83`, `packages/mcp-core/src/server.ts:231`, `apps/server/web/src/lib/launch-command.ts:7`
- Modify: root `AGENTS.md` (the directory tree and the build-dependency list)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `@internal/pane-runtime`, exporting exactly what `@internal/harnesses` exported. No export is added, removed or renamed in this task.

- [ ] **Step 1: Move the directory and rename the package**

```bash
git mv packages/harnesses packages/pane-runtime
```

In `packages/pane-runtime/package.json` set:

```json
  "name": "@internal/pane-runtime",
  "description": "Running a subshell pane on this machine: binary detection, plugin loading, argv, tmux",
```

- [ ] **Step 2: Rewrite every import specifier**

```bash
grep -rl '@internal/harnesses' apps packages e2e --include='*.ts' --include='*.tsx' --include='*.json' \
  | grep -v node_modules \
  | xargs sed -i 's|@internal/harnesses|@internal/pane-runtime|g'
```

Then `bun install` so the workspace links resolve, and confirm the lockfile picked the rename up:

```bash
bun install
bun run lint:lockfile
```

- [ ] **Step 3: Verify the rename changed nothing else**

```bash
bun run verify-types && bun run lint:check && bun run test
```

Expected: green, except the known-failing zero-byte upload test named in the constraints. A failure anywhere else means the rename was not mechanical; stop and read it rather than pressing on.

- [ ] **Step 4: Update the prose that describes the tree**

In the root `AGENTS.md`, the `packages/` tree entry and the "Build Dependencies" list both name `harnesses`. Replace with `pane-runtime` and its new one-line description. Do the same for the three comment mentions listed under **Files**.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: packages/harnesses becomes packages/pane-runtime"
```

Write the body to say WHY, since the diff is large and uninformative: `harness` is becoming a plugin type, so a package holding tmux control, binary detection and five plugin classes cannot keep the name without naming two things.

---

### Task 3: The loader, and what happens when a plugin is bad

The one place in the repo allowed to `await import()`. Measured behaviour it must preserve: a top-level `throw` in a plugin IS contained by `try/catch` around the import, and a plugin can call `node:fs` freely, so the fault boundary is about containment and reporting, not sandboxing.

**Files:**
- Create: `packages/pane-runtime/src/plugin-runtime.ts`
- Create: `packages/pane-runtime/src/plugin-host.ts`
- Modify: `packages/pane-runtime/src/index.ts`
- Modify: `.claude/rules/code-style.md`
- Test: `packages/pane-runtime/src/__tests__/plugin-runtime.test.ts`
- Test fixtures: `packages/pane-runtime/src/__tests__/fixtures/plugins/{good,throws,no-default,bare-import}/`

**Interfaces:**
- Consumes: `PluginFactory`, `PluginHost`, `SubshellPlugin`, `parseManifest` from `@subshell-ai/plugin-api` (add it as a dependency of `pane-runtime`).
- Produces: `interface PluginRuntime { load(dir: string): Promise<LoadedPlugin | BrokenPlugin> }`; `createInProcessRuntime(host: PluginHost): PluginRuntime`; `createPluginHost(opts): PluginHost`; types `LoadedPlugin = { manifest: SubshellManifest; plugin: SubshellPlugin }` and `BrokenPlugin = { manifest: SubshellManifest | null; error: string }`.

- [ ] **Step 1: Write the fixtures**

Four plugin directories, each a `package.json` with a `subshell` block plus an entry file:

- `good/`: a factory returning a plugin whose `buildCommand` echoes the host's `shellQuote`, proving the host object is reachable.
- `throws/`: `throw new Error("plugin exploded at import")` at the top level.
- `no-default/`: a module with a named export and no default.
- `bare-import/`: `import { something } from "@internal/pane-runtime";`, which must fail. This fixture exists to pin the measured constraint that a plugin cannot import our packages, so that a future change making it accidentally possible is caught rather than silently relied upon.

- [ ] **Step 2: Write the failing test**

```typescript
import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { createInProcessRuntime } from "../plugin-runtime.js";
import { createPluginHost } from "../plugin-host.js";

const FIXTURES = join(import.meta.dir, "fixtures", "plugins");
const runtime = () => createInProcessRuntime(createPluginHost({ pluginId: "test" }));

describe("PluginRuntime", () => {
  it("loads a good plugin and hands it a working host", async () => {
    const result = await runtime().load(join(FIXTURES, "good"));
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.manifest.id).toBe("good");
    expect(result.plugin.buildCommand({ binary: "/bin/x" } as never)).toContain("/bin/x");
  });

  it("reports a plugin that throws at import as broken, without throwing", async () => {
    const result = await runtime().load(join(FIXTURES, "throws"));
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error).toContain("plugin exploded at import");
  });

  it("reports a module with no default export as broken", async () => {
    const result = await runtime().load(join(FIXTURES, "no-default"));
    expect("error" in result).toBe(true);
  });

  it("a plugin cannot import our packages", async () => {
    // Pinned deliberately: the whole host-object design exists BECAUSE this
    // fails. If it ever starts working, the contract has quietly changed.
    const result = await runtime().load(join(FIXTURES, "bare-import"));
    expect("error" in result).toBe(true);
  });

  it("one broken plugin does not affect its neighbour", async () => {
    const r = runtime();
    await r.load(join(FIXTURES, "throws"));
    expect("error" in (await r.load(join(FIXTURES, "good")))).toBe(false);
  });

  it("reports a directory with no manifest as broken rather than crashing", async () => {
    expect("error" in (await runtime().load(join(FIXTURES, "does-not-exist")))).toBe(true);
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `cd packages/pane-runtime && bun test src/__tests__/plugin-runtime.test.ts`
Expected: FAIL, cannot resolve `../plugin-runtime.js`.

- [ ] **Step 4: Implement `plugin-host.ts`**

`createPluginHost` wires the existing `detectBinary`, `probeVersion` and `shellQuote` into the `PluginHost` shape, with a logger namespaced by plugin id. It is a thin adapter and should stay one.

- [ ] **Step 5: Implement `plugin-runtime.ts`**

Read `<dir>/package.json`, `parseManifest` it, resolve `manifest.entry` against `dir` and assert the resolved path is still inside `dir`, then `await import()` the resolved path inside `try/catch`. Reject a module whose default export is not a function. Call the factory inside the same `try/catch`. Every failure answers `{ manifest, error }`.

The file carries the rule exception in its docstring:

```typescript
/**
 * Loading a plugin from disk.
 *
 * **This is the one file in the repo permitted to `await import()`.**
 * `.claude/rules/code-style.md` bans it because `bun build --compile` cannot
 * see through it and drops the target from the binary. Here that is the
 * mechanism rather than the bug: the target is a plugin the user installed
 * after the binary was built, and it MUST NOT be bundled. Measured on bun
 * 1.4.2: a compiled binary can import an absolute path at runtime, the loaded
 * module can call back into a host object passed as an argument, and it cannot
 * resolve a bare specifier of ours.
 *
 * The `PluginRuntime` interface exists so that moving to a Worker per plugin
 * later is one class rather than a rewrite. In-process is the only
 * implementation today, and it is honest about what it does not do: a plugin
 * runs with the agent's own privileges (see docs/security.md).
 */
```

- [ ] **Step 6: Record the exception in the rule**

Append to the "No Dynamic Imports" section of `.claude/rules/code-style.md`:

```markdown
**One exception, by name.** `packages/pane-runtime/src/plugin-runtime.ts` uses
`await import()` to load an installed plugin. There the bundler's blindness is
the point: the target is a plugin installed after the binary was built and must
not be bundled into it. No other file may use it, and a second exception should
be treated as a design question rather than a precedent.
```

- [ ] **Step 7: Run the tests, verify, commit**

```bash
cd packages/pane-runtime && bun test
cd ../.. && bun run verify-types && bun run lint:check && bun run test
git add -A
git commit -m "feat(pane-runtime): load plugins from disk behind a fault boundary"
```

---

### Task 4: Extract claude-code, and prove parity

The first real plugin package, done alone because it is the one with genuine logic (the resume probe, the settings-JSON merge with attention hooks). If the contract is wrong, it is wrong here, and finding that out before the other four move is the point of doing it separately.

**Files:**
- Create: `packages/plugins/claude-code/{package.json,tsconfig.json,tsdown.config.ts,src/index.ts}`
- Move: `packages/pane-runtime/src/claude-code.ts` → `packages/plugins/claude-code/src/index.ts`
- Move: `packages/pane-runtime/src/__tests__/claude-code*.test.ts` → the new package
- Modify: `packages/pane-runtime/src/index.ts` (drop the export, leave `ALL_HARNESSES` alone for now)
- Test: `packages/pane-runtime/src/__tests__/plugin-parity.test.ts`

**Interfaces:**
- Consumes: `PluginFactory` and every type from `@subshell-ai/plugin-api`; `PluginRuntime` from Task 3.
- Produces: `@subshell-ai/plugin-claude-code`, default-exporting a `PluginFactory`.

- [ ] **Step 1: Write the parity test first**

It loads the extracted package through the runtime and asserts it builds a byte-identical command to the class still in the tree. This is the test that makes the extraction safe, so it is written before the move. Every case exercises a different branch of `buildCommand`; a case producing the same argv as another is not a case.

```typescript
import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { ClaudeCodePlugin } from "../claude-code.js";
import { createPluginHost } from "../plugin-host.js";
import { createInProcessRuntime } from "../plugin-runtime.js";
import type { BuildCommandInput, ProfileDefinition, SubshellPlugin } from "@subshell-ai/plugin-api";

/** A profile with nothing set, so a case's own field is the only variable. */
const BLANK: ProfileDefinition = {
  name: "Default",
  description: null,
  env: {},
  flags: [],
  settings: null,
  configIsolation: false,
};

/** The fields every case shares; a case overrides only what it is testing. */
function input(over: Partial<BuildCommandInput>): BuildCommandInput {
  return { binary: "/bin/claude", cwd: "/tmp/work", profile: BLANK, subshellName: "", ...over };
}

const CASES: { name: string; input: BuildCommandInput }[] = [
  { name: "bare", input: input({}) },
  { name: "named subshell", input: input({ subshellName: "review" }) },
  {
    name: "mcp args splice in after the binary",
    input: input({ mcp: { fileContent: "{}", args: ["--mcp-config", "/tmp/x.json"] } }),
  },
  {
    name: "a new conversation pins its id",
    input: input({ harnessSession: { id: "11111111-2222-3333-4444-555555555555", mode: "start" } }),
  },
  {
    name: "an existing conversation resumes",
    input: input({ harnessSession: { id: "11111111-2222-3333-4444-555555555555", mode: "resume" } }),
  },
  {
    name: "profile settings merge under the attention hooks",
    input: input({ profile: { ...BLANK, settings: { permissionMode: "plan", model: "sonnet" } } }),
  },
  {
    name: "profile flags are passed as whole argv tokens",
    input: input({ profile: { ...BLANK, flags: ["--append-system-prompt", "be brief"] } }),
  },
  { name: "extra flags come last", input: input({ extraFlags: ["--verbose"] }) },
];

/** The extracted package, loaded exactly the way the agent will load it. */
async function loadExtracted(): Promise<SubshellPlugin> {
  const dir = join(import.meta.dir, "..", "..", "..", "plugins", "claude-code");
  const result = await createInProcessRuntime(createPluginHost({ pluginId: "claude-code" })).load(dir);
  if ("error" in result) throw new Error(`fixture failed to load: ${result.error}`);
  return result.plugin;
}

/**
 * The extraction must not change what gets executed.
 *
 * This compares the loaded plugin against the class it replaces on every
 * branch that varies, and is DELETED along with the class once it has served
 * its purpose. A difference here is a real behaviour change: understand it,
 * never absorb it by editing the expectation.
 */
describe("claude-code parity", () => {
  for (const c of CASES) {
    it(`builds the same argv: ${c.name}`, async () => {
      const legacy = new ClaudeCodePlugin().buildCommand(c.input);
      const loaded = await loadExtracted();
      expect(loaded.buildCommand(c.input)).toEqual(legacy);
    });
  }

  it("renders the same MCP registration", async () => {
    const launch = { command: "/bin/subshell-server", args: ["mcp"] };
    const legacy = new ClaudeCodePlugin().mcpRegistration(launch, "/tmp/mcp.json");
    const loaded = await loadExtracted();
    expect(loaded.mcpRegistration?.(launch, "/tmp/mcp.json")).toEqual(legacy);
  });

  it("maps the same exit codes", async () => {
    const legacy = new ClaudeCodePlugin();
    const loaded = await loadExtracted();
    for (const code of [0, 1, 5, 10, 11, 137]) {
      expect(loaded.exitStatus?.(code) ?? null).toEqual(legacy.exitStatus(code));
    }
  });

  it("declares the capabilities it actually implements", async () => {
    const loaded = await loadExtracted();
    // claude-code is the only built-in with resume, and the only one with
    // native attention hooks; both must survive the move.
    expect(loaded.capabilities().sort()).toEqual(["attention", "mcp", "resume", "settings"]);
  });
});
```

Read each case's expected shape off the existing `claude-code` tests before running: if one of these inputs is not a branch the current code distinguishes, replace it with one that is rather than keeping a case that proves nothing.

- [ ] **Step 2: Run it and confirm it fails**

Expected: FAIL, `packages/plugins/claude-code` does not exist.

- [ ] **Step 3: Create the package and move the file**

Scaffold as in Task 1 (published, `@subshell-ai/plugin-claude-code`, its own `subshell` manifest block carrying the id, type, entry and the detect data currently in `PLUGIN_KNOWN_PATHS` and the `CLAUDE_PATH` string). Then:

```bash
git mv packages/pane-runtime/src/claude-code.ts packages/plugins/claude-code/src/index.ts
```

Rewrite the file's head: it becomes a `PluginFactory` default export instead of a class, its imports come from `@subshell-ai/plugin-api`, and `findBinary`/`probeVersion`/`shellQuote` come off `host`. `detect` moves out of the code and into the manifest; the class's `#binaryOverride` seam goes away, since a test now points the runtime at a fixture instead.

- [ ] **Step 4: Run the parity test until it passes**

Run: `cd packages/pane-runtime && bun test src/__tests__/plugin-parity.test.ts`
Expected: PASS on every case. A difference here is a real behaviour change and must be understood, never absorbed by editing the expectation.

- [ ] **Step 5: Move the plugin's own tests across, verify, commit**

```bash
bun run verify-types && bun run lint:check && bun run test && bun run lint:licenses
git add -A
git commit -m "feat(plugins): extract claude-code into its own package"
```

---

### Task 5: Extract the remaining four

`opencode`, `hermes`, `pi`, `codex`. Each is the same shape as Task 4 and none has claude's logic, so they go together, but **each gets its own parity test and its own commit** so a bisect lands on one plugin.

**Files:** per plugin, mirroring Task 4.

**Interfaces:** produces `@subshell-ai/plugin-{opencode,hermes,pi,codex}`.

- [ ] **Step 1: For each plugin, in this order: opencode, hermes, pi, codex**

  - [ ] Write its parity test, covering every branch of its `buildCommand` (the settings-to-flag mappings differ per plugin, so read each one's cases off its existing tests)
  - [ ] Run it, confirm it fails
  - [ ] Scaffold the package, `git mv` the source, convert to a factory, move detect data into the manifest
  - [ ] Run the parity test, confirm it passes
  - [ ] Move its tests across
  - [ ] `bun run verify-types && bun run lint:check && bun run test`
  - [ ] Commit as `feat(plugins): extract <id> into its own package`

Two per-plugin notes, both from reading the current sources:

- **hermes** post-processes its version output (first line, then a semver match). That parsing moves with the plugin; only the spawn belongs to the host.
- **codex** renders its MCP registration as TOML and splices live `-c` overrides into argv. Its parity test must cover both, since the file content and the argv are produced by different methods.

---

### Task 6: The registry becomes what was loaded

`ALL_HARNESSES` is a static array of constructed classes. With the classes gone it becomes a registry of plugins the runtime loaded, and this is the task where the server and the agent stop importing plugin code.

**Files:**
- Create: `packages/pane-runtime/src/registry.ts`
- Modify: `packages/pane-runtime/src/index.ts` (delete `ALL_HARNESSES` and `getHarness`)
- Modify: `packages/pane-runtime/src/inventory.ts` (scan the registry, not the array)
- Modify: `apps/server/api` (5 files using `ALL_HARNESSES`, 7 using `getHarness`)
- Modify: `apps/node/agent` (its `getHarness` sites)
- Test: `packages/pane-runtime/src/__tests__/registry.test.ts`

**Interfaces:**
- Consumes: `PluginRuntime` from Task 3, the five packages from Tasks 4 and 5.
- Produces: `class PluginRegistry { load(dirs: string[]): Promise<void>; all(): LoadedPlugin[]; get(id: string): LoadedPlugin | undefined; broken(): BrokenPlugin[] }` and `builtInPluginDirs(): string[]`.

- [ ] **Step 1: Write the failing test**

Cover: an empty registry answers `[]` rather than throwing; loading the five built-ins yields five plugins with the expected ids; a directory containing one good and one broken plugin yields one in `all()` and one in `broken()`; `get()` on an unknown id is `undefined`; and loading twice is idempotent rather than duplicating.

- [ ] **Step 2: Run it, confirm it fails**

- [ ] **Step 3: Implement the registry**

`builtInPluginDirs()` resolves the five workspace packages for now. Phase 3 replaces it with the embedded set plus `<dataDir>/plugins/`; leave a comment saying so, and do NOT build the data-dir path here, because a half-built install path is worse than none.

- [ ] **Step 4: Migrate the consumers**

The server's `getHarness(id)` sites become registry lookups. The registry is constructed once per process and awaited at the point that already exists for it: the server's context graph, and the agent's daemon start. **The registry must not load during module evaluation.** The import-purity tests in `apps/server/api` pin that no module opens resources at import, and a loader that ran there would break the compiled binary's non-boot subcommands.

- [ ] **Step 5: Verify and commit**

```bash
bun run verify-types && bun run lint:check && bun run test
git add -A
git commit -m "refactor: the harness registry becomes the set of loaded plugins"
```

---

### Task 7: Housekeeping the phase cannot ship without

**Files:**
- Modify: `.changeset/config.json`
- Modify: root `AGENTS.md`
- Modify: `docs/architecture.md`
- Modify: `docs/security.md`
- Create: `.changeset/<generated>.md`
- Create: `packages/plugin-api/README.md`

- [ ] **Step 1: Take the published packages out of the changeset ignore list**

`@subshell-ai/plugin-api` and the five plugin packages are published; every `@internal/*` workspace stays ignored. Do NOT flip the global `access` to public: each published package carries its own `publishConfig`, which keeps a newly added private workspace unpublishable by default.

- [ ] **Step 2: Run every cross-package check**

```bash
bun run lint:packages    # syncpack: versions agree
bun run lint:lockfile    # bun.lock's workspace versions
bun run lint:licenses    # SPDX per path, and no new Apache->AGPL edge
```

All three must pass. `lint:licenses` is the one most likely to object, because six new packages carry new SPDX fields; `bun run lint:licenses:fix` writes them.

- [ ] **Step 3: Write the docs**

Root `AGENTS.md`: the `packages/` tree, the build-dependency list, and a short paragraph saying a plugin is an npm package the node loads. `docs/architecture.md` §4 currently describes per-harness MCP registration as something the plugin does inside our process; it now describes a loaded plugin. `docs/security.md` gains the paragraph from spec §13: installing a plugin is installing code that runs as the node's OS user, inside the agent process, with no sandbox claimed.

`packages/plugin-api/README.md` is the first thing a third-party author reads, so it carries a complete minimal plugin: a `package.json` with a `subshell` block, an `index.ts` exporting a factory, and the one sentence that explains the whole design, which is that a plugin cannot import anything of ours and receives the host instead.

- [ ] **Step 4: Add the changeset**

`bunx changeset`, selecting `@internal/server`, `@internal/node`, and the six new published packages. Minor for the new packages, patch for the two apps. Describe it as a refactor with no user-visible change, since that is exactly what phase 1 is.

- [ ] **Step 5: Full verification**

```bash
bun run verify-types && bun run lint:check && bun run test && bun run lint:licenses && bun run lint:packages && bun run lint:lockfile
```

Expected: all green except the known-failing zero-byte upload test.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "docs: plugins are packages, and the licence and release wiring for them"
```
