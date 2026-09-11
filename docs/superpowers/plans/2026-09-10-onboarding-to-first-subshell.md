# Onboarding: Download to First Subshell, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take a new user from launching the desktop app to a running subshell in four screens and one click, on a machine with no agent CLI installed.

**Architecture:** Three independent phases. Phase 1 adds a `terminal` built-in plugin so a clean machine can launch *something*, which is the precondition for everything else. Phase 2 makes the setup wizard end in that running subshell instead of an empty state. Phase 3 collapses the desktop console's four setup steps into one consented click and lets it install tmux and an agent CLI. Each phase leaves the product working and testable on its own.

**Tech Stack:** Bun 1.4+, TypeScript, ElysiaJS, React 19 + TanStack Router/Query, Tailwind, Kysely/SQLite, tsdown (plugin builds), Rust + Tauri v2 (Phase 3), Playwright (e2e).

**Spec:** `docs/superpowers/specs/2026-09-10-onboarding-to-first-subshell-design.md`. Read it before starting: the plan argues from it and does not repeat its reasoning.

## Global Constraints

- **No em dashes in any user-facing copy.** Rewrite the sentence instead.
- **Pinned dependency versions.** No `^` or `~` in any `package.json`. After `bun add`, run `bunx syncpack fix` then `bun install`.
- **No dynamic imports.** `await import()` breaks `bun build --compile`. The single sanctioned exception is `packages/pane-runtime/src/plugin-runtime.ts`; do not add a second.
- **Bun only.** `bun` / `bunx`, never npm, pnpm or yarn.
- **Every Elysia `t` schema property needs a `description`.**
- **Schemas are named constants**, never inline in a route or `registerTool` call.
- **Licence boundary:** every file this plan creates sits outside `apps/server/`, so it is Apache-2.0. Files under `apps/server/**` are AGPL-3.0-only. Do not move files across that line.
- **Verification after every task:** `bun run verify-types && bun run lint:check && bun run test`. Phase 3 also needs `bun run rust:check`.
- **Commit after every task.** Conventional commits (`feat(scope): …`, `fix(scope): …`, `test(scope): …`).
- **End every commit message with:**
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  ```

### One step a human must do, not an agent

`@subshell-ai/plugin-terminal` is a **new published package**. Per root `AGENTS.md`, a trusted publisher cannot be configured on npm for a package that does not exist yet, which is why the existing six were bootstrapped by hand at `0.0.1`. Before the first release that includes Phase 1, a maintainer must:

1. `npm publish` the package once at `0.0.1` manually.
2. Configure the npm trusted publisher for it, matching the other six.

CI publishes every version after that. **Nothing in this plan is blocked by it** (the package is consumed as `workspace:*` and ships compiled into the binary), so implement all three phases without waiting. Flag it in the PR description.

---

## File Structure

**Phase 1 creates:**

| File | Responsibility |
|---|---|
| `packages/plugins/terminal/package.json` | Identity: the `subshell` manifest block with the `SHELL` detect rule |
| `packages/plugins/terminal/tsconfig.json` | Build config, copied from a sibling plugin |
| `packages/plugins/terminal/tsdown.config.ts` | Bundles `plugin-api` in, so the loaded file resolves no bare specifier |
| `packages/plugins/terminal/src/manifest.ts` | Re-exports the parsed `subshell` block, one source of truth |
| `packages/plugins/terminal/src/index.ts` | The factory: capabilities and `buildCommand` |
| `packages/plugins/terminal/src/__tests__/terminal.test.ts` | Manifest, capabilities, argv, and the empty-`knownPaths` invariant |

**Phase 1 modifies:** `packages/pane-runtime/package.json`, `packages/pane-runtime/src/registry.ts`, `packages/pane-runtime/src/plugins-seed.ts`, four test files that hardcode a built-in count, `packages/pane-runtime/src/types.ts`, `packages/pane-runtime/src/plugin-adapter.ts`, `apps/server/api/src/api/models.ts`, `apps/server/api/src/api/harness-utils.ts`, `apps/server/api/src/index.ts`, `apps/server/web/src/components/harness-install-help.tsx`, `apps/server/web/src/types/harness.ts`.

**Phase 2 modifies:** `apps/server/api/src/api/files.route.ts`, `apps/server/web/src/hooks/use-recent-paths.ts`, `apps/server/web/src/components/subshell-picker/new-subshell-form.tsx`, `apps/server/web/src/routes/setup.tsx`. Creates one e2e spec.

**Phase 3 modifies:** `apps/server/desktop/src-tauri/src/control.rs`, `apps/server/desktop/src-tauri/src/lib.rs`, `apps/server/desktop/ui/main.js`. Creates `apps/server/desktop/ui/installers.js`.

---

# Phase 1: A clean machine can launch something

**Phase deliverable:** on a host with tmux and no agent CLI, a user can create a subshell from `/new` and get a live shell. Verify by hand at the end of the phase.

---

### Task 1: The `@subshell-ai/plugin-terminal` package

**Files:**
- Create: `packages/plugins/terminal/package.json`
- Create: `packages/plugins/terminal/tsconfig.json`
- Create: `packages/plugins/terminal/tsdown.config.ts`
- Create: `packages/plugins/terminal/src/manifest.ts`
- Create: `packages/plugins/terminal/src/index.ts`
- Test: `packages/plugins/terminal/src/__tests__/terminal.test.ts`

**Interfaces:**
- Consumes: `@subshell-ai/plugin-api` exports `PluginFactory`, `PluginHost`, `SubshellPlugin`, `BuildCommandInput`, `PluginCapability`, `ProfileDefinition`, `ProfileValidationResult`, `validateGenericProfile`, `parseManifest`, `SubshellManifest`.
- Produces: a default-exported `PluginFactory`, and a named `manifest: SubshellManifest` with `id: "terminal"`. Task 2 imports both.

- [ ] **Step 1: Create `packages/plugins/terminal/package.json`**

Copy the shape of `packages/plugins/pi/package.json` exactly, changing only what is listed. Note there is **no `install` block**: there is nothing to install.

```json
{
  "name": "@subshell-ai/plugin-terminal",
  "description": "Plain terminal plugin for Subshell",
  "version": "0.0.1",
  "license": "Apache-2.0",
  "type": "module",
  "main": "dist/index.js",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "types": "dist/index.d.ts",
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
    "@subshell-ai/plugin-api": "workspace:*",
    "@types/bun": "1.3.14",
    "hash-runner": "4.0.0",
    "tsdown": "0.22.14",
    "typescript": "7.0.2"
  },
  "files": [
    "dist"
  ],
  "publishConfig": {
    "access": "public"
  },
  "subshell": {
    "apiVersion": 1,
    "id": "terminal",
    "type": "terminal",
    "name": "Terminal",
    "description": "A plain shell in a subshell pane. No agent, nothing to install.",
    "icon": "▸",
    "entry": "dist/index.js",
    "detect": {
      "binaryName": "bash",
      "envOverride": "SHELL",
      "knownPaths": []
    }
  }
}
```

- [ ] **Step 2: Create `packages/plugins/terminal/tsconfig.json`**

```json
{
  "extends": "@internal/tsconfig/tsconfig.json",
  "include": ["./src/**/*"],
  "compilerOptions": {
    "types": ["bun"]
  }
}
```

- [ ] **Step 3: Create `packages/plugins/terminal/tsdown.config.ts`**

```ts
import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  outDir: "dist",
  format: ["esm"],
  sourcemap: false,
  target: ["es2024"],
  nodeProtocol: true,
  fixedExtension: false,
  dts: true,
  // A plugin is loaded from disk by a compiled binary and CANNOT resolve a
  // bare specifier, so nothing of ours may survive as an import in the output.
  // plugin-api is types plus pure helpers, which is exactly what makes it safe
  // to inline here.
  noExternal: ["@subshell-ai/plugin-api"],
});
```

- [ ] **Step 4: Create `packages/plugins/terminal/src/manifest.ts`**

```ts
import { parseManifest, type SubshellManifest } from "@subshell-ai/plugin-api";
import pkg from "../package.json" with { type: "json" };

/**
 * This package's own `subshell` block, read from its package.json so the
 * manifest has ONE source of truth.
 *
 * A host that installs this plugin at runtime reads package.json off disk; a
 * host that ships it built in imports this. Both must describe the same
 * plugin, and the only way to guarantee that is for them to be the same bytes.
 */
const parsed = parseManifest(pkg);
if ("error" in parsed) throw new Error(`@subshell-ai/plugin-terminal has an invalid manifest: ${parsed.error}`);

export const manifest: SubshellManifest = parsed;
```

- [ ] **Step 5: Write the failing test**

Create `packages/plugins/terminal/src/__tests__/terminal.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import type { BuildCommandInput, ProfileDefinition } from "@subshell-ai/plugin-api";
import createPlugin, { manifest } from "../index.js";

const BLANK: ProfileDefinition = {
  name: "Default",
  description: null,
  env: {},
  flags: [],
  settings: null,
  configIsolation: false,
};

function input(over: Partial<BuildCommandInput> = {}): BuildCommandInput {
  return { binary: "/bin/zsh", cwd: "/tmp/work", profile: BLANK, subshellName: "", ...over };
}

const plugin = () => createPlugin({} as never);

describe("terminal manifest", () => {
  it("is a terminal-type plugin", () => {
    expect(manifest.id).toBe("terminal");
    expect(manifest.type).toBe("terminal");
  });

  it("detects the user's login shell through SHELL", () => {
    // Rung 1 of detectBinaryWithOptions reads this variable and returns it
    // when it is executable, which is what makes this plugin resolve with
    // nothing installed. See the spec, section 3.1.
    expect(manifest.detect?.envOverride).toBe("SHELL");
    expect(manifest.detect?.binaryName).toBe("bash");
  });

  it("declares no knownPaths, because they are joined against HOME", () => {
    // binary-lookup.ts joins every knownPath against $HOME, so an absolute
    // "/bin/sh" would resolve to "$HOME/bin/sh" and silently never match.
    // Absolute fallbacks do not belong here; rungs 2 and 5 cover the case.
    expect(manifest.detect?.knownPaths).toEqual([]);
  });
});

describe("terminal plugin", () => {
  it("declares no capabilities", () => {
    // A bare shell has no MCP dialect, no resumable conversation, no
    // attention signal and no settings. Capabilities are validated at load,
    // so claiming one it does not implement would be a launch-time failure.
    expect(plugin().capabilities()).toEqual([]);
  });

  it("runs the resolved shell bare", () => {
    expect(plugin().buildCommand(input())).toEqual(["/bin/zsh"]);
  });

  it("appends profile flags, then extra flags, in that order", () => {
    const cmd = plugin().buildCommand(
      input({ profile: { ...BLANK, flags: ["-l"] }, extraFlags: ["-c", "echo hi"] }),
    );
    expect(cmd).toEqual(["/bin/zsh", "-l", "-c", "echo hi"]);
  });

  it("ignores the subshell name, having no flag for it", () => {
    expect(plugin().buildCommand(input({ subshellName: "review" }))).toEqual(["/bin/zsh"]);
  });

  it("accepts a blank profile", () => {
    expect(plugin().validateProfile(BLANK).valid).toBe(true);
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `bun test --cwd packages/plugins/terminal`
Expected: FAIL, cannot resolve `../index.js`.

- [ ] **Step 7: Create `packages/plugins/terminal/src/index.ts`**

```ts
import {
  type BuildCommandInput,
  type PluginCapability,
  type PluginFactory,
  type PluginHost,
  type ProfileDefinition,
  type ProfileValidationResult,
  type SubshellPlugin,
  validateGenericProfile,
} from "@subshell-ai/plugin-api";

const SUGGESTED_FLAGS: { flag: string; description: string }[] = [
  { flag: "-l", description: "Start a login shell, so the full profile is sourced" },
];

/**
 * Built-in: a plain terminal.
 *
 * Launch shape: the resolved shell, bare. tmux supplies the PTY, so nothing
 * here has to arrange one.
 *
 * **Why this plugin declares a `detect` block at all.** A `terminal` plugin
 * reads like it should declare none, and `no-binary` exists for exactly that
 * case. But that reason is wired through detection and DISPLAY only: both
 * inventories report `installed: false` for a null path, and
 * `subshell-manager.service.ts` refuses to launch one. A detect-less plugin
 * would therefore be invisible and unlaunchable. A shell IS a binary, so
 * this declares `SHELL` as its override and resolves through rung 1 of the
 * ordinary ladder instead, needing no change to the launch pipeline. See
 * `docs/superpowers/specs/2026-09-10-onboarding-to-first-subshell-design.md`
 * section 3.1.
 *
 * Identity, detection and install guidance live in this package's
 * package.json `subshell` block, NOT here: the host reads them without
 * importing or executing a line of this file.
 *
 * `host` carries what this module cannot import. See `@subshell-ai/plugin-api`.
 */
const createPlugin: PluginFactory = (_host: PluginHost): SubshellPlugin => ({
  // Deliberately empty. A shell has no MCP dialect to speak, no conversation
  // to resume, no attention signal to parse and no settings to edit. The host
  // validates this list at load, so naming a capability here that the plugin
  // does not implement produces a launch that fails rather than a feature.
  capabilities: (): PluginCapability[] => [],

  buildCommand(input: BuildCommandInput): string[] {
    const { binary, profile, extraFlags } = input;
    // No `--name` equivalent: a shell has no notion of a session title to be
    // told, so the subshell's display name stays a control-plane concept and
    // the reconcile sweep never adopts a title from this pane.
    // Each stored flag is one complete argv token, as in every other plugin.
    return [binary, ...profile.flags, ...(extraFlags ?? [])];
  },

  validateProfile(profile: ProfileDefinition): ProfileValidationResult {
    return validateGenericProfile(profile);
  },

  suggestedFlags(): { flag: string; description: string }[] {
    return SUGGESTED_FLAGS;
  },
});

export default createPlugin;
export { manifest } from "./manifest.js";
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `bun test --cwd packages/plugins/terminal`
Expected: PASS, 8 tests.

- [ ] **Step 9: Install and build**

```bash
bun install
bunx syncpack fix
bun install
bunx turbo build --filter=@subshell-ai/plugin-terminal
bun run lint:lockfile
```

If `lint:lockfile` fails, run `bun run lint:lockfile:fix`. Do not hand-edit `bun.lock` any other way, and do not delete it.

- [ ] **Step 10: Add a changeset**

Run `bunx changeset`, select `@subshell-ai/plugin-terminal`, choose **minor**, and use this summary:

```
A built-in `terminal` plugin: a plain shell in a subshell pane, with no agent and nothing to install.
```

- [ ] **Step 11: Commit**

```bash
git add packages/plugins/terminal .changeset bun.lock
git commit -m "$(cat <<'EOF'
feat(plugins): a built-in terminal plugin

`PluginType` has carried a "terminal" member since the plugin architecture
landed and nothing has ever run on it, so a machine with no agent CLI could
not launch anything at all.

It declares a `detect` block rather than relying on `no-binary`, because
that reason is plumbed through detection and display but not through
launching: both inventories report `installed: false` for a null path and
`subshell-manager.service.ts:297` refuses one. Declaring `SHELL` as the
override resolves the user's real login shell through rung 1 of the
existing ladder, so the launch pipeline needs no change.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Register it as a built-in

Built-ins are imported **statically** (`bun build --compile` has to see them), so a new directory under `packages/plugins/` is not enough on its own. Four existing tests hardcode a built-in count of five and will fail until updated; that is expected and each is listed below.

**Files:**
- Modify: `packages/pane-runtime/package.json`
- Modify: `packages/pane-runtime/src/registry.ts:3-7` (imports), `:44-50` (`BUILT_INS`)
- Test: `packages/pane-runtime/src/__tests__/embedded-plugins.test.ts:21`
- Test: `packages/pane-runtime/src/__tests__/installed-overlay.test.ts:32`
- Test: `packages/pane-runtime/src/__tests__/plugins-seed.test.ts:28,135`

**Interfaces:**
- Consumes: Task 1's default export and `manifest`.
- Produces: `getHarness("terminal")` resolves, and `allHarnesses()` includes it. Tasks 3, 6 and 8 depend on this.

- [ ] **Step 1: Update the four tests to expect six built-ins**

In `packages/pane-runtime/src/__tests__/installed-overlay.test.ts:32`, add the id in sorted position:

```ts
const BUILT_IN_IDS = ["claude-code", "codex", "hermes", "opencode", "pi", "terminal"];
```

In `packages/pane-runtime/src/__tests__/embedded-plugins.test.ts`, add `"terminal"` to that file's `BUILT_INS` constant, keeping its existing sort order.

In `packages/pane-runtime/src/__tests__/plugins-seed.test.ts`, change `.length).toBe(5)` at line 28 and `toHaveLength(5)` at line 135 to `6`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test --cwd packages/pane-runtime`
Expected: FAIL. The seed and overlay tests report 5 where 6 is expected, because the plugin is not registered yet.

- [ ] **Step 3: Add the workspace dependency**

In `packages/pane-runtime/package.json`, add to `dependencies`, keeping the keys alphabetical:

```json
"@subshell-ai/plugin-terminal": "workspace:*"
```

Then run `bun install`.

- [ ] **Step 4: Register the plugin**

In `packages/pane-runtime/src/registry.ts`, add the import after the `pi` import at line 7 (Biome sorts these; `terminal` follows `pi` alphabetically):

```ts
import terminalFactory, { manifest as terminalManifest } from "@subshell-ai/plugin-terminal";
```

Then add to `BUILT_INS`, last, so the array order still reads as the order they were added:

```ts
const BUILT_INS: BuiltIn[] = [
  { manifest: claudeCodeManifest, factory: claudeCodeFactory },
  { manifest: opencodeManifest, factory: opencodeFactory },
  { manifest: hermesManifest, factory: hermesFactory },
  { manifest: piManifest, factory: piFactory },
  { manifest: codexManifest, factory: codexFactory },
  { manifest: terminalManifest, factory: terminalFactory },
];
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
bunx turbo build --filter=@internal/pane-runtime
bun test --cwd packages/pane-runtime
```
Expected: PASS.

- [ ] **Step 6: Pin the mechanism this plugin depends on**

Task 1 asserted the manifest *declares* `envOverride: "SHELL"`. Nothing yet asserts that the lookup ladder actually honours it, which is the whole reason the plugin resolves on a machine with nothing installed. Add to `packages/pane-runtime/src/__tests__/binary-lookup.test.ts` (create it if absent, importing `detectBinaryWithOptions` from `../binary-lookup.js`):

```ts
describe("a plugin whose override is SHELL", () => {
  it("resolves the login shell at rung 1", async () => {
    // What makes the terminal plugin work with nothing installed: the
    // override rung answers before any PATH scan happens.
    const found = await detectBinaryWithOptions("bash", "SHELL", [], {
      env: { SHELL: "/bin/sh" },
      pathEntries: [],
    });

    expect(found).toEqual({ path: "/bin/sh" });
  });

  it("falls through to bash on PATH when SHELL is unset", async () => {
    const found = await detectBinaryWithOptions("bash", "SHELL", [], {
      env: {},
      pathEntries: ["/bin", "/usr/bin"],
    });

    expect(found.path).toMatch(/bash$/);
  });

  it("reports override-invalid rather than searching past a broken SHELL", async () => {
    // An override that does not resolve is an answer, not a hint. The UI
    // names the variable (see Task 4), so this reason has to survive.
    const found = await detectBinaryWithOptions("bash", "SHELL", [], {
      env: { SHELL: "/nonexistent/shell" },
      pathEntries: ["/bin", "/usr/bin"],
    });

    expect(found).toEqual({ path: null, reason: "override-invalid" });
  });
});
```

Run: `bun test --cwd packages/pane-runtime binary-lookup`
Expected: PASS. These describe behaviour that already exists, so they should pass immediately; a failure means the ladder is not what the plugin assumes and Task 1 needs revisiting before going further.

- [ ] **Step 7: Full verification**

```bash
bun run verify-types && bun run lint:check && bun run test
```
Expected: all green. If a test elsewhere counts harnesses, update the count, and note which in the commit body.

- [ ] **Step 8: Commit**

```bash
git add packages/pane-runtime bun.lock
git commit -m "$(cat <<'EOF'
feat(pane-runtime): register the terminal plugin as a built-in

Built-ins are imported statically because `bun build --compile` has to see
them, so a directory under packages/plugins is not enough on its own.

Four tests hardcoded a built-in count of five and now expect six.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Seeding becomes a per-id record

`seedBuiltIns` writes a `.seeded` marker whose mere presence stops every later seed. That rule protects a real property: an empty plugins directory is an operator who uninstalled everything, and re-seeding on emptiness would undo that on every restart. But it also means **an upgraded instance never receives a newly added built-in**, which has never mattered because the set has never grown. Task 2 grew it.

**Files:**
- Modify: `packages/pane-runtime/src/plugins-seed.ts:44-80`
- Modify: `apps/server/api/src/index.ts:123,145` (comments only)
- Test: `packages/pane-runtime/src/__tests__/plugins-seed.test.ts`

**Interfaces:**
- Consumes: `builtInIds()` from `./builtin-source.js`, `installEmbedded`, `pluginsDir`, `pluginLog` from `./plugins-dir.js`.
- Produces: `seedBuiltIns(dataDir, ids?) => Promise<string[]>`, signature unchanged, returning only the ids installed by **this** pass.

- [ ] **Step 1: Write the failing tests**

Append to `packages/pane-runtime/src/__tests__/plugins-seed.test.ts`. Match the existing file's helpers for making a temp data dir; read the top of the file first and reuse them rather than writing new ones.

```ts
describe("seeding a store that has already been seeded", () => {
  it("installs a built-in the store has never seen, and only that one", async () => {
    const dir = await freshDataDir();
    await seedBuiltIns(dir, ["claude-code", "codex"]);

    const second = await seedBuiltIns(dir, ["claude-code", "codex", "terminal"]);

    expect(second).toEqual(["terminal"]);
    expect((await listInstalled(dir)).sort()).toEqual(["claude-code", "codex", "terminal"]);
  });

  it("never resurrects a built-in the operator uninstalled", async () => {
    const dir = await freshDataDir();
    await seedBuiltIns(dir, ["claude-code", "codex"]);
    await uninstallPlugin(dir, "codex");

    const second = await seedBuiltIns(dir, ["claude-code", "codex"]);

    // Seeded once, so it is in the record and never seeded again. This is
    // the property the original boolean marker existed to protect.
    expect(second).toEqual([]);
    expect(await listInstalled(dir)).toEqual(["claude-code"]);
  });

  it("treats a legacy marker as the five pre-terminal built-ins", async () => {
    const dir = await freshDataDir();
    const root = pluginsDir(dir);
    await mkdir(root, { recursive: true, mode: 0o700 });
    // What the old code wrote: a timestamp, not JSON.
    await writeFile(join(root, ".seeded"), `${new Date().toISOString()}\n`, { mode: 0o600 });

    const seeded = await seedBuiltIns(dir, ["claude-code", "codex", "terminal"]);

    // An instance upgrading from before this change gains the new built-in
    // and nothing else, whatever it had uninstalled.
    expect(seeded).toEqual(["terminal"]);
  });

  it("records ids as JSON so a later pass can read them", async () => {
    const dir = await freshDataDir();
    await seedBuiltIns(dir, ["claude-code"]);

    const raw = await readFile(join(pluginsDir(dir), ".seeded"), "utf8");

    expect(JSON.parse(raw)).toEqual(["claude-code"]);
  });
});
```

Add whatever imports these need at the top of the file (`mkdir`, `writeFile`, `readFile` from `node:fs/promises`, `join` from `node:path`, `pluginsDir` and `uninstallPlugin` from `../plugins-dir.js`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test --cwd packages/pane-runtime plugins-seed`
Expected: FAIL. The second `seedBuiltIns` call returns `[]` because the marker exists, and the record is a timestamp rather than JSON.

- [ ] **Step 3: Implement the per-id record**

In `packages/pane-runtime/src/plugins-seed.ts`, replace the `SEEDED_MARKER` constant and the whole `seedBuiltIns` function with:

```ts
/** Records which built-ins this store has ever seeded; its CONTENTS stop a re-seed. */
const SEEDED_MARKER = ".seeded";

/**
 * The built-ins that existed before the marker recorded ids.
 *
 * A legacy marker is a timestamp, which says a seed completed but not of
 * what. It can only have been these five, so that is what it reads as. Frozen
 * deliberately: this is a historical fact about old instances, not the
 * current built-in set, and appending to it would re-seed something an
 * operator uninstalled.
 */
const PRE_RECORD_BUILT_INS = ["claude-code", "codex", "hermes", "opencode", "pi"] as const;

/**
 * Which built-ins this store has already seeded.
 *
 * Absent marker = none, so a virgin store seeds everything. A marker that is
 * not a JSON array of strings was written by the pre-record implementation
 * and means {@link PRE_RECORD_BUILT_INS}.
 */
async function seededIds(marker: string): Promise<Set<string>> {
  if (!existsSync(marker)) return new Set();
  try {
    const parsed: unknown = JSON.parse(await readFile(marker, "utf8"));
    if (Array.isArray(parsed) && parsed.every((v) => typeof v === "string")) return new Set(parsed);
  } catch {
    // Fall through: unreadable or not JSON is the legacy shape.
  }
  return new Set(PRE_RECORD_BUILT_INS);
}

/**
 * Installs the built-ins this store has never seeded.
 *
 * Was keyed on the marker's EXISTENCE, which made the seed a one-time event
 * and meant a built-in added in a later release could never reach an instance
 * that had already booted. The marker now records which ids were seeded, so
 * the set can grow while the property that mattered is unchanged: an id in
 * the record is never installed again, so an uninstall still sticks forever.
 * @param dataDir - the data dir whose plugins directory is the store
 * @param ids - which built-ins to consider (defaults to every one this build carries)
 * @returns the ids actually installed by THIS pass; empty when there is nothing new
 */
export async function seedBuiltIns(dataDir: string, ids?: string[]): Promise<string[]> {
  const root = pluginsDir(dataDir);
  const marker = join(root, SEEDED_MARKER);
  const already = await seededIds(marker);
  const wanted = ids ?? (await builtInIds());
  const todo = wanted.filter((id) => !already.has(id));

  await mkdir(root, { recursive: true, mode: 0o700 });
  await enforceMode(root, 0o700);

  const seeded: string[] = [];
  for (const id of todo) {
    try {
      await installEmbedded(dataDir, id);
      seeded.push(id);
    } catch (err) {
      // One built-in that cannot be installed must not cost the instance every
      // other harness it could have offered. It stays OUT of the record, so
      // the next boot retries it.
      pluginLog().warn(`could not seed built-in plugin "${id}", continuing with the rest`, err);
    }
  }

  // Last, and only on the way out. Written before the loop it would record a
  // seed that never happened; written on a throw it would record a partial
  // one. Its name cannot be a plugin id (`listInstalled` skips non-ids, and a
  // file is not a directory either), so it never shows up as a plugin.
  //
  // The union, not `seeded`: everything previously recorded stays recorded,
  // including the five a legacy marker stood for, or an upgrade would offer
  // to re-seed what an operator had removed.
  await writeFile(marker, JSON.stringify([...already, ...seeded].sort()), { mode: 0o600 });
  if (seeded.length > 0) {
    pluginLog().info(`seeded ${seeded.length} built-in plugin(s) into ${root}: ${seeded.join(", ")}`);
  }
  return seeded;
}
```

Add `readFile` to the `node:fs/promises` import at the top of the file.

- [ ] **Step 4: Update the module docblock**

The docblock above `SEEDED_MARKER` still says the seed runs "exactly once" and is "one-way by construction". Replace the two paragraphs beginning "**The check is a MARKER FILE, not the directory.**" and ending "…is the separate concern of keeping an installed built-in current." with:

```
 * **The check is the MARKER'S CONTENTS, not the directory and not the
 * marker's existence.** Directory existence looked equivalent to a completed
 * seed and was not: `installEmbedded` creates the directory before it writes
 * anything, so a kill during the very first seed left a directory that
 * seeding then skipped forever. Existence of the marker fixed that and
 * introduced a second problem: it made seeding a one-time EVENT, so a
 * built-in added in a later release could never reach an instance that had
 * already booted. The marker therefore records WHICH ids were seeded.
 *
 * It must not be emptiness either. An empty directory is an operator who
 * uninstalled everything, and re-seeding would undo that on every restart,
 * which is why an id in the record is never installed a second time even when
 * it is absent from disk: "I want nothing here" has to be reachable.
 *
 * One-way per id. It never removes and never upgrades;
 * `refreshStaleBuiltIns` is the separate concern of keeping an installed
 * built-in current.
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test --cwd packages/pane-runtime plugins-seed`
Expected: PASS, including the pre-existing cases.

- [ ] **Step 6: Comment the load-bearing boot order**

A plugin in the store that a user has no profile for cannot be launched. Boot already fixes this, in an order nothing currently explains. In `apps/server/api/src/index.ts`, add above the line at 123:

```ts
    // BEFORE ensureDefaultProfilesEverywhere below, and that order is
    // load-bearing: seeding can add a built-in this instance has never had
    // (the plugins-seed record), and the backfill is what gives every
    // existing user a Default profile for it. Reversed, an upgraded instance
    // would show a harness nobody can launch until the next restart.
```

and above the line at 145:

```ts
    // AFTER prepareLocalPlugins above. See the note there.
```

- [ ] **Step 7: Full verification**

```bash
bun run verify-types && bun run lint:check && bun run test
```

- [ ] **Step 8: Commit**

```bash
git add packages/pane-runtime apps/server/api/src/index.ts
git commit -m "$(cat <<'EOF'
fix(pane-runtime): the seed marker records ids, so the built-in set can grow

`.seeded` stopped every later seed by existing, which made seeding a
one-time event: a built-in added in a later release could never reach an
instance that had already booted. It now records which ids were seeded.

The property the boolean protected is unchanged. An id in the record is
never installed again even when absent from disk, so an operator's
uninstall still sticks forever. A legacy timestamp marker reads as the five
built-ins that existed before this change.

Also comments the boot order in index.ts: seeding must precede the default
profile backfill, or an upgraded instance shows a harness nobody can launch.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `envOverride` reaches the UI

`harness-install-help.tsx` derives the override variable name from the binary (`envOverrideName` produces `CLAUDE_PATH` from `claude`). Every built-in has happened to follow `<BINARY>_PATH`, so this has been right by coincidence. `terminal` is the first plugin whose override is not that shape: a broken `$SHELL` would produce a message naming `BASH_PATH`, which the user does not have set and changing would not help.

**Files:**
- Modify: `packages/pane-runtime/src/types.ts:66` area (the `HarnessPlugin` interface)
- Modify: `packages/pane-runtime/src/plugin-adapter.ts` (populate it)
- Modify: `apps/server/api/src/api/models.ts:162-186` (`HarnessInfoSchema`)
- Modify: `apps/server/api/src/api/harness-utils.ts` (`harnessInfo`)
- Modify: `apps/server/web/src/types/harness.ts` (`HarnessInfo`)
- Modify: `apps/server/web/src/components/harness-install-help.tsx`
- Test: `apps/server/web/src/components/__tests__/harness-install-help.test.tsx` (create if absent)

**Interfaces:**
- Produces: `HarnessInfo.envOverride: string` on the wire and in the web types. No later task consumes it.

- [ ] **Step 1: Write the failing test**

Create or extend `apps/server/web/src/components/__tests__/harness-install-help.test.tsx`. Read a neighbouring component test first and copy its render helper and imports.

```tsx
it("names the variable the plugin actually honours, not one derived from the binary", () => {
  render(
    <HarnessInstallHelp
      harness={{
        id: "terminal",
        name: "Terminal",
        binary: "bash",
        envOverride: "SHELL",
        description: "A plain shell in a subshell pane.",
        installed: false,
        reason: "override-invalid",
        installedHere: true,
        install: { command: "", docsUrl: "" },
      }}
      onRecheck={() => {}}
    />,
  );

  expect(screen.getByText(/SHELL/)).toBeTruthy();
  expect(screen.queryByText(/BASH_PATH/)).toBeNull();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test --cwd apps/server/web harness-install-help`
Expected: FAIL, the rendered text says `BASH_PATH`.

- [ ] **Step 3: Carry `envOverride` on the plugin type**

In `packages/pane-runtime/src/types.ts`, beside `binaryName` in the `HarnessPlugin` interface:

```ts
  /**
   * The environment variable this plugin honours as an explicit binary
   * override, from its manifest `detect.envOverride` ("" when it declares no
   * detect block).
   *
   * Carried rather than derived. Every built-in happened to follow
   * `<BINARY>_PATH`, so deriving it was right by coincidence until the
   * terminal plugin, whose override is `SHELL`. A UI that derives the name
   * tells a user to fix a variable they do not have set.
   */
  envOverride: string;
```

In `packages/pane-runtime/src/plugin-adapter.ts`, populate it in the object `adaptPlugin` returns, beside where `binaryName` is set:

```ts
    envOverride: manifest.detect?.envOverride ?? "",
```

- [ ] **Step 4: Put it on the wire**

In `apps/server/api/src/api/models.ts`, inside `HarnessInfoSchema`, after the `binary` property:

```ts
  envOverride: t.String({
    description:
      'Environment variable that overrides binary lookup for this plugin, e.g. "CLAUDE_PATH" or "SHELL"; empty when the plugin declares no detection',
  }),
```

In `apps/server/api/src/api/harness-utils.ts`, in the object `harnessInfo` returns, after `binary: h.binaryName,`:

```ts
    envOverride: h.envOverride,
```

- [ ] **Step 5: Mirror it in the web types**

In `apps/server/web/src/types/harness.ts`, add to the `HarnessInfo` interface after `binary`:

```ts
  /** Environment variable that overrides binary lookup, e.g. "CLAUDE_PATH"; "" when the plugin declares no detection */
  envOverride: string;
```

- [ ] **Step 6: Read it instead of deriving it**

In `apps/server/web/src/components/harness-install-help.tsx`, replace `{envOverrideName(harness.binary)}` with `{harness.envOverride}`, and **delete the whole `envOverrideName` function and its docblock at the bottom of the file**. Do not keep it as a fallback: a fallback here is a wrong answer that looks like a right one.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `bun test --cwd apps/server/web harness-install-help`
Expected: PASS.

- [ ] **Step 8: Full verification**

```bash
bunx turbo build
bun run verify-types && bun run lint:check && bun run test
```

`turbo build` first: `backend-client` infers its types from the server's exported `App`, so a new response field is invisible to the web app until the server is rebuilt. Other harness fixtures in web tests will now fail type checking for the missing `envOverride`; add it to each.

- [ ] **Step 9: Commit**

```bash
git add packages/pane-runtime apps/server/api apps/server/web
git commit -m "$(cat <<'EOF'
fix(web,server): name the override variable a plugin actually honours

`envOverrideName` derived the variable from the binary name, which was right
by coincidence: every built-in followed <BINARY>_PATH. The terminal plugin's
override is SHELL, so a broken value produced a message naming BASH_PATH, a
variable the user does not have set and changing would not help.

`envOverride` is in the manifest already. It now rides HarnessInfo, and the
derivation is deleted rather than kept as a fallback.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Phase 1 gate

- [ ] **Run the full suite:** `bun run verify-types && bun run lint:check && bun run test`
- [ ] **Verify by hand.** Start the stack (`bun run start`), open `http://localhost:5174`, complete the wizard **without installing any agent CLI**, then create a subshell from `/new` picking the **Terminal** profile and any directory. A live shell must appear and accept typing.
- [ ] **Code review this phase** before starting Phase 2, per the project's review-per-phase practice. Use the `code-reviewer` agent.

---

# Phase 2: The wizard ends in a running subshell

**Phase deliverable:** "Finish setup" lands the user in a live terminal instead of on an empty state, in one click, with no typed path.

---

### Task 5: `/api/files/recent` reports the node's home directory

`useRecentPaths` is empty by definition on a fresh instance, so `NewSubshellForm`'s pre-fill cannot fire and the field falls back to placeholder text. Home is the fallback, and this route is the natural carrier: it is already node-scoped and already fetched by that form.

**Files:**
- Modify: `apps/server/api/src/api/files.route.ts:226-273` and its `RecentResponseSchema`
- Test: `apps/server/api/src/api/__tests__/files-route.test.ts` (match the existing file name in that directory)

**Interfaces:**
- Produces: `GET /api/files/recent` responds `{ paths: {path, label}[], home: string | null }`. Task 6 consumes `home`.

- [ ] **Step 1: Write the failing test**

Add to the recent-paths describe block in the files route test file, reusing its existing authenticated-request helper:

```ts
it("reports the control-plane host's home directory", async () => {
  const res = await authedGet("/api/files/recent");

  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.home).toBe(homedir());
});
```

Import `homedir` from `node:os` at the top of the test file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test --cwd apps/server/api files-route`
Expected: FAIL, `body.home` is undefined.

- [ ] **Step 3: Extend the response schema**

Find `RecentResponseSchema` in `apps/server/api/src/api/files.route.ts` and add the property:

```ts
  home: t.Nullable(
    t.String({
      description:
        "Home directory on the node this list is scoped to, for pre-filling a working directory when there are no recents; null when the node has not reported one",
    }),
  ),
```

- [ ] **Step 4: Return it**

In the `/recent` handler, replace the final `return { paths } as const;` with:

```ts
      // The pre-fill fallback: a fresh instance has no recents at all, so
      // without this the new-subshell form opens on an empty absolute-path
      // box at exactly the moment the user knows least. For an agent node
      // this is what it reported on `ready`; the plane cannot see its disk,
      // and an offline node has no facts, which is why this is nullable.
      const home = nodeId === LOCAL_NODE_ID ? homedir() : (getLive(nodeId)?.agent?.homeDir ?? null);
      return { paths, home } as const;
```

Add two imports at the top of the route file:

```ts
import { homedir } from "node:os";
import { getLive } from "@/services/nodes/node-registry.js";
```

`getLive(id)?.agent` is the cached `NodeAgentFacts` from the node's `ready` frame, which is exactly how `remote-launcher.ts:144-147` reaches `homeDir`. **No new round trip**: the value is already in the registry.

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test --cwd apps/server/api files-route`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/api
git commit -m "$(cat <<'EOF'
feat(server): /api/files/recent reports the node's home directory

A fresh instance has no recent paths, so the new-subshell form's pre-fill
cannot fire and the working-directory field opens empty. Home is the
fallback, and this route already carries the node scoping the fallback needs.

For an agent node the value is the one it reported on `ready`, so this adds
no round trip.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `NewSubshellForm` defaults a directory and a profile

These apply to both launch paths, not just the wizard, and they are what make Phase 2's last step one click.

**Files:**
- Modify: `apps/server/web/src/hooks/use-recent-paths.ts`
- Modify: `apps/server/web/src/components/subshell-picker/new-subshell-form.tsx` (the single correction effect)
- Test: `apps/server/web/src/components/__tests__/new-subshell-form.test.tsx` (match the existing name)

**Interfaces:**
- Consumes: Task 5's `home` field.
- Produces: no new exports. Task 8 relies on the behaviour: a mounted `NewSubshellForm` with profiles loaded becomes submittable without user input.

- [ ] **Step 1: Write the failing tests**

Add to the form's test file, reusing its existing query-client and mock-fetch helpers:

```tsx
it("falls back to the node's home directory when there are no recent paths", async () => {
  mockRecent({ paths: [], home: "/home/ada" });

  renderForm();

  await waitFor(() => expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ workingDir: "/home/ada" })));
});

it("prefers a recent path over home", async () => {
  mockRecent({ paths: [{ path: "/srv/app", label: null }], home: "/home/ada" });

  renderForm();

  await waitFor(() => expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ workingDir: "/srv/app" })));
});

it("never overwrites a directory the caller already holds", async () => {
  mockRecent({ paths: [], home: "/home/ada" });

  renderForm({ workingDir: "/typed/by/hand" });

  await waitFor(() => expect(screen.getByLabelText("Working directory")).toHaveValue("/typed/by/hand"));
  expect(onChange).not.toHaveBeenCalledWith(expect.objectContaining({ workingDir: "/home/ada" }));
});

it("selects the first launchable profile when none is chosen", async () => {
  mockProfiles([
    { id: "p-claude", name: "Default", harnessId: "claude-code", nodeId: null },
    { id: "p-term", name: "Default", harnessId: "terminal", nodeId: null },
  ]);

  renderForm();

  await waitFor(() => expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ profileId: "p-claude" })));
});

it("never selects a profile that cannot run on the chosen node", async () => {
  // buildProfileOptions disables what the node cannot run; the auto-select
  // must read that, or it parks the form on a launch the server will refuse.
  mockProfiles([
    { id: "p-claude", name: "Default", harnessId: "claude-code", nodeId: null },
    { id: "p-term", name: "Default", harnessId: "terminal", nodeId: null },
  ]);
  mockNodes([{ id: "local", name: "Server", status: "online", harnesses: ["terminal"] }]);

  renderForm();

  await waitFor(() => expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ profileId: "p-term" })));
});
```

Adapt the mock helper names to whatever the existing file uses. If the file has no such helpers, add them beside the existing mocks rather than inventing a new mocking style.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test --cwd apps/server/web new-subshell-form`
Expected: FAIL on all five.

- [ ] **Step 3: Carry `home` through the hook**

In `apps/server/web/src/hooks/use-recent-paths.ts`, change the fetch's type parameter and document the field:

```ts
/** The `/recent` response: a node's recent working directories, plus its home as a fallback. */
export interface RecentPathsResponse {
  /** Recently used directories, newest first */
  paths: RecentPath[];
  /** The node's home directory, or null when it has not reported one */
  home: string | null;
}
```

and use `apiFetch<RecentPathsResponse>(…)` in both branches of the existing `queryFn`.

- [ ] **Step 4: Extend the single correction effect**

In `new-subshell-form.tsx`, the one `useEffect` holds every automatic correction on purpose, so both defaults go **inside it**, not in effects of their own. Replace the pre-fill block:

```ts
    if (!prefillDoneRef.current) {
      const first = recent?.paths[0]?.path;
      if (first) {
        prefillDoneRef.current = true;
        if (next.workingDir === "") next = { ...next, workingDir: first };
      }
    }
```

with:

```ts
    if (!prefillDoneRef.current) {
      // Most recent path, else the node's home. A fresh instance has no
      // recents at all, and an empty absolute-path box is the highest-friction
      // field in the product at the moment the user knows least about it.
      // Gate on the QUERY having answered, not on a value being present:
      // keying off `first` alone left the flag unset forever on a node with no
      // recents, so a later unrelated render could still fire the pre-fill.
      const fallback = recent?.paths[0]?.path ?? recent?.home ?? "";
      if (recent !== undefined) {
        prefillDoneRef.current = true;
        if (fallback && next.workingDir === "") next = { ...next, workingDir: fallback };
      }
    }
```

Then, immediately before the closing `if (next !== value) onChange(next);`, add the profile default:

```ts
    // First launchable profile, when the user has not chosen one. Reads the
    // same disabled set the dropdown renders (`buildProfileOptions` computes
    // it against the chosen node), so this can never select a pairing the
    // server would refuse. Only ever fills a blank: a cleared profile is not
    // a state this form offers, so there is nothing to fight.
    if (next.profileId === "" && profiles !== undefined && nodes !== null) {
      const firstUsable = buildProfileOptions(profiles, selectedNode).find((o) => !o.disabled);
      if (firstUsable) next = { ...next, profileId: firstUsable.value };
    }
```

Add `profiles` to the effect's dependency array beside the existing entries.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test --cwd apps/server/web new-subshell-form`
Expected: PASS, and every pre-existing test in the file still passes. If a pre-existing test breaks because a profile is now auto-selected, that test's expectation was describing the old blank form; update it and say so in the commit body.

- [ ] **Step 6: Full verification**

```bash
bun run verify-types && bun run lint:check && bun run test
```

- [ ] **Step 7: Commit**

```bash
git add apps/server/web
git commit -m "$(cat <<'EOF'
feat(web): the new-subshell form defaults a directory and a profile

The working-directory field opened empty on a fresh instance, because
useRecentPaths has nothing to offer until a subshell has been created. It
now falls back to the node's home, and a recent path still wins over it.

The profile picker auto-selects the first LAUNCHABLE option, read off the
same disabled set the dropdown renders, so it cannot park the form on a
pairing the server would refuse.

Both live in the single correction effect, which exists so that composing
one final value makes cross-effect clobbering impossible.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: The harness step becomes optional

With `terminal` always usable, this step can no longer dead-end, and it should stop reading like a requirement.

**Files:**
- Modify: `apps/server/web/src/routes/setup.tsx:139-190` (the `step === 1` block) and `STEPS`
- Test: `apps/server/web/src/routes/__tests__/setup.test.tsx` (match the existing name)

**Interfaces:**
- Produces: `STEPS` becomes `["Account", "Agent", "Launch"] as const`. Task 8 adds the third step's body.

- [ ] **Step 1: Write the failing test**

```tsx
it("presents the agent step as optional and says what happens if you skip it", async () => {
  renderSetupAtStep(1);

  expect(screen.getByText(/Add an agent \(optional\)/)).toBeTruthy();
  expect(screen.getByText(/plain terminal/i)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Finish setup" })).toBeNull();
});
```

Reuse the file's existing helper for rendering the wizard at a given step. If none exists, add one rather than duplicating setup inside each test.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test --cwd apps/server/web setup`
Expected: FAIL, the button is still "Finish setup".

- [ ] **Step 3: Rename the steps**

```ts
const STEPS = ["Account", "Agent", "Launch"] as const;
```

- [ ] **Step 4: Rewrite the step's copy and its button**

In the `step === 1` block, replace the leading `<p>` with a heading and honest copy:

```tsx
              <div className="space-y-1">
                <p className="font-medium">Add an agent (optional)</p>
                <p className="text-muted-foreground text-sm">
                  Install a coding-agent CLI and switch it on to run agent subshells. You can skip this: a subshell can
                  run a plain terminal, and you can add an agent any time from Settings.
                </p>
              </div>
```

and replace the "Finish setup" button with:

```tsx
              <Button className="w-full" disabled={busy} onClick={() => setStep(2)}>
                Continue
              </Button>
```

Leave the harness list, the loading and error branches, and the "register a Node" escape hatch exactly as they are. The node link is still the right answer for someone whose agents live on another machine.

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test --cwd apps/server/web setup`
Expected: PASS. The wizard now advances to a step that renders nothing; Task 8 fills it.

- [ ] **Step 6: Commit**

```bash
git add apps/server/web/src/routes/setup.tsx apps/server/web/src/routes/__tests__
git commit -m "$(cat <<'EOF'
feat(web): the wizard's agent step is optional and says so

With a terminal plugin always usable this step can no longer dead-end, so
it stops reading like a requirement. The node escape hatch stays: it is
still the right answer when the agents live on another machine.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: The launch step

The point of the whole plan. The wizard's last action lands the user in a live terminal.

**Files:**
- Modify: `apps/server/web/src/routes/setup.tsx`
- Test: `apps/server/web/src/routes/__tests__/setup.test.tsx`

**Interfaces:**
- Consumes: `NewSubshellForm`, `emptyNewSubshellForm`, `canSubmit`, `NewSubshellFormValue` from `@/components/subshell-picker/new-subshell-form`; `useCreateSubshell` from `@/hooks/use-create-subshell`; `createSubshellErrorMessage` from `@/lib/create-subshell-error`. All exist; `/new` (`apps/server/web/src/routes/new.tsx`) is the working reference for wiring them together.

- [ ] **Step 1: Write the failing tests**

```tsx
it("launches a subshell and lands on it", async () => {
  const created = { id: "sub-1" };
  mockCreateSubshell(created);
  renderSetupAtStep(2);

  await waitFor(() => expect(screen.getByRole("button", { name: "Start my first subshell" })).toBeEnabled());
  await userEvent.click(screen.getByRole("button", { name: "Start my first subshell" }));

  await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/subshells/$id", params: { id: "sub-1" } }));
});

it("retires the setup-status cache on launch, so the shell does not bounce back", async () => {
  mockCreateSubshell({ id: "sub-1" });
  renderSetupAtStep(2);

  await userEvent.click(screen.getByRole("button", { name: "Start my first subshell" }));

  await waitFor(() => expect(queryClient.getQueryData(["setup-status"])).toEqual({ needsSetup: false }));
});

it("lets a user leave without launching, and still finishes setup", async () => {
  renderSetupAtStep(2);

  await userEvent.click(screen.getByRole("button", { name: "Skip for now" }));

  expect(queryClient.getQueryData(["setup-status"])).toEqual({ needsSetup: false });
  expect(navigate).toHaveBeenCalledWith({ to: "/" });
});

it("reports a create failure without trapping the user", async () => {
  mockCreateSubshellFailure({ code: "NODE_OFFLINE" });
  renderSetupAtStep(2);

  await userEvent.click(screen.getByRole("button", { name: "Start my first subshell" }));

  await waitFor(() => expect(screen.getByText(/offline/i)).toBeTruthy());
  expect(screen.getByRole("button", { name: "Skip for now" })).toBeTruthy();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test --cwd apps/server/web setup`
Expected: FAIL, step 2 renders nothing.

- [ ] **Step 3: Add the imports and state**

At the top of `setup.tsx`, add:

```tsx
import {
  canSubmit,
  emptyNewSubshellForm,
  NewSubshellForm,
  type NewSubshellFormValue,
} from "@/components/subshell-picker/new-subshell-form";
import { useCreateSubshell } from "@/hooks/use-create-subshell";
import { createSubshellErrorMessage } from "@/lib/create-subshell-error";
```

Inside `SetupPage`, beside the other state:

```tsx
  // Launch step. The form defaults itself (node `local`, the first launchable
  // profile, the node's home directory), so this is one click unless the user
  // wants it to be more.
  const [launchForm, setLaunchForm] = useState<NewSubshellFormValue>(emptyNewSubshellForm);
  const create = useCreateSubshell();
```

- [ ] **Step 4: Make `finish` reusable and add `launch`**

Replace the existing `finish` function with:

```tsx
  /**
   * Retires the shared setup-status cache before navigating.
   *
   * It still says needsSetup:true for its staleTime window (10 s), and the
   * Subshells page reads it on its first render and bounces straight back to
   * /setup, so a wizard finished in under 10 s would be trapped there. Both
   * exits from the last step go through this.
   */
  function completeSetup() {
    queryClient.setQueryData(["setup-status"], { needsSetup: false });
  }

  function finish() {
    completeSetup();
    navigate({ to: "/" });
  }

  /** Launches the first subshell and lands the user in it. */
  async function launch() {
    try {
      const created = await create.mutateAsync(launchForm);
      completeSetup();
      void navigate({ to: "/subshells/$id", params: { id: created.id } });
    } catch {
      // The mutation keeps the error; it renders below the form. Setup is
      // deliberately NOT completed here: the user is still on the step and
      // can retry or skip, and skipping is what finishes.
    }
  }
```

- [ ] **Step 5: Render the step**

After the `step === 1` block, add:

```tsx
          {step === 2 && (
            <div className="space-y-4">
              <div className="space-y-1">
                <p className="font-medium">Start your first subshell</p>
                <p className="text-muted-foreground text-sm">
                  Everything below is already filled in. Change anything you like, or just start it.
                </p>
              </div>

              <NewSubshellForm
                value={launchForm}
                onChange={setLaunchForm}
                ids={{
                  profile: "setup-profile",
                  workingDir: "setup-working-dir",
                  name: "setup-subshell-name",
                  node: "setup-node",
                }}
              />

              {create.error && (
                <p className="text-destructive text-sm">
                  {createSubshellErrorMessage(create.error, "Failed to start the subshell")}
                </p>
              )}

              <Button
                className="w-full"
                disabled={create.isPending || !canSubmit(launchForm)}
                onClick={() => void launch()}
              >
                {create.isPending ? "Starting…" : "Start my first subshell"}
              </Button>

              {/* Never a dead end: a machine that cannot launch anything must
                  still be able to leave the wizard and reach the app. */}
              <Button variant="link" className="w-full" disabled={create.isPending} onClick={finish}>
                Skip for now
              </Button>
            </div>
          )}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test --cwd apps/server/web setup`
Expected: PASS.

- [ ] **Step 7: Full verification**

```bash
bun run verify-types && bun run lint:check && bun run test
```

- [ ] **Step 8: Commit**

```bash
git add apps/server/web
git commit -m "$(cat <<'EOF'
feat(web): the setup wizard ends in a running subshell

It ended one step short of the only event that proves the product works:
"Finish setup" landed on an empty state, and reaching a live terminal from
there took two more clicks and a typed absolute path.

The new last step reuses NewSubshellForm whole. With Task 6's defaults it
is one click, and "Skip for now" means a machine that cannot launch
anything still finishes setup rather than trapping the user.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: The e2e spec that proves the claim

**Files:**
- Create: `e2e/tests/<next-number>-onboarding-clean-machine.spec.ts` (read `e2e/AGENTS.md` and list `e2e/tests/` first; follow the numbering and the fixtures the existing specs use)

- [ ] **Step 1: Read the e2e conventions**

Read `e2e/AGENTS.md` and the existing spec `e2e/tests/01-*.spec.ts` for how a fresh instance is set up and how the wizard is driven. Do not invent a fixture style.

- [ ] **Step 2: Write the spec**

The assertions, in order. Use the existing specs' locators and helpers for each.

```ts
test("a machine with no agent CLI reaches a live terminal through the wizard", async ({ page }) => {
  await page.goto("/setup");

  // Step 1: account.
  await page.getByLabel("Name").fill("Ada");
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Password", { exact: true }).fill("correct-horse-battery");
  await page.getByLabel("Confirm password").fill("correct-horse-battery");
  await page.getByRole("button", { name: "Create admin account" }).click();

  // Step 2: skip the agent entirely. This is the whole point: nothing is
  // installed, and the wizard must still reach a subshell.
  await expect(page.getByText("Add an agent (optional)")).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();

  // Step 3: the form arrives filled in. Assert that before clicking, so a
  // regression in the defaults fails here rather than as a disabled button.
  await expect(page.locator("#setup-working-dir")).not.toHaveValue("");
  const start = page.getByRole("button", { name: "Start my first subshell" });
  await expect(start).toBeEnabled();
  await start.click();

  // A live pane, on the subshell's own page.
  await expect(page).toHaveURL(/\/subshells\//);
  await expect(page.locator(".xterm-screen")).toBeVisible();
});
```

- [ ] **Step 3: Run it**

```bash
bunx playwright install chromium   # once, if not already installed
bun run test:e2e
```
Expected: PASS. This suite boots its own backend on `:3199` with a temp database. **Never point it at the live instance on `:3080`.**

- [ ] **Step 4: Commit**

```bash
git add e2e
git commit -m "$(cat <<'EOF'
test(e2e): a clean machine reaches a live terminal through the wizard

The claim the build could not make before this branch: complete setup with
no agent CLI installed and end up typing into a pane. Asserts the launch
step arrives pre-filled, so a regression in the defaults fails as a bad
value rather than as a disabled button.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Phase 2 gate

- [ ] **Run:** `bun run verify-types && bun run lint:check && bun run test && bun run test:e2e`
- [ ] **Verify by hand** on a fresh database: the wizard is three steps, the last arrives filled in, and one click lands on a live terminal.
- [ ] **Code review this phase** before starting Phase 3.

---

# Phase 3: One click from app launch to dashboard

Rust and vanilla JS. **Read `apps/server/desktop/AGENTS.md` before starting.** Every task here also needs `bun run rust:check`, which stages a sidecar stub for you; a plain `cargo clippy` dies in `tauri-build` on a clean checkout.

**Phase deliverable:** opening the app on a clean machine presents one screen with one button, and pressing it installs, configures, registers, starts and opens the dashboard.

---

### Task 10: `ProbeStep::Setup` and the collapsed console step

**Files:**
- Modify: `apps/server/desktop/src-tauri/src/control.rs:33-48` (`ProbeStep`), the probe's step selection, and a new command
- Modify: `apps/server/desktop/src-tauri/src/lib.rs:90-105` (`invoke_handler`)
- Modify: `apps/server/desktop/ui/main.js:286-365` (`STEPS`)
- Test: `apps/server/desktop/src-tauri/src/control.rs` (a `#[cfg(test)]` module, as the file already has)

**Interfaces:**
- Produces: `ProbeStep::Setup` serializing as `"setup"`, and a command `desktop_setup() -> Result<ActionResult, String>` that runs install, init, service install and start in order. Tasks 11 and 12 add commands beside it.

- [ ] **Step 1: Read the existing command pattern**

Read `desktop_install_server` and `desktop_init` in `apps/server/desktop/src-tauri/src/control.rs` in full, plus `ActionResult`, `run`, `ACTION_TIMEOUT` and `server_cmd`. Task 10 composes these; it does not introduce a new way of running things.

- [ ] **Step 2: Write the failing Rust test**

In `control.rs`'s existing test module:

```rust
#[test]
fn setup_is_the_entry_step_when_nothing_is_installed() {
    // `install-server` named one act in a four-act chain the console already
    // knew how to compute. The chain is now one consented press, so the step
    // that used to start it is the step that runs it.
    assert_eq!(
        serde_json::to_string(&ProbeStep::Setup).unwrap(),
        "\"setup\""
    );
}
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd apps/server/desktop/src-tauri && cargo test setup_is_the_entry_step`
Expected: FAIL to compile, no variant `Setup`.

- [ ] **Step 4: Add the variant**

In the `ProbeStep` enum, replace `InstallServer` with:

```rust
    /// No server, but one is bundled: the whole setup chain, behind one press.
    Setup,
```

and update every match arm the compiler flags. The probe should now yield `ProbeStep::Setup` wherever it previously yielded `ProbeStep::InstallServer`. Leave `Init`, `InstallService`, `Start`, `Ready`, `Unreachable` and `NoServer` exactly as they are: each describes a machine already part-way through that needs one specific act, not a fresh run.

- [ ] **Step 5: Add the `desktop_setup` command**

Add beside `desktop_install_server`, following its shape exactly (`#[tauri::command(async)]`, same `State` parameters, same `ActionResult` return):

```rust
/// The whole first-run chain, behind one consented press.
///
/// Install, configure, register as a service, start. Every one of these has a
/// correct default and asks the user nothing they can answer on day one, so
/// the console used to spend four clicks and four form fields executing a plan
/// it had already made.
///
/// **Stops at the first failure.** A half-run leaves the machine in a state
/// the ordinary probe describes, so the console falls back to the step that
/// names it and the user is never worse off than the four-step flow left them.
/// The CLI's own words are returned verbatim; two surfaces that phrase the
/// same refusal differently are two surfaces that drift.
#[tauri::command(async)]
pub fn desktop_setup(settings: State<'_, SettingsState>) -> Result<ActionResult, String> {
    let mut log = String::new();
    for step in [
        SetupStep::InstallServer,
        SetupStep::Init,
        SetupStep::ServiceInstall,
        SetupStep::Start,
    ] {
        let result = step.run(&settings)?;
        log.push_str(&result.stdout);
        log.push('\n');
        if !result.ok {
            return Ok(ActionResult { ok: false, stdout: log, stderr: result.stderr });
        }
    }
    Ok(ActionResult { ok: true, stdout: log, stderr: String::new() })
}
```

Define `SetupStep` as a private enum in the same file whose `run` delegates to the existing helpers each current command already uses. **Do not call the `#[tauri::command]` functions from each other**: extract the body each one shares into a plain function and have both call it, so the command layer stays a thin wrapper. `desktop_init` is the one to study, since a setup run must pass the derived defaults rather than a form payload.

- [ ] **Step 6: Register the command**

In `apps/server/desktop/src-tauri/src/lib.rs`, add `control::desktop_setup,` to `generate_handler!`, after `control::desktop_install_server,`.

- [ ] **Step 7: Run the Rust tests**

```bash
bun run rust:check
```
Expected: fmt clean, no clippy warnings, tests pass.

- [ ] **Step 8: Replace the console's step**

In `apps/server/desktop/ui/main.js`, replace the entire `"install-server"` entry in `STEPS` with:

```js
  setup: {
    body: "Set up Subshell on this machine.",
    hint:
      "Installs the bundled server to ~/.local/bin, writes ~/.config/subshell-server/config.env (port 3080, all " +
      "interfaces), registers it to start at login, starts it, and opens the dashboard. Nothing is downloaded.",
    actions: () => [
      ["Set up and start", doSetup, true, true],
      ["Change addresses…", showConfigure],
      ["Choose an existing server…", pickBinary],
    ],
  },
```

and add the handler beside the other action handlers:

```js
/**
 * The whole chain, one press.
 *
 * Disclosed rather than silent: installing a binary and registering a
 * background service is not something to do unasked, so this is one INFORMED
 * click instead of four uninformed ones. The step's hint is the disclosure,
 * and it is what makes collapsing the four steps honest.
 */
const doSetup = guarded(async () => {
  const result = await invoke("desktop_setup");
  show(result);
  if (result.ok) await openMain();
});
```

Use whatever wrapper the existing handlers use for the busy flag, the re-probe and the error capture. Read `doInit` and `service()` first and follow the same shape; `guarded` above is a placeholder name for that existing wrapper, so use the real one.

- [ ] **Step 9: Verify by hand**

```bash
cd apps/server/desktop && bun run dev:app
```
You need a staged sidecar first. The recipe is in `apps/server/desktop/AGENTS.md` under "The staged sidecar". On a machine where the server is already installed, temporarily move `~/.local/bin/subshell-server` aside to see the `setup` step.

- [ ] **Step 10: Commit**

```bash
git add apps/server/desktop
git commit -m "$(cat <<'EOF'
feat(desktop-server): the setup chain collapses into one consented press

`probe.next` already computed the whole sequence and every step in it had a
correct default, so the console spent four clicks and four form fields
executing a plan it had already made.

`ProbeStep::Setup` replaces `InstallServer` and runs install, init, service
install and start in order, stopping at the first failure. The step's hint
discloses exactly what the press does, which is what makes collapsing four
steps into one honest rather than silent.

Every other step is untouched: each describes a machine already part-way
through that needs one specific act, not a fresh run.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: `desktop_install_tmux`

tmux is a hard stop on `init` and `service install`, and the console currently answers it with a copy-to-clipboard command, which sends a user who downloaded a GUI to a terminal. The app runs the platform's own installer instead. **No bundling**: see the spec section 6.1 for why.

**Files:**
- Modify: `apps/server/desktop/src-tauri/src/control.rs`
- Modify: `apps/server/desktop/src-tauri/src/lib.rs`
- Create: `apps/server/desktop/ui/installers.js`
- Modify: `apps/server/desktop/ui/main.js` (`buildTmuxWarning`)

**Interfaces:**
- Produces: `desktop_install_tmux() -> Result<ActionResult, String>`, and from `installers.js` a pure `tmuxInstallPlan(platform, hasBrew)` returning `{ kind: "run" | "manual", label, command, docsUrl }`. Task 12 imports nothing from this; it mirrors the shape.

- [ ] **Step 1: Write the failing JS test for the pure half**

Create `apps/server/desktop/test/installers.test.js` (the app's `bun run test` covers `src` and `test`; confirm against its `package.json`).

```js
import { describe, expect, it } from "bun:test";
import { tmuxInstallPlan } from "../ui/installers.js";

describe("tmuxInstallPlan", () => {
  it("uses Homebrew on macOS when it is there", () => {
    expect(tmuxInstallPlan("darwin", true)).toMatchObject({ kind: "run", command: ["brew", "install", "tmux"] });
  });

  it("does not offer a button it cannot honour on a Mac without Homebrew", () => {
    // The user who downloads a GUI app is exactly the user with no Homebrew,
    // so this branch is the common one, not the edge case. A disabled button
    // teaches people to ignore buttons; a real alternative does not.
    const plan = tmuxInstallPlan("darwin", false);
    expect(plan.kind).toBe("manual");
    expect(plan.command).toEqual(["sudo", "port", "install", "tmux"]);
    expect(plan.docsUrl).toBe("https://formulae.brew.sh/formula/tmux");
  });

  it("elevates through pkexec on Linux, so the desktop prompts for a password", () => {
    expect(tmuxInstallPlan("linux", false)).toMatchObject({ kind: "run" });
    expect(tmuxInstallPlan("linux", false).command[0]).toBe("pkexec");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test --cwd apps/server/desktop installers`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `installers.js`**

```js
/**
 * Which installer the console offers, as a pure function of the platform.
 *
 * Separate from `main.js` for the same reason `config-form.js` is: this is the
 * part with a contract rather than a rendering, and it is the part worth
 * testing without a webview.
 *
 * **tmux is never bundled.** A static build would mean a musl toolchain in the
 * CI builder image (which strands ~2 GB of layers on every runner that pulled
 * it), a bundled terminfo directory, a second sidecar in the macOS notarize
 * path, and a CVE cadence for a C dependency nothing here owns. The platform's
 * own package manager is the smaller, honest answer.
 */

/** The docs page to send someone to when we cannot run an installer for them. */
const TMUX_DOCS = "https://formulae.brew.sh/formula/tmux";

/**
 * How to install tmux here.
 * @param {string} platform - "darwin", "linux", or anything else
 * @param {boolean} hasBrew - whether `brew` resolves on the login PATH
 * @returns {{kind: "run"|"manual", label: string, command: string[], docsUrl: string}}
 *   `run` means the console may offer a button; `manual` means it must show
 *   the command and let the user run it.
 */
export function tmuxInstallPlan(platform, hasBrew) {
  if (platform === "darwin") {
    if (hasBrew) {
      return { kind: "run", label: "Install tmux", command: ["brew", "install", "tmux"], docsUrl: TMUX_DOCS };
    }
    // No package manager we can drive. Homebrew itself is too large a thing
    // to install on someone's behalf from a setup screen, so this names the
    // alternative rather than pretending the button could work.
    return {
      kind: "manual",
      label: "Install tmux with MacPorts",
      command: ["sudo", "port", "install", "tmux"],
      docsUrl: TMUX_DOCS,
    };
  }
  if (platform === "linux") {
    // pkexec so the user gets their desktop's own password prompt. A bare
    // sudo from a GUI has no terminal to read a password from and simply
    // hangs until the timeout.
    return {
      kind: "run",
      label: "Install tmux",
      command: ["pkexec", "apt-get", "install", "-y", "tmux"],
      docsUrl: TMUX_DOCS,
    };
  }
  return { kind: "manual", label: "Install tmux", command: ["tmux"], docsUrl: TMUX_DOCS };
}
```

**Note for the implementer:** the Linux branch hardcodes `apt-get` because the app's own `.deb` already restricts it to Debian-family distributions. If you extend it, resolve the manager in **Rust** (where `which` is available) and pass the result in, rather than guessing here.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test --cwd apps/server/desktop installers`
Expected: PASS.

- [ ] **Step 5: Add the Rust command**

In `control.rs`, beside `desktop_setup`:

```rust
/// Install tmux with the platform's own package manager.
///
/// Never bundled: see `ui/installers.js` for the accounting. This runs what a
/// user would have run in a terminal, with their own privileges, and reports
/// the manager's own output verbatim.
#[tauri::command(async)]
pub fn desktop_install_tmux() -> Result<ActionResult, String> {
    let argv = tmux_install_argv().ok_or("no package manager this app can drive")?;
    let r = run(&argv, INSTALL_TIMEOUT);
    Ok(ActionResult { ok: r.ok(), stdout: r.stdout, stderr: r.detail() })
}
```

with the helper and the constant beside it:

```rust
/// A package install is not a probe. `ACTION_TIMEOUT` is sized for a CLI
/// answering a question; fetching and unpacking a package over a slow link
/// routinely takes minutes, and timing that out mid-write is worse than
/// waiting.
const INSTALL_TIMEOUT: Duration = Duration::from_secs(600);

/// The argv that installs tmux here, or None when no manager we can drive is
/// present.
///
/// Mirrors `tmuxInstallPlan` in `ui/installers.js`, which owns the same
/// decision for the rendering side. Two copies because one runs in a webview
/// with no process access and one runs where `which` works; they are pinned
/// against each other by the console test and this module's test.
fn tmux_install_argv() -> Option<Vec<String>> {
    let argv = match std::env::consts::OS {
        // No package manager we can drive without installing one first, and
        // Homebrew is too large a thing to install on someone's behalf from a
        // setup screen. The console shows the MacPorts line instead.
        "macos" => {
            subshell_desktop_core::shell_env::which("brew")?;
            vec!["brew", "install", "tmux"]
        }
        // pkexec so the user gets their desktop's own password prompt. A bare
        // sudo spawned from a GUI has no terminal to read a password from and
        // hangs until the timeout.
        "linux" => vec!["pkexec", "apt-get", "install", "-y", "tmux"],
        _ => return None,
    };
    Some(argv.into_iter().map(String::from).collect())
}
```

Add `use std::time::Duration;` if the file does not already import it, and register `control::desktop_install_tmux` in `lib.rs`'s `generate_handler!`.

- [ ] **Step 5b: Test the Rust half**

In `control.rs`'s test module:

```rust
#[test]
fn tmux_install_never_runs_a_bare_sudo() {
    // A GUI-spawned sudo has no tty to read a password from: it hangs until
    // the timeout rather than failing, which reads to the user as a frozen
    // app. Elevation on Linux goes through pkexec or not at all.
    if let Some(argv) = tmux_install_argv() {
        assert_ne!(argv[0], "sudo");
    }
}
```

- [ ] **Step 6: Wire the warning to the button**

In `main.js`'s `buildTmuxWarning`, keep the existing copy button exactly as it is (including its `dataset.always = "1"`, which is deliberate: being unable to copy the fix while a re-probe is in flight is the worst possible timing). Add a primary button ahead of it, rendered only when the plan's `kind` is `"run"`:

```js
  const plan = tmuxInstallPlan(probe?.platform ?? "", probe?.hasBrew ?? false);
  if (plan.kind === "run") {
    const install = document.createElement("button");
    install.type = "button";
    install.className = "primary";
    install.textContent = plan.label;
    install.addEventListener("click", doInstallTmux);
    row.append(install);
  }
```

This needs two new fields on the Rust `Probe`: `platform: String` (from `std::env::consts::OS`) and `has_brew: bool` (from `which("brew").is_some()`), both serialized camelCase like every other field. Add them with docblocks in the same voice as `tmux`'s.

Keep the existing behaviour where the warning re-checks on every render rather than being rebuilt with the step: installing tmux does not change which step you are on, so a warning rebuilt only on a step change would survive its own fix.

- [ ] **Step 7: `bun run rust:check` and the JS suite**

```bash
bun run rust:check
bun test --cwd apps/server/desktop
```

- [ ] **Step 8: Commit**

```bash
git add apps/server/desktop
git commit -m "$(cat <<'EOF'
feat(desktop-server): install tmux instead of sending the user to a terminal

tmux is a hard stop on init and service install, so a GUI app's first screen
was a disabled button telling the user to open a CLI. macOS ships no tmux,
so that was most Mac users on first run.

Not bundled, deliberately: a static build means a musl toolchain in the
builder image, a bundled terminfo dir, a second sidecar in the notarize
path, and a CVE cadence nothing here owns. The platform's package manager is
the smaller honest answer.

The Mac-without-Homebrew case gets a real alternative rather than a disabled
button, since that user is the common case here rather than the edge one.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: `desktop_install_agent`

**Files:**
- Modify: `apps/server/desktop/src-tauri/src/control.rs`, `src/lib.rs`
- Modify: `apps/server/desktop/ui/installers.js`, `ui/main.js`
- Test: `apps/server/desktop/test/installers.test.js`

**Interfaces:**
- Produces: `desktop_install_agent(id: String) -> Result<ActionResult, String>`.

- [ ] **Step 1: Write the failing test**

```js
describe("agentInstallPlan", () => {
  it("offers Claude Code as the default agent", () => {
    expect(agentInstallPlan("claude-code")).toMatchObject({
      command: ["sh", "-c", "curl -fsSL https://claude.ai/install.sh | bash"],
    });
  });

  it("refuses an id it does not ship, rather than running a string it was handed", () => {
    // Only built-ins may be auto-run. A third-party plugin's install command
    // stays copy-to-clipboard: the console runs in the user's desktop session
    // rather than the plugin host, and a second execution path with different
    // trust properties is not worth it for a case nobody has asked for.
    expect(agentInstallPlan("acme-harness")).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test --cwd apps/server/desktop installers`
Expected: FAIL, `agentInstallPlan` is not exported.

- [ ] **Step 3: Implement it**

Append to `installers.js`:

```js
/**
 * The install commands for the agents this app may run on a user's behalf.
 *
 * BUILT-INS ONLY, and the ids and strings are duplicated here rather than read
 * from a manifest on purpose: this list is what the console is allowed to
 * EXECUTE, so it must be readable in one place and changeable only by editing
 * this file. A registry-driven version of this would let an installed plugin
 * choose what the desktop app runs.
 *
 * All five are user-space installers that need no elevation.
 */
const AGENT_INSTALLS = {
  "claude-code": "curl -fsSL https://claude.ai/install.sh | bash",
  codex: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
  hermes: "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash",
  opencode: "curl -fsSL https://opencode.ai/install | bash",
  pi: "curl -fsSL https://pi.dev/install.sh | sh",
};

/**
 * How to install one built-in agent CLI, or null when this app will not.
 * @param {string} id - plugin id
 * @returns {{kind: "run", label: string, command: string[]}|null}
 */
export function agentInstallPlan(id) {
  const script = Object.hasOwn(AGENT_INSTALLS, id) ? AGENT_INSTALLS[id] : undefined;
  if (!script) return null;
  return { kind: "run", label: `Install ${id}`, command: ["sh", "-c", script] };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test --cwd apps/server/desktop installers`
Expected: PASS.

- [ ] **Step 5: Add the Rust command**

```rust
/// The install script for each built-in agent CLI.
///
/// **The webview sends an ID, never a command.** A command that runs what it
/// is handed is a different security property from one that runs what it
/// ships, and this process is the one that can write to the user's PATH. The
/// list is duplicated from `ui/installers.js` for the same reason it exists
/// there: what this app may EXECUTE has to be changeable only by editing this
/// file, never by anything it reads at runtime.
///
/// All five are user-space installers that need no elevation.
const AGENT_INSTALLS: &[(&str, &str)] = &[
    ("claude-code", "curl -fsSL https://claude.ai/install.sh | bash"),
    ("codex", "curl -fsSL https://chatgpt.com/codex/install.sh | sh"),
    ("hermes", "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash"),
    ("opencode", "curl -fsSL https://opencode.ai/install | bash"),
    ("pi", "curl -fsSL https://pi.dev/install.sh | sh"),
];

/// Install one built-in agent CLI, by id.
#[tauri::command(async)]
pub fn desktop_install_agent(id: String) -> Result<ActionResult, String> {
    let script = AGENT_INSTALLS
        .iter()
        .find(|(known, _)| *known == id)
        .map(|(_, script)| *script)
        .ok_or_else(|| format!("this app does not install \"{id}\""))?;
    let argv = vec!["sh".to_string(), "-c".to_string(), script.to_string()];
    let r = run(&argv, INSTALL_TIMEOUT);
    Ok(ActionResult { ok: r.ok(), stdout: r.stdout, stderr: r.detail() })
}
```

Add a test beside the tmux one:

```rust
#[test]
fn an_unknown_agent_id_is_refused_rather_than_run() {
    assert!(desktop_install_agent("acme-harness".into()).is_err());
}
```

Register `control::desktop_install_agent` in `lib.rs`'s `generate_handler!`.

- [ ] **Step 6: Offer it on the setup screen and on `ready`**

In `main.js`, add the handler:

```js
/**
 * Install one agent CLI.
 *
 * Non-fatal by construction: it is offered during setup but never gates it,
 * because Terminal is launchable whether this succeeds or not. A setup run
 * that failed because an unrelated download 404'd would be the worst kind of
 * regression to ship here.
 */
const doInstallAgent = guarded(async (id) => {
  show(await invoke("desktop_install_agent", { id }));
});
```

(using the app's real guarded-action wrapper, as in Task 10).

Add to the `setup` step's `actions()`, after the primary button:

```js
      ["Also install Claude Code", () => doInstallAgent("claude-code"), false, true],
```

and to the `ready` step's `actions()`, so it stays reachable after setup:

```js
      ["Install Claude Code", () => doInstallAgent("claude-code"), false, true],
```

Both carry the tmux flag (the fourth argument) because a machine with no tmux has nothing to run an agent in yet, so offering the install there would be premature rather than helpful.

- [ ] **Step 7: Verify**

```bash
bun run rust:check
bun test --cwd apps/server/desktop
bun run verify-types && bun run lint:check && bun run test
```

- [ ] **Step 8: Commit**

```bash
git add apps/server/desktop
git commit -m "$(cat <<'EOF'
feat(desktop-server): install an agent CLI from the app

All five built-in install commands are user-space curl installers needing no
elevation, so the app can run what the user would have run in a terminal.

Built-ins only, with the ids and strings listed in the app rather than read
from a manifest: this list is what the console may EXECUTE, and a
registry-driven version would let an installed plugin choose that. The
command takes an id and maps it in Rust; it never runs a string the webview
handed it.

A failed agent install does not fail setup. Terminal is launchable anyway.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Phase 3 gate

- [ ] **Run:** `bun run verify-types && bun run lint:check && bun run test && bun run rust:check`
- [ ] **Verify by hand** with `bun run dev:app` on a machine with the server moved aside: one screen, one button, ending on the dashboard.
- [ ] **Add a changeset** for `@internal/desktop-server` (minor) describing the one-click setup and the installers.
- [ ] **Code review this phase.**
- [ ] **Update the README.** Its "Install `tmux` first" paragraph and the desktop-app section both describe the old flow. Also update `apps/server/desktop/AGENTS.md`'s step table.
- [ ] **PR description** must flag the npm bootstrap step from Global Constraints.
