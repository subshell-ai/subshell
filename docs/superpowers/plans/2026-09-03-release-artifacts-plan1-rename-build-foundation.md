# Release Artifacts — Plan 1: Client Rename + Build Foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the client app end-to-end (`apps/agent` → `apps/client`, all user-visible `agent` strings → `client`/none), relocate both config homes, and harden the release build (bytecode on every triple, CI triple-scoping, shared helpers in the protocol package).

**Architecture:** Pure rename + build-script refactor. The client package moves wholesale; env/home/launchd strings swap; `digestFile`/`publishArtifacts` migrate into `@internal/subshell-protocol` where both future apps' release scripts can import them; `apps/client/src/scripts/release.ts` loses its host-wins-bytecode special case per the spike disproving spec risk #9 on bun 1.4.0.

**Tech Stack:** Bun 1.4.0 workspaces, `bun test`, Biome, turborepo, GitHub Actions (Plan 3), commitlint/lefthook.

**Spec:** `docs/superpowers/specs/2026-09-03-release-artifacts-design.md` §2, §5 (this plan), §10.

## Global Constraints

- Every user-visible string loses the word "agent": env vars, config paths, launchd label, package name, npm script names. **Internal TS identifiers (`AgentConfig`, `agentEnv`, `startAgent`, `AGENT_MAIN`, `RunningAgent`) stay** — vocabulary rule targets surfaces, not internals (documented decision).
- New config homes: client `~/.config/subshell`, server data dir `~/.config/subshell-server` (server side is DEPLOY-CONFIG only — `svc.sh`/`docker-compose.yaml`; `paths.ts` `DEFAULT_DATABASE_PATH` stays `./data/subshell.db`).
- Env renames: `SUBSHELL_AGENT_HOME` → `SUBSHELL_CONFIG_HOME`, `SUBSHELL_AGENT_SKIP_TMUX_CHECK` → `SUBSHELL_CLIENT_SKIP_TMUX_CHECK`.
- No dynamic imports (project rule). Pinned dep versions only. Scripts run with `bun`/`bunx`, never npm.
- Verification after every code task: `bun run verify-types && bun run lint:check && bun run test` from repo root (the e2e Playwright suite is NOT in `bun run test`; do not run it here — it needs a live tmux + `bunx playwright install`).
- **Any task touching `packages/` additionally runs `bunx turbo build`** (`.claude/rules/build.md`) — and for `subshell-protocol` specifically, must keep its barrel `node:*`-free (apps/mobile Metro imports it; `bunx expo export --platform android` in `apps/mobile` is the regression gate — added after Task 4 review).
- Release scripts must refuse to run on bun < 1.4.0 (bytecode-cross spike floor).
- Commits: Conventional Commits (commitlint hook). Work on branch `feat/release-artifacts`.

---

### Task 1: Move `apps/agent` → `apps/client` and rename the package

**Files:**
- Move: `apps/agent/` → `apps/client/` (git mv, whole tree)
- Modify: `apps/client/package.json:2` (`"name"`)
- Modify: `package.json:32` (`release:agent` script)
- Move: `e2e/stub/agent.ts` → `e2e/stub/client.ts`
- Modify: `e2e/tests/12-nodes.spec.ts` (import path `./stub/agent` → `./stub/client`)

**Interfaces:**
- Produces: workspace package `@internal/client` at `apps/client/`, root script `release:client`, e2e export path `e2e/stub/client.ts` (exports `AGENT_MAIN`, `STUB_PI`, `startAgent`, types unchanged).

- [ ] **Step 1: Move the trees**

```bash
git mv apps/agent apps/client
git mv e2e/stub/agent.ts e2e/stub/client.ts
```

- [ ] **Step 2: Rename the package + description**

In `apps/client/package.json` replace line 2 and the description:

```json
  "name": "@internal/client",
  "description": "subshell — node client daemon: enrolls with the control plane and executes signed commands",
```

- [ ] **Step 3: Root script**

In `package.json` replace line 32:

```json
    "release:client": "bun run --cwd apps/client compile:release"
```

- [ ] **Step 4: Fix the e2e import**

In `e2e/tests/12-nodes.spec.ts` change `from "../stub/agent"` (or `"./stub/agent"` — locate with `grep -n "stub/agent" e2e/tests/12-nodes.spec.ts`) to the `client` spelling. No symbol renames.

- [ ] **Step 5: Rewire workspaces**

```bash
bun install
```

Expected: lockfile updated with `"apps/client"` workspace; `node_modules/@internal/client` symlink exists; old `@internal/agent` link gone (`ls node_modules/@internal/`).

- [ ] **Step 6: Verify**

```bash
bun run --cwd apps/client test
bun run --cwd apps/client verify-types
bun run lint:check
```

Expected: all pass. `grep -rn "apps/agent" apps e2e packages --include="*.ts" | grep -v dist` — remaining hits must be COMMENT-only (backend `uploads.service.ts:319`, `remote-launcher.ts:337`); they are fixed in Task 8, not here.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(client)!: rename apps/agent → apps/client, @internal/agent → @internal/client"
```

---

### Task 2: Config home `~/.config/subshell` + env renames

**Files:**
- Modify: `apps/client/src/config.ts:36-38` (default home + env name + `agentHome`→`clientHome`)
- Modify: `apps/client/src/index.ts:9` (export line)
- Modify: `apps/client/src/lock.ts:3,37,48` + comment on :6
- Modify: `apps/client/src/enroll.ts:4,61,107,113`
- Modify: `apps/client/src/test-preload.ts`
- Modify: `apps/client/src/__tests__/config.test.ts`, `enroll.test.ts`, `commands-basics.test.ts`

**Interfaces:**
- Produces: `clientHome(): string` (was `agentHome`) reading `SUBSHELL_CONFIG_HOME` with default `~/.config/subshell`; escape hatch `SUBSHELL_CLIENT_SKIP_TMUX_CHECK=1`; `test-preload` exports unchanged (`newHome()` still returns the fresh dir).
- Consumes: Task 1's `apps/client/` paths.

- [ ] **Step 1: Update the tests first (they define the contract)**

In the three test files, replace every `SUBSHELL_AGENT_HOME` with `SUBSHELL_CONFIG_HOME` and `SUBSHELL_AGENT_SKIP_TMUX_CHECK` with `SUBSHELL_CLIENT_SKIP_TMUX_CHECK` (`grep -rn "SUBSHELL_AGENT" apps/client/src/__tests__` to find them all). In `config.test.ts` ADD:

```typescript
import { clientHome } from "../config.js";

describe("clientHome", () => {
  test("defaults to ~/.config/subshell with no env override", () => {
    delete process.env.SUBSHELL_CONFIG_HOME;
    // homedir() is host truth; assert the tail, not the whole path.
    expect(clientHome().endsWith(join(".config", "subshell"))).toBe(true);
    process.env.SUBSHELL_CONFIG_HOME = newHome();
  });

  test("SUBSHELL_CONFIG_HOME overrides the default", () => {
    const dir = newHome();
    process.env.SUBSHELL_CONFIG_HOME = dir;
    expect(clientHome()).toBe(dir);
  });
});
```

(Import `join` from `node:path` and `newHome` from the preload — copy the import style already at the top of `config.test.ts`.) In `enroll.test.ts`, the tmux-refusal test asserts the error mentions the escape hatch — update its expected string to `SUBSHELL_CLIENT_SKIP_TMUX_CHECK=1`.

- [ ] **Step 2: Run to verify they fail**

```bash
bun test apps/client/src/__tests__/config.test.ts
```

Expected: FAIL — `clientHome` is not exported / default path still `subshell-agent`.

- [ ] **Step 3: Implement in `config.ts`**

```typescript
/** Root the config + default data dir live under (`SUBSHELL_CONFIG_HOME` for tests). */
export function clientHome(): string {
  return process.env.SUBSHELL_CONFIG_HOME ?? join(homedir(), ".config", "subshell");
}
```

Update its two call sites in the same file (`configPath`). Keep the `AgentConfig` interface name (internal identifier — Global Constraints).

- [ ] **Step 4: Update call sites**

`index.ts:9`:

```typescript
export { type AgentConfig, clientHome, configPath, loadConfig, saveConfig } from "./config.js";
```

`lock.ts`: import + two usages → `clientHome()`; comment on :6 → `<clientHome>/daemon.lock`. `enroll.ts`: import + :61 → `join(clientHome(), "data")`; :107 env read and :113 hint string → `SUBSHELL_CLIENT_SKIP_TMUX_CHECK`. `test-preload.ts`: both env assignments → new names; comment about `~/.config/subshell-agent` → `~/.config/subshell`.

- [ ] **Step 5: Verify**

```bash
grep -rn "SUBSHELL_AGENT" apps/client/src | grep -v dist   # expected: NO output
bun run --cwd apps/client test
bun run verify-types
```

Expected: clean grep, tests pass, types pass.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(client)!: config home ~/.config/subshell (was ~/.config/subshell-agent); SUBSHELL_CONFIG_HOME + SUBSHELL_CLIENT_SKIP_TMUX_CHECK env renames"
```

---

### Task 3: launchd label `dev.subshell.client`

**Files:**
- Modify: `apps/client/src/service.ts:48` (`LAUNCHD_LABEL`) + comment `:109`
- Modify: `apps/client/src/__tests__/service.test.ts` (every pinned `dev.subshell.agent` string + plist path)

**Interfaces:**
- Produces: `LAUNCHD_LABEL = "dev.subshell.client"` (plist at `~/Library/LaunchAgents/dev.subshell.client.plist`; log path `~/Library/Logs/subshell.log` UNCHANGED — binary-name based).
- Consumes: none beyond Task 1.

- [ ] **Step 1: Re-pin the tests**

```bash
grep -c "dev.subshell.agent" apps/client/src/__tests__/service.test.ts
```

Replace ALL occurrences in the test with `dev.subshell.client` (they pin the exact plist text and `launchctl bootout gui/<uid>/<label>` argv sequences).

- [ ] **Step 2: Run to verify failure**

```bash
bun test apps/client/src/__tests__/service.test.ts
```

Expected: FAIL — plist text/bootout argv still emit `dev.subshell.agent`.

- [ ] **Step 3: Implement**

`service.ts:48`:

```typescript
export const LAUNCHD_LABEL = "dev.subshell.client";
```

Comment `:109` stays accurate (it names the log file, which does not change).

- [ ] **Step 4: Verify + commit**

```bash
bun test apps/client/src/__tests__/service.test.ts && bun run lint:check
git add -A
git commit -m "feat(client)!: launchd label dev.subshell.client (was dev.subshell.agent)"
```

NOTE for rollout (Task 8 writes it): `service install` with the new label does NOT bootout the old `dev.subshell.agent` job — clean cut, the rollout doc carries `launchctl remove dev.subshell.agent`.

---

### Task 4: Migrate `digestFile` + `publishArtifacts` into `@internal/subshell-protocol`

**Files:**
- Create: `packages/subshell-protocol/src/release-artifacts.ts`
- Modify: `packages/subshell-protocol/src/index.ts` (export block beside `./paths.js`)
- Modify: `apps/client/src/scripts/release.ts` (delete the two functions, import from protocol)
- Move tests: `apps/client/src/scripts/__tests__/release.test.ts` → new `packages/subshell-protocol/src/__tests__/release-artifacts.test.ts` (the digest/publish cases only)

**Interfaces:**
- Produces (protocol package): `digestFile(path: string): Promise<string>`, `publishArtifacts(artifacts: Map<string, BuiltArtifact>, destDir: string): Promise<void>`, `interface BuiltArtifact { path: string; digest: string }` — signatures VERBATIM from today's `release.ts` (lines 29-33, 116-121, 163-172).
- Consumes: nothing new.

- [ ] **Step 1: Write the failing protocol tests**

Create `packages/subshell-protocol/src/__tests__/release-artifacts.test.ts`: MOVE the existing digest + publish test cases out of `apps/client/src/scripts/__tests__/release.test.ts` (locate with `grep -n "digestFile\|publishArtifacts" apps/client/src/scripts/__tests__/release.test.ts` and move those whole `test(...)` blocks), changing only the import line to:

```typescript
import { digestFile, publishArtifacts, type BuiltArtifact } from "../release-artifacts.js";
```

- [ ] **Step 2: Run to verify failure**

```bash
bun test packages/subshell-protocol/src/__tests__/release-artifacts.test.ts
```

Expected: FAIL — cannot resolve `../release-artifacts.js`.

- [ ] **Step 3: Create the module**

`packages/subshell-protocol/src/release-artifacts.ts` — copy `digestFile` (with its JSDoc), `BuiltArtifact`, and `publishArtifacts` (with its per-file-atomicity JSDoc) VERBATIM from `apps/client/src/scripts/release.ts` (:29-33, :116-121, :163-172), carrying their node imports (`node:crypto`, `node:fs` `createReadStream`/`createHash`, `node:fs/promises` `copyFile`/`mkdir`/`rename`, `node:path` `join`, `node:stream/promises` `pipeline`), and add a header:

```typescript
/**
 * Shared release-artifact primitives (spec 2026-09-03 §5): the streaming
 * digest + the atomic tmp+rename publish that BOTH apps' `compile:release`
 * pipelines use. Lives here beside NODE_TARGETS for the same reason — the
 * apps never import each other.
 */
```

- [ ] **Step 4: Export via SUBPATH, not the barrel** (amended post-review: the barrel is
  Metro-imported by `apps/mobile` and must stay free of `node:*` — `expo export` is the gate)

Add a second tsdown entry for `src/release-artifacts.ts` in the protocol package's build
config and a `./release-artifacts` entry in `packages/subshell-protocol/package.json`
`exports` (types + import, mirroring the root entry's style). `src/index.ts` does NOT
export these symbols.

- [ ] **Step 5: Rewire the client script**

In `apps/client/src/scripts/release.ts`: DELETE the local `digestFile`, `BuiltArtifact`, and `publishArtifacts` definitions and their now-unused node imports; change the protocol import line to:

```typescript
import { NODE_TARGETS, nodeArtifactFileName, resolveNodeArtifactsDir } from "@internal/subshell-protocol";
import { type BuiltArtifact, digestFile, publishArtifacts } from "@internal/subshell-protocol/release-artifacts";
```

(The test file `apps/client/src/scripts/__tests__/release.test.ts` imports `digestFile` from the same subpath — amend its Task-4-added import line identically.)

Re-export nothing. In `apps/client/src/scripts/__tests__/release.test.ts` keep the remaining tests and add (so the MOVED helpers stay covered through the production import):

```typescript
import { digestFile, publishArtifacts } from "@internal/subshell-protocol";
```

only if any surviving test still calls them — otherwise no import.

- [ ] **Step 6: Rebuild protocol + verify**

```bash
bun run --cwd packages/subshell-protocol build
bun test packages/subshell-protocol
bun test apps/client/src/scripts/__tests__/release.test.ts
bun run verify-types && bun run lint:check
```

Expected: all pass. (The build matters: the client's vitest resolves the workspace `dist`.)

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(protocol): digestFile + publishArtifacts become the shared release primitives (spec 2026-09-03 §5)"
```

---

### Task 5: Bytecode everywhere + `SUBSHELL_RELEASE_TRIPLES` + bun floor guard

**Files:**
- Modify: `apps/client/src/scripts/release.ts` (header comment, `BuildTarget`, `hostTriple`→gone, `buildTargets`, `buildArgs`, `buildAll`, new `parseScope` + `assertBunFloor`, `main`)
- Modify: `apps/client/src/scripts/__tests__/release.test.ts`

**Interfaces:**
- Produces: `buildArgs(triple: string, outDir: string): string[]` (NO `isHost` param — always `--bytecode`, always `--target=bun-<triple>`); `buildTargets(scope?: readonly string[]): BuildTarget[]` with `interface BuildTarget { triple: string }`; `parseScope(raw: string | undefined): string[] | null` (throws on unknown triple); `assertBunFloor(minimum: string, version: string): void` (throws below floor). Deletes `hostTriple` and `isHost`.
- Consumes: Task 4's protocol imports.

- [ ] **Step 1: Rewrite the affected tests (they are the spec for this task)**

In `release.test.ts`: DELETE every test that references `isHost`, `hostTriple`, or asserts a no-`--target`/no-`--bytecode` argv. ADD:

```typescript
import { buildArgs, buildTargets, parseScope, assertBunFloor } from "../release.js";
import { NODE_TARGETS } from "@internal/subshell-protocol";

describe("buildArgs (always-bytecode, spec 2026-09-03 §5)", () => {
  test("every triple compiles with --bytecode AND an explicit --target", () => {
    for (const triple of NODE_TARGETS) {
      const args = buildArgs(triple, "/out");
      expect(args).toContain("--bytecode");
      expect(args).toContain(`--target=bun-${triple}`);
      expect(args).toContain(join("/out", `subshell-${triple}`));
    }
  });
});

describe("buildTargets", () => {
  test("flat schedule: one entry per served triple, no host special case", () => {
    expect(buildTargets().map((t) => t.triple)).toEqual([...NODE_TARGETS]);
  });
  test("scope narrows the schedule without reordering", () => {
    expect(buildTargets(["darwin-arm64", "linux-x64"]).map((t) => t.triple)).toEqual([
      "darwin-arm64",
      "linux-x64",
    ]);
  });
});

describe("parseScope", () => {
  test("undefined → null (full set)", () => expect(parseScope(undefined)).toBeNull());
  test("whitespace-separated subset passes through", () =>
    expect(parseScope(" linux-arm64\tdarwin-x64 ")).toEqual(["linux-arm64", "darwin-x64"]));
  test("unknown triple throws", () => expect(() => parseScope("win32-x64")).toThrow(/unknown target/i));
});

describe("assertBunFloor (risk #9 disproved at 1.4.0)", () => {
  test("accepts the floor and newer", () => {
    expect(() => assertBunFloor("1.4.0", "1.4.0")).not.toThrow();
    expect(() => assertBunFloor("1.4.0", "1.12.3")).not.toThrow();
  });
  test("refuses below the floor", () => {
    expect(() => assertBunFloor("1.4.0", "1.3.10")).toThrow(/bun 1\.4\.0/);
    expect(() => assertBunFloor("1.4.0", "1.4.0-canary1")).not.toThrow();
  });
});
```

(Keep/adapt the existing `buildAll` all-or-nothing tests: they must call the new `buildAll(deps, scope?)` signature; where they asserted `isHost`-based argv, assert the uniform argv.)

- [ ] **Step 2: Run to verify failure**

```bash
bun test apps/client/src/scripts/__tests__/release.test.ts
```

Expected: FAIL — `buildArgs` arity, missing `parseScope`/`assertBunFloor`.

- [ ] **Step 3: Implement**

In `apps/client/src/scripts/release.ts`:

```typescript
/** One entry of the build schedule. */
export interface BuildTarget {
  /** Platform triple this artifact is published under. */
  triple: string;
}

/**
 * The build schedule: one artifact per served triple (or per `scope` entry —
 * CI shards set `SUBSHELL_RELEASE_TRIPLES`, spec §7). Bytecode ships on EVERY
 * target: cross+bytecode was disproved a risk on bun 1.4.0 (spec 2026-09-03
 * spike), and the floor is asserted in main().
 * @param scope - triples to build; null/undefined = the full NODE_TARGETS set
 */
export function buildTargets(scope: readonly string[] | null = null): BuildTarget[] {
  const set = scope ?? [...NODE_TARGETS];
  return set.map((triple) => ({ triple }));
}

/**
 * `bun build` argv for one target (spawned with cwd `apps/client`).
 * Uniform: `--compile --bytecode --minify --target=bun-<triple>` — the
 * host-wins-its-triple special case is retired (spec 2026-09-03 §5).
 */
export function buildArgs(triple: string, outDir: string): string[] {
  return [
    "build",
    "--compile",
    "--bytecode",
    "--minify",
    "./src/main.ts",
    `--target=bun-${triple}`,
    "--outfile",
    join(outDir, nodeArtifactFileName(triple)),
  ];
}

/**
 * Parse the `SUBSHELL_RELEASE_TRIPLES` scope override: whitespace-separated
 * triples, each unknown → hard refusal (a typo'd scope silently publishing a
 * partial set is exactly the half-release this pipeline exists to prevent).
 * @returns null when unset/blank (the full set)
 */
export function parseScope(raw: string | undefined): string[] | null {
  const parts = (raw ?? "").split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  for (const p of parts) {
    if (!(NODE_TARGETS as readonly string[]).includes(p)) {
      throw new Error(`unknown target "${p}" in SUBSHELL_RELEASE_TRIPLES (known: ${NODE_TARGETS.join(" ")})`);
    }
  }
  return parts;
}

/** Compare `a` vs `b` numerically over the dotted-numeric prefix (suffixes ignored). */
export function semverLt(a: string, b: string): boolean {
  const nums = (v: string) => (v.match(/^\d+(\.\d+)*/)?.[0] ?? "0").split(".").map(Number);
  const [av, bv] = [nums(a), nums(b)];
  for (let i = 0; i < Math.max(av.length, bv.length); i++) {
    const d = (av[i] ?? 0) - (bv[i] ?? 0);
    if (d !== 0) return d < 0;
  }
  return false;
}

/** Refuses (throws) a bun older than the version the bytecode-cross spike proved. */
export function assertBunFloor(minimum: string, version: string = process.versions.bun): void {
  if (semverLt(version, minimum)) {
    throw new Error(`release builds need bun ${minimum} or newer (bytecode cross-compiles); found ${version}`);
  }
}
```

Update `buildAll` to `buildAll(deps: ReleaseDeps, scope?: string[] | null)` iterating `buildTargets(scope ?? parseScope(undefined))` → simply `buildTargets(scope ?? null)`; drop `target.isHost` from the `buildArgs` call. Delete `hostTriple`. In `main()`, first lines:

```typescript
  assertBunFloor("1.4.0");
  const scope = parseScope(process.env.SUBSHELL_RELEASE_TRIPLES);
```

(remove the old "host is not a served triple" note — flat schedule makes it meaningless), pass `scope` into `buildAll`, and update the script's HEADER comment: replace "plus a bytecode-optimised host build … ship WITHOUT `--bytecode` (spec risk #9)" with "every target builds with `--bytecode` (risk #9 retired — spike on bun 1.4.0, spec 2026-09-03 §1)". Replace remaining `apps/agent` mentions in comments with `apps/client` (constant `AGENT_DIR` name may stay — internal identifier).

- [ ] **Step 4: Verify**

```bash
bun test apps/client/src/scripts/__tests__/release.test.ts
bun run verify-types && bun run lint:check
```

Expected: all pass.

- [ ] **Step 5: Real-build smoke (proves argv shape is executable, not just asserted)**

```bash
bunx turbo build   # release preflight requires packages/*/dist (also wipes apps/client/dist/subshell — dev binary, rebuild with `bun run --cwd apps/client compile` if used)
SUBSHELL_RELEASE_TRIPLES=darwin-x64 SUBSHELL_NODE_ARTIFACTS_DIR=/tmp/p1-smoke bun run release:client
ls -la /tmp/p1-smoke/ && head -c16 /tmp/p1-smoke/subshell-darwin-x64 | od -c | head -1
```

Expected: exit 0; `/tmp/p1-smoke/` holds EXACTLY `subshell-darwin-x64` + `subshell-darwin-x64.sha256` (scope respected — the other triples must NOT appear); binary starts with the ELF/Mach-O magic, not text. `rm -rf /tmp/p1-smoke`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(client)!: release pipeline — bytecode on every triple, SUBSHELL_RELEASE_TRIPLES scoping, bun 1.4.0 floor (risk #9 retired)"
```

---

### Task 6: Server data dir → `~/.config/subshell-server` (deploy files)

**Files:**
- Modify: `svc.sh:13` (comment), `svc.sh:77` (`DATABASE_PATH=`)
- Modify: `docker-compose.yaml:19` (volume host default)

**Interfaces:**
- Produces: nothing code-side for Plan 2 — but Plan 2's `configure` defaults must use `~/.config/subshell-server/subshell.db`, matching these.
- Consumes: none.

- [ ] **Step 1: Edit svc.sh**

```bash
# ... keeps using the Docker deployment's data dir (~/.config/subshell-server) so
```
(line 13 area — update the sentence's path only) and line 77:

```bash
Environment=DATABASE_PATH=$HOME/.config/subshell-server/subshell.db
```

- [ ] **Step 2: Edit docker-compose.yaml**

```yaml
      - ${SUBSHELL_DATA_HOST_DIR:-$HOME/.config/subshell-server}:/data
```

- [ ] **Step 3: Verify syntax + grep**

```bash
bash -n svc.sh
grep -rn "\.config/subshell\b" svc.sh docker-compose.yaml Dockerfile   # expected: NO output
```

(If `docker-compose.override.yaml` exists locally with the OLD path, it is untracked-by-design — do NOT edit it; mention it in the task report so the operator updates it during rollout.)

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(deploy)!: server data dir ~/.config/subshell-server (vacates ~/.config/subshell for the client home)"
```

---

### Task 7: Docs truth-up + rollout addendum

**Files:**
- Modify: `AGENTS.md` (root), `apps/client/AGENTS.md`, `apps/backend/AGENTS.md`, `e2e/AGENTS.md`, `docs/architecture.md`
- Modify: backend comment refs `apps/backend/src/services/uploads.service.ts:319`, `apps/backend/src/services/nodes/remote-launcher.ts:337`
- Modify: `docs/subshell-rollout.md` (append dated addendum)

- [ ] **Step 1: Mechanical string sweep (docs)**

Apply across the five docs files (locate each with grep, edit in place): `apps/agent` → `apps/client`; `@internal/agent` → `@internal/client`; `release:agent` → `release:client`; `SUBSHELL_AGENT_HOME` → `SUBSHELL_CONFIG_HOME`; `SUBSHELL_AGENT_SKIP_TMUX_CHECK` → `SUBSHELL_CLIENT_SKIP_TMUX_CHECK`; `dev.subshell.agent` → `dev.subshell.client`; `~/.config/subshell-agent` → `~/.config/subshell`. The two backend comment refs get the `apps/client/src/...` path.

- [ ] **Step 2: Prose fixes where a string swap is not enough**

- `apps/client/AGENTS.md` Commands section: the sentence "cross builds … ship WITHOUT `--bytecode` (spec risk #9)" → "every target ships `--bytecode` (risk #9 retired at bun 1.4.0 — spec 2026-09-03 §5); the pipeline refuses older bun". Its "Publish is atomic" sentence otherwise stands. Title/path prose (`apps/agent`) and the CLI section's unit paths stand after the sweep.
- Root `AGENTS.md` "Publishing subshell binaries" section: `release:agent` → `release:client` in all four bullets, the four-triples sentence stays (still served), and the bullet "the host build wins its own triple…" is REPLACED by: "the four served triples (`linux|darwin × x64|arm64`), each cross-built WITH `--bytecode` (uniform since spec 2026-09-03 §5) — `SUBSHELL_RELEASE_TRIPLES` scopes a subset (CI uses this); each digested and published as `subshell-<triple>` + fresh `.sha256`".
- `e2e/AGENTS.md` + `e2e/stub/client.ts` header comment: "The agent CLI as SOURCE (`bun <root>/apps/agent/src/main.ts …`)" → `apps/client` spelling (path inside the comment — the constant name `AGENT_MAIN` stays per Global Constraints).

- [ ] **Step 3: Append the rollout addendum to `docs/subshell-rollout.md`**

Append verbatim:

```markdown
---

## Addendum 2026-09-03: client rename + config-home swap (spec 2026-09-03)

Clean cut, same rules as the main doc. ORDER IS LOAD-BEARING: the server
vacates ~/.config/subshell BEFORE the client moves in.

1. Server (control-plane host):

   ```bash
   systemctl --user stop subshell-server.service
   mv ~/.config/subshell ~/.config/subshell-server
   # .env / EnvironmentFile: update the DATABASE_PATH line to
   #   ~/.config/subshell-server/subshell.db
   # (svc.sh's regenerated unit now bakes the new path)
   systemctl --user daemon-reload && systemctl --user start subshell-server.service
   ```

   Docker users: same `mv`, plus check the UNTRACKED
   docker-compose.override.yaml for the old path (it still keys it).

2. Client on every enrolled host (including a host-agent here):

   ```bash
   subshell service uninstall 2>/dev/null || true      # old unit/plist, old name
   launchctl remove dev.subshell.agent 2>/dev/null || true   # macOS: stale KeepAlive guard
   mv ~/.config/subshell-agent ~/.config/subshell
   # config.json itself stores no env names (enrollment state only) — sweep
   # any HAND-KEPT env files that reference the old vars:
   grep -rl "SUBSHELL_AGENT_" ~/.config/subshell ~/.config/subshell-server 2>/dev/null \
     | xargs -r sed -i 's/SUBSHELL_AGENT_HOME/SUBSHELL_CONFIG_HOME/g; s/SUBSHELL_AGENT_SKIP_TMUX_CHECK/SUBSHELL_CLIENT_SKIP_TMUX_CHECK/g'
   ./subshell service install    # new binary from the release / apps/client build;
                                 # regenerates the unit/plist with the new names baked
   ```

3. Smoke: `subshell status --probe` on each node; Nodes page shows online;
   one test launch lands. Old `dev.subshell.agent`/`subshell.service` unit
   files: the new `service install` rewrites `subshell.service` (same name);
   launchd's old plist must be gone or it respawns the stale binary.
```

(If a detail above contradicts the actual `subshell service uninstall` behavior on a machine without a config — it deliberately succeeds — that's fine; the doc already notes uninstall tolerates a deleted config.)

- [ ] **Step 4: Verify + commit**

```bash
grep -rn "apps/agent\|@internal/agent\|release:agent\|SUBSHELL_AGENT_\|dev\.subshell\.agent\|subshell-agent" \
  AGENTS.md apps e2e docs/architecture.md docs/subshell-rollout.md packages --include="*.md" --include="*.ts" \
  | grep -v "node_modules\|dist\|Addendum\|launchctl remove\|dev.mote" 
```

Expected: NO output (the addendum's historical mentions are the only survivors and are filtered by path-exception — if a hit is genuinely stale, fix it; the two backend comments were handled in Step 1).

```bash
bun run verify-types && bun run lint:check && bun run test
git add -A
git commit -m "docs!: client rename truth-up + 2026-09-03 rollout addendum (ordered home swap, launchd cleanup)"
```

---

## Self-review notes (author, post-draft)

- Spec coverage: §2 (Tasks 1-3, 6), §5 (Tasks 4-5), §10 docs/rollout (Task 7); §3/§4 server CLI + embedding = Plan 2; §6/§7 changesets + CI = Plan 3. The rollout's binary-swap step ("replacing the binary") is Plan 3's first release; until then rollout uses a locally built `apps/client` binary (`bun run --cwd apps/client compile`).
- `agentHome`→`clientHome` is listed in Task 2's interface block and every call site enumerated from grep (`index.ts:9`, `lock.ts:3,37,48`, `enroll.ts:4,61`, `config.ts` internal) — an implementer who adds a new caller only needs the grep in Step 4.
- Test bodies quoted for Task 5 use helpers (`newHome`, `join`) already imported in those suites; if `release.test.ts` lacks a `join` import, add `import { join } from "node:path";`.
