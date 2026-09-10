# Plugins on the Control Plane: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move harness plugins off agent nodes onto the control plane. Nodes stop holding plugin packages, manifests and plugin state, and become executors: resolve a binary, write a file, spawn, report.

**Architecture:** A strangler, not a big bang. The launch frame first gains OPTIONAL fields the server populates while the node keeps doing what it does today; a parity test proves the two agree; the node then switches to the sent values; only then is its plugin machinery deleted and the protocol tightened. Every task ends with a green suite, and the correctness claim of the whole change is pinned by a test before anything is removed.

**Tech Stack:** Bun 1.4.x, TypeScript strict, ElysiaJS + TypeBox, Kysely/SQLite, React 19 + TanStack Query, `bun test`, Playwright, biome.

**Spec:** `docs/superpowers/specs/2026-09-10-plugins-on-the-control-plane-design.md`. Read it before Task 1. It supersedes §6, §8.1 to §8.2, §10 and §11 of `2026-09-09-plugin-architecture-design.md`, which keeps everything else.

## Before you start

**Line numbers in this plan are HINTS, not anchors.** They were captured on
2026-09-10 against the commit that introduced this file. Tasks 1 through 6
modify several of the files that later tasks cite, so by Task 7 the numbers
will have moved. **Task 7 is the dangerous one**: it lists about twenty ranges
across files that earlier tasks edit. Locate every one of them by SYMBOL NAME
(`execPluginInstall`, `scanInstalledPlugins`, `COMMAND_FLAGS.plugin`) and treat
the line number as a sanity check on whether you found the right thing. If a
symbol is not where the plan says, trust the symbol.

**Task 3 is a stop-gate, not a step.** If any built-in's argv does not survive
placeholder substitution, stop and report which plugin and which input. Do not
work around it. The likely cause is a plugin composing the binary into a longer
string, and that needs a design answer, not a patch. Nothing has been deleted
by that point, so stopping costs only the work done so far.

**Prerequisite: the version PR must not have merged.** As of 2026-09-10 there
is an open changesets PR ("chore: release package(s)") carrying four unreleased
changesets, two of which describe the architecture this plan reverses. Task 13
rewrites those two files so the release describes the end state rather than
narrating a round trip. That only works while they are unconsumed. **If the PR
has already merged**, Task 13 changes: the CHANGELOGs are written and the
changesets are gone, so instead add a NEW changeset that corrects the record,
and say plainly in it that the previous entry described a design that was
replaced before it shipped.

**Two documents in this repo describe a plan that is no longer current**:
`2026-09-10-plugins-phase4-ux-design.md` and
`2026-09-10-plugins-phase5-settings-design.md`, with their plans. Each carries a
superseded header naming this work. Do not execute them. Their findings are
still cited here where they survived.

## Why the order looks like this

The obvious order is "change the protocol, then fix everyone". That leaves the tree uncompilable across several tasks, makes every intermediate review a guess, and defers the one question that matters (does a server-built argv equal a node-built one?) until after the node's ability to answer it has been deleted.

So: additive first (Tasks 1 to 2), prove equivalence while both sides can still compute it (Task 3), switch the consumer (Task 4), and only then demolish (Tasks 7 onward). If Task 3 fails, the change stops with nothing lost.

## Global Constraints

- **No new runtime dependencies.**
- **`await import()`** stays confined to `packages/pane-runtime/src/plugin-runtime.ts`. The agent stops calling it; the server keeps doing so, and `.claude/rules/code-style.md` still names that file as the one exception.
- **No em dashes in operator-facing strings.** Repo prose and comments follow their own file's convention.
- **TDD, red then green**, and prove every guard by reverting it.
- **Rebuild dists before trusting a downstream suite** (`bunx turbo build --filter=<pkg>`).
- **Every Elysia `t` schema property carries a `description`.**
- **A migration is created AND registered** in the static map in `apps/server/api/src/db/migrate.ts`; file name and key must match.
- **Verification before each commit:** `bunx turbo run verify-types --force`, `bun run lint:check`, the touched package's `bun test`. Full `bun run test` at Tasks 3, 8 and 13.
- **Known sanctioned baseline:** `apps/server/api` "ZERO-BYTE upload" fails on bun 1.4.2. Unrelated.
- **Protocol census:** a command added or removed must be reflected in the agent's coverage test in the same commit.
- **Commit messages** end with the `Co-Authored-By:` trailer your harness specifies.

## Lane map

```
1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7 -> 8 -> 9 -> 10
                                      \-> 11, 12   (web, needs 9)
                                            \-> 13
```

Task 3 is the gate. Do not proceed past it on a partial pass.

---

### Task 1: The launch frame learns the new fields, optionally

**Files:**
- Modify: `packages/subshell-protocol/src/node-frames.ts` (the `launch` variant ~122-156; its parser case ~470-486)
- Test: `packages/subshell-protocol/src/__tests__/node-frames.test.ts`

**Interfaces:**
- Produces: `launch` gains `argv?: string[]`, `resolve?: { binaryName, envOverride?, knownPaths? }`, and `mcp` gains `args?: string[]`, `env?: Record<string,string>`.

**Context:** additive and OPTIONAL, so an agent that ignores them behaves exactly as today. `NODE_PROTOCOL_VERSION` does NOT move in this task; it moves once in Task 8 when the removals land. The placeholder constant lives here so both sides import one definition.

- [ ] **Step 1: Write the failing tests**

```ts
test("launch parses without the new fields, exactly as today", () => {
  const cmd = { type: "launch", subshellId: "s", socket: "k", cwd: "/w", harnessId: "pi",
    profile: { name: "p", env: {}, flags: [], settings: null, configIsolation: false },
    subshellEnv: {}, subshellName: "s" };
  expect(parseNodeCommandBody(cmd)).toMatchObject({ type: "launch", argv: undefined });
});

test("launch carries argv, a resolve rule, and mcp args/env when present", () => {
  const cmd = { /* ...as above..., */ argv: [HARNESS_BINARY_PLACEHOLDER, "--flag"],
    resolve: { binaryName: "pi" },
    mcp: { path: "/p", fileContent: "{}", args: ["--mcp-config", "/p"], env: { A: "b" } } };
  const parsed = parseNodeCommandBody(cmd) as { argv: string[]; mcp: { args: string[] } };
  expect(parsed.argv).toEqual([HARNESS_BINARY_PLACEHOLDER, "--flag"]);
  expect(parsed.mcp.args).toEqual(["--mcp-config", "/p"]);
});

test("a non-string-array argv is refused rather than coerced", () => {
  expect(parseNodeCommandBody({ /* ...valid launch..., */ argv: "pi --flag" })).toBeNull();
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `cd packages/subshell-protocol && bun test`

- [ ] **Step 3: Implement**

```ts
/**
 * Stands in for the harness binary inside a server-built `argv`.
 *
 * The control plane builds the argv but cannot know where the binary is on the
 * target machine at the moment of launch: an inventory can be minutes old and
 * predate an upgrade. So the plane emits this token and the NODE substitutes
 * its own freshly resolved path. Late binding of one node-owned fact, rather
 * than shipping plugin code to resolve it.
 */
export const HARNESS_BINARY_PLACEHOLDER = "@@HARNESS_BINARY@@";
```

Add the optional fields with JSDoc, and extend the parser case to validate them only when present (`isStrArray` for `argv`, a shape check for `resolve`, `isStrArray`/`isStringMap` for the mcp additions).

- [ ] **Step 4: Run green, rebuild, commit**

```bash
bunx turbo build --filter=@internal/subshell-protocol
git add packages/subshell-protocol && git commit
```

Message: `feat(protocol): the launch frame can carry a server-built argv`.

---

### Task 2: The server populates them, the node still ignores them

**Files:**
- Modify: `apps/server/api/src/services/nodes/remote-launcher.ts` (`launch`, ~204-231)
- Modify: `apps/server/api/src/services/mcp-launch.ts` (`planRemoteSubshellMcp`, ~80-90)
- Test: `apps/server/api/src/services/nodes/__tests__/`

**Interfaces:**
- Consumes: Task 1.
- Produces: a `launch` frame carrying `argv`, `resolve` and full `mcp`.

**Context, and it is smaller than it sounds:** `LaunchPlan` already carries everything needed. `harness: HarnessPlugin` is a RESOLVED plugin, `binary` is the target machine's path, and `mcp?: McpRegistration` already holds `args` and `env` computed control-side. `RemoteLauncher.launch` currently drops all three when composing the wire frame. `planRemoteSubshellMcp` deliberately does not surface `args`/`env` today; its comment says so and must be updated rather than left contradicting the code.

Build the argv with the PLACEHOLDER in the binary slot, not the resolved path:

```ts
const argv = plan.harness.buildCommand({
  binary: HARNESS_BINARY_PLACEHOLDER,
  cwd: plan.cwd,
  profile: plan.profile,
  subshellName: plan.subshellName,
  mcp: plan.mcp,
  harnessSession: plan.harnessSession,
});
```

- [ ] **Step 1: Write the failing test**

```ts
test("a remote launch carries an argv whose binary slot is the placeholder", async () => {
  await launcher.launch(planFor("pi"));
  const sent = capturedCommand();
  expect(sent.argv?.[0]).toBe(HARNESS_BINARY_PLACEHOLDER);
  expect(sent.resolve?.binaryName).toBe("pi");
});

test("mcp args and env now ride the wire", async () => {
  await launcher.launch(planFor("claude-code", { mcp: true }));
  const sent = capturedCommand();
  expect(sent.mcp?.args).toEqual(expect.arrayContaining(["--mcp-config"]));
});
```

- [ ] **Step 2: Run red, then implement, then green**

The `resolve` rule comes from the plugin's manifest detection block; find where the server already reads it (`allHarnesses()` / the manifest's `subshell.detect`) and pass `binaryName`, `envOverride` and `knownPaths` straight through.

- [ ] **Step 3: Commit**

Message: `feat(server): send the argv, the resolve rule, and the whole mcp dialect`.

---

### Task 3: THE GATE. Prove the two argvs are identical

**Files:**
- Create: `apps/server/api/src/services/nodes/__tests__/argv-parity.test.ts`
- Test only. No production change.

**Context:** this is the correctness claim of the entire inversion, and it is testable right now because both sides can still compute an argv. If it fails, stop and report rather than proceeding: something about a plugin is not as pure as the spike measured.

- [ ] **Step 1: Write the parity test**

For EACH of the five built-ins, and for a matrix of inputs (no profile settings; settings set; flags present; `harnessSession` in both `resume` and `session-id` modes; mcp present and absent), assert:

```ts
const serverArgv = plugin.buildCommand({ ...inputs, binary: HARNESS_BINARY_PLACEHOLDER });
const nodeArgv = plugin.buildCommand({ ...inputs, binary: "/real/path/to/bin" });
expect(serverArgv.map((a) => (a === HARNESS_BINARY_PLACEHOLDER ? "/real/path/to/bin" : a))).toEqual(nodeArgv);
```

That is the substitution contract stated as an equality: substituting the placeholder must reproduce exactly what the node builds today.

Additionally assert, per plugin, that the placeholder appears **exactly once** in the server argv. A plugin that interpolated the binary into a longer string would break substitution silently, and this is the check that catches it.

- [ ] **Step 2: Run it**

Run: `cd apps/server/api && bun test src/services/nodes/__tests__/argv-parity.test.ts`
Expected: PASS for all five. **If any plugin fails, STOP.** Report which plugin and which input, and do not start Task 4. The likely cause is a plugin embedding the binary in a composed string, which needs a design answer, not a workaround.

- [ ] **Step 3: Run the full suite and commit**

Run: `bun run test`
Message: `test: a server-built argv substitutes to exactly what the node builds`.

---

### Task 4: The node uses the argv it was sent

**Files:**
- Modify: `apps/node/agent/src/commands/launch.ts`
- Test: `apps/node/agent/src/__tests__/commands-launch.test.ts`

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces: a node that prefers `cmd.argv` when present and falls back to building its own when absent.

**Context:** the fallback is what keeps this task green and reversible. It disappears in Task 7.

- [ ] **Step 1: Write the failing tests**

```ts
test("a launch carrying argv spawns exactly that, with the binary substituted", async () => {
  await execLaunch(ctx, launchCmd({ argv: [HARNESS_BINARY_PLACEHOLDER, "--flag"], resolve: { binaryName: "pi" } }));
  expect(spawnedArgv()).toEqual(["/resolved/pi", "--flag"]);
});

test("a launch with no argv still builds one locally, as today", async () => {
  await execLaunch(ctx, launchCmd({}));
  expect(spawnedArgv()[0]).toBe("/resolved/pi");
});

test("an unresolvable binary still fails with the prefix the backend keys on", async () => {
  const res = await execLaunch(ctx, launchCmd({ argv: [HARNESS_BINARY_PLACEHOLDER], resolve: { binaryName: "nope" } }));
  expect(res.ok).toBe(false);
  expect((res as { error: string }).error).toMatch(/^harness binary missing/);
});
```

- [ ] **Step 2: Run red, implement, green**

Resolve the binary from `cmd.resolve` using the existing `detectBinary`/`findBinary` helpers (they take `binaryName`, `envOverride`, `knownPaths`, which is exactly the `resolve` shape), substitute every occurrence of the placeholder, and spawn. When `cmd.mcp.args`/`env` are present use them instead of recomputing; keep the local recomputation only for the no-argv fallback path.

The `harness binary missing:` prefix is load-bearing: the backend regex-matches it to refresh an inventory. Keep it byte-identical.

- [ ] **Step 3: Commit**

Message: `feat(agent): spawn the argv the control plane sent`.

---

### Task 5: Detection becomes a command

**Files:**
- Modify: `packages/subshell-protocol/src/node-frames.ts` (add `detect`)
- Modify: `apps/node/agent/src/commands/basics.ts` and `commands/index.ts`
- Modify: `apps/server/api/src/services/nodes/inventory.ts`
- Test: alongside each

**Interfaces:**
- Produces: `detect { specs }` -> `[{ id, found, path?, rawVersion?, reason? }]`, and a server-side driver that caches into `nodes.inventory_json`.

**Context:** shape the result against the existing `EffectiveHarnessState` rather than inventing a parallel type (spec §12). The node returns RAW version text; `parseVersion` is plugin code and runs on the control plane, which is a behavior move worth its own test since only hermes implements it.

**The cache format does not change, which is the nicest thing about this task.** `HarnessInventoryEntry` is `{ harnessId, installed, version?, binaryPath?, reason?, checkedAt? }`, and the server stores an array of them via `NodesRepository.applyInventory(id, json)` from the `case "inventory"` arm of the ws handler. The wire result here is the SAME shape with `version` replaced by `rawVersion`; the server maps `rawVersion` through `parseVersion` and stores exactly what it stores today. `INVENTORY_TTL_MS` and every reader keep working.

- [ ] **Step 1: Write the failing tests**

Node side:

```ts
test("detect answers one row per spec, and does not parse the version", async () => {
  const res = await execDetect(ctx, { type: "detect", specs: [
    { id: "pi", binaryName: "pi", envOverride: "PI_BINARY", knownPaths: [] },
    { id: "ghost", binaryName: "definitely-not-here", envOverride: "X", knownPaths: [] },
  ]});
  const rows = (res as { ok: true; data: { results: DetectResultWire[] } }).data.results;
  expect(rows.find((r) => r.harnessId === "pi")).toMatchObject({ installed: true });
  // RAW text, unparsed: parseVersion is plugin code and does not run here.
  expect(rows.find((r) => r.harnessId === "pi")?.rawVersion).toContain("pi");
  expect(rows.find((r) => r.harnessId === "ghost")).toMatchObject({ installed: false, reason: "not-on-path" });
});

test("a spec with no binaryName reports no-binary rather than not-on-path", async () => {
  const res = await execDetect(ctx, { type: "detect", specs: [{ id: "term", binaryName: "", envOverride: "", knownPaths: [] }] });
  expect(rowsOf(res)[0]).toMatchObject({ installed: false, reason: "no-binary" });
});
```

Server side:

```ts
test("the driver parses the raw version with the plugin and caches it like an inventory", async () => {
  // hermes prints a banner, not a bare version, and is the only built-in with parseVersion.
  fakeNodeAnswers([{ harnessId: "hermes", installed: true, binaryPath: "/x/hermes", rawVersion: "Hermes v1.2.3 (build 9)" }]);
  await detectOnNode(nodeId);
  const cached = readAgentInventory(await nodes.findById(nodeId));
  expect(cached.entries.get("hermes")?.version).toBe("1.2.3");
  expect(cached.entries.get("hermes")?.checkedAt).toBeTruthy();
});

test("no detect happens without a request", async () => {
  await advanceTime(30 * 60_000);
  expect(sentCommands()).toHaveLength(0);
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `cd apps/node/agent && bun test` then `cd apps/server/api && bun test src/services/nodes/__tests__/`

- [ ] **Step 3: Implement**

Protocol: add `detect { specs: DetectSpecWire[] }` where `DetectSpecWire` mirrors plugin-api's `DetectSpec` (`{ binaryName, envOverride, knownPaths }`) plus the `id` it belongs to, and a `DetectResultWire` = `HarnessInventoryEntry` with `rawVersion?: string` in place of `version?`.

Node handler: for each spec, `detectBinary(spec.binaryName, spec.envOverride, spec.knownPaths)` (from `binary-lookup.ts`, returns `{ path, reason? }`), then `probeVersion(path)` for the raw text when found. Do NOT call `versionOf`, which applies `parseVersion`. An empty `binaryName` yields `reason: "no-binary"`, matching what `detectFor` produces today for a manifest with no `detect` block.

Server driver: build specs from the manifests it holds, send, map each row through the plugin's `parseVersion` when present, and store via the existing `applyInventory`. Called from the node page load, from Re-check, and nowhere on a timer.

- [ ] **Step 4: Run green, prove, commit**

Prove the parse moved: temporarily have the node return an already-parsed version and confirm the hermes test fails on the banner text. Restore.

Message: `feat: detection is a command the plane sends, and versions are parsed here`.

---

### Task 6: `probe_resume` becomes `path_exists`

**Files:**
- Modify: `packages/subshell-protocol/src/node-frames.ts` (variant ~186, parser ~525-528), `node-results.ts` (~199), `index.ts` (~68)
- Modify: `apps/node/agent/src/commands/basics.ts` (`execProbeResume` ~151-160)
- Modify: `apps/server/api/src/services/nodes/remote-launcher.ts` (`canResume` ~561-568)
- Test: alongside

**Context:** the shape changes from `{ harnessId, harnessSessionId, cwd }` to `{ path }`. The control plane computes the path with plugin code, which needs the node's `CLAUDE_CONFIG_DIR`, so this task also adds the node's manifest-declared env reporting (spec §5). A manifest naming the wrong variable fails silently as a resume that never offers itself, so test that case explicitly.

**This is a CONTRACT change, not a rename, and the plan was wrong to imply otherwise.** Today the plugin does the I/O itself:

```ts
// packages/plugins/claude-code/src/index.ts
function claudeConfigDir(): string {
  const override = process.env.CLAUDE_CONFIG_DIR?.trim();
  return override ? resolve(override) : join(homedir(), ".claude");
}
resume: {
  allocateHarnessSessionId: () => crypto.randomUUID(),
  canResume: (harnessSessionId, cwd) =>
    existsSync(join(claudeConfigDir(), "projects", projectSlug(cwd), `${harnessSessionId}.jsonl`)),
}
```

For the control plane to compute that path, `canResume` must stop doing I/O and stop reading `process.env`. `HarnessResume` becomes:

```ts
export interface HarnessResume {
  allocateHarnessSessionId(): string;
  /**
   * Where the resumable transcript would be, given the target machine's
   * environment. PURE: it computes a path and never touches a filesystem, so
   * the control plane can build it for a machine it cannot see. The HOST
   * checks existence.
   */
  resumePath(harnessSessionId: string, cwd: string, hostEnv: HostEnv): string;
}

/** The parts of a target machine's environment a plugin may compute against. */
export interface HostEnv {
  /** The node's home directory */
  homeDir: string;
  /** Values for the variables this plugin's manifest declared it needs */
  env: Record<string, string>;
}
```

`@subshell-ai/plugin-api` is PUBLISHED at 0.0.1, so this is a breaking change to a public contract and needs a major-intent changeset. That is acceptable and expected here; the package has been public for one day and has no dependents.

**The node must report `homeDir`, not just the declared variables**, because `claudeConfigDir`'s fallback is `join(homedir(), ".claude")`. The `ready` event carries `os`, `arch`, `hostname`, `dataDir`, `capabilities` and `executablePath` today and no environment at all, so both fields are new.

- [ ] **Step 1: Write the failing tests**

```ts
// plugin-api / claude-code
test("resumePath is pure and honours the target machine's override", () => {
  const p = claudeCode.resume.resumePath("abc", "/w/x", { homeDir: "/home/n", env: { CLAUDE_CONFIG_DIR: "/custom" } });
  expect(p).toBe("/custom/projects/-w-x/abc.jsonl");
});

test("resumePath falls back to the reported home when the variable is absent", () => {
  const p = claudeCode.resume.resumePath("abc", "/w/x", { homeDir: "/home/n", env: {} });
  expect(p).toBe("/home/n/.claude/projects/-w-x/abc.jsonl");
});

// server
test("canResume computes the path here and asks the node to stat it", async () => {
  await launcher.canResume(claudeCode, "abc", "/w/x");
  expect(lastCommand()).toEqual({ type: "path_exists", path: "/home/n/.claude/projects/-w-x/abc.jsonl" });
});

test("a node that reported no env still resolves a default path", async () => {
  await launcher.canResume(claudeCode, "abc", "/w/x");   // node reported homeDir only
  expect(lastCommand().path).toContain("/.claude/projects/");
});

test("a plugin with no resume member never sends the command", async () => {
  expect(await launcher.canResume(pi, "abc", "/w/x")).toBe(false);
  expect(sentCommands()).toHaveLength(0);
});
```

- [ ] **Step 2: Run red, then implement**

Order within the task: change the contract and claude-code together (they must agree), then the `ready` event's two new fields, then the protocol rename, then the node handler (`existsSync(cmd.path)`), then `remote-launcher.canResume`.

The manifest gains a declaration of which variables the plugin wants; claude-code declares `CLAUDE_CONFIG_DIR`. A manifest naming a variable nothing sets simply yields an absent key and the plugin's own fallback applies, which is why the second test exists.

- [ ] **Step 3: Prove the silent-failure case**

The landmine in spec §11 is a manifest naming the WRONG variable, which fails as a resume that never offers itself. Write it as a test: declare `CLAUDE_CONFIG_DIRR`, assert the computed path falls back to the home default rather than throwing, and leave the test in place as documentation of the failure mode.

- [ ] **Step 4: Green, changeset, commit**

Add a changeset for `@subshell-ai/plugin-api` and the five plugin packages describing the `canResume` to `resumePath` change as breaking.

Message: `refactor(protocol): path_exists, and the env a manifest asks for`.

---

### Task 7: Demolish the node's plugin machinery

**Files:**
- Delete: `apps/node/agent/src/plugin-cli.ts`, `apps/node/agent/src/launch-plugin.ts`
- Delete tests: `__tests__/cli-plugin.test.ts`, `__tests__/plugin-commands.test.ts`, `__tests__/plugin-report.test.ts`, `__tests__/launch-plugin-gate.test.ts`
- Modify: `cli.ts` (import 9; `COMMANDS` 69; `USAGE` 50, 57-60; `SUBCOMMANDS.plugin` 88; `SUBCOMMAND_FLAGS.plugin` 106; `COMMAND_FLAGS.plugin` 139; `parseArgs` 195 and 230-232; `case "plugin"` 401-407)
- Modify: `commands/basics.ts` (`execPluginInstall` 295-310, `execPluginUninstall` 320-329, `pushInventory` 267-274, the import at 2)
- Modify: `commands/index.ts` (cases 84-87 and imports 6, 9)
- Modify: `config.ts` (`registryUrl` 34-40, 113), `configure.ts` (`ConfigureOpts.registryUrl` 30-34, `normalizeRegistry` 37-63, the write branch 93-99)
- Modify: `daemon.ts` (seed import 2, seed call 262-280), `inventory.ts` (`scanInstalledPlugins` 76-86, the `plugins` field 109-118)
- Modify: `commands/launch.ts` (remove the no-argv fallback added in Task 4)
- Edit tests: `__tests__/cli.test.ts`, `__tests__/config.test.ts`, `__tests__/configure.test.ts`, `__tests__/commands-launch.test.ts`

**Context:** these are leaves. Nothing outside the agent imports them. The fallback from Task 4 goes here, which makes `argv` effectively required even though the protocol still says optional until Task 8.

- [ ] **Step 1: Write the test that proves the node holds nothing**

```ts
test("a launch succeeds on a node with no plugins directory at all", async () => {
  await rm(join(dataDir, "plugins"), { recursive: true, force: true });
  const res = await execLaunch(ctx, launchCmd({ argv: [HARNESS_BINARY_PLACEHOLDER], resolve: { binaryName: "pi" } }));
  expect(res.ok).toBe(true);
});
```

- [ ] **Step 2 to 4:** run red, delete per the list, run the agent suite green, commit.

Message: `refactor(agent): the node holds no plugins`.

---

### Task 8: Tighten the protocol and bump to 3

**Files:**
- Modify: `packages/subshell-protocol/src/node-frames.ts`
- Test: `packages/subshell-protocol/src/__tests__/node-frames.test.ts`, plus the agent census test

**Changes:** remove `plugin_install` (variant 230-251, parser 554-559) and `plugin_uninstall` (252-263, 560-561); make `argv` and `resolve` REQUIRED on `launch`; remove `plugins?: PluginReportWire[]` from the inventory event (391-401); `NODE_PROTOCOL_VERSION` 2 -> 3.

- [ ] **Step 1 to 4:** failing tests (a v2 agent is refused; a launch without argv no longer parses; the removed commands parse as null), implement, run the FULL suite, commit.

Message: `feat(protocol): plugins leave the wire (protocol 3)`.

---

### Task 9: The server becomes the only plugin host

**Files:**
- Modify: `apps/server/api/src/services/nodes/inventory.ts` (`readNodePlugins`/`NodePluginSet` 113-149; `effectiveHarnessStates` 174-196; `probeLocally` 205-219)
- Modify: `apps/server/api/src/api/harness-utils.ts` (`agentHarnessUsable*`, `localDeclaredPlugins` 66-145; `usableHarnessIds` 153-180)
- Modify: `apps/server/api/src/services/nodes/plugin-sync.ts` (the remote branch collapses)
- Delete: `apps/server/api/src/api/nodes/set-node-plugin.route.ts` and its tests
- Create: `apps/server/api/src/api/plugins.route.ts` (instance-level install/uninstall/list, ADMIN-only)
- Modify: `apps/server/api/src/api/setup.route.ts` (`installedIdsHere()` at 30-34 reads the server's own installed set, not `local`'s node row)
- Test: alongside

**Context:** "usable" stops being "this node declared it" and becomes "the server has this plugin AND detection says the binary is present there". The instance route is MANDATORY in this task, not deferrable: deleting the per-node route without it leaves no way to install anything.

This task also builds the lifecycle of spec §6.1: an `enabled` flag, and an uninstall that reports its blast radius before destroying anything.

- `plugin_state (plugin_id PK, enabled, updated_at)` is created in Task 10's migration. An ABSENT row means enabled, so installing writes nothing. The flag does NOT go in `install.json`, which the installer rewrites on every install.
- `harnessUsable` and `usableHarnessIds` consult it. That is the whole of "disabling a plugin disables its profiles": availability is already computed, so nothing per-profile is stored.
- An impact endpoint reports, for one plugin id, the number of profiles using it, how many belong to other users, how many are auto-seeded Defaults, and how many have a running subshell.
- Uninstall takes a mode: `keep` (today's behavior, the default) or `delete`. `delete` removes matching profiles across EVERY user including Defaults, bypassing the `isDefault === 1` guard at `profiles.route.ts:269`, which is deliberate here and nowhere else. Running subshells are untouched in both modes.

- [ ] **Step 1: Write the failing tests**

Cover: installing is admin-only and 403 for a non-admin; a non-admin can still LIST; disabling a plugin removes its profiles from `usableHarnessIds` and re-enabling restores them with the rows never touched; the impact endpoint counts other users' profiles, Defaults and running subshells correctly; `uninstall?mode=keep` leaves every profile row in place; `uninstall?mode=delete` removes them across users INCLUDING Defaults; a running subshell survives both; `usableHarnessIds` for a node returns the intersection of the server's catalog and that node's detection.

- [ ] **Step 2: Run and watch them fail**

- [ ] **Step 3: Rewrite the two usability functions**

Both currently branch on `node.kind` and consult the node's declared set. That branch is the thing this task deletes. Today:

```ts
export async function usableHarnessIds(nodeId: string = LOCAL_NODE_ID): Promise<Set<string>> {
  // ...
  if (node && node.kind === "agent") {
    const declared = readNodePlugins(node);          // <- the node's own set: GONE
    const inv = readAgentInventory(node);
    for (const id of declared.entries.keys()) {
      if (agentHarnessUsable(id, declared, inv)) usable.add(id);
    }
    return usable;
  }
  const declared = await localDeclaredPlugins();     // <- also the node row: GONE
  for (const h of allHarnesses()) { /* ... */ }
}
```

After, there is one rule for every node: **the instance has the plugin installed and enabled, AND that node's detection found its binary.**

```ts
export async function usableHarnessIds(nodeId: string = LOCAL_NODE_ID): Promise<Set<string>> {
  const usable = new Set<string>();
  // The instance catalog, not `allHarnesses()`. See the note below: that
  // function returns the EMBEDDED built-ins, never what is installed.
  const installed = await enabledInstalledPlugins();
  const node = nodeId === LOCAL_NODE_ID ? undefined : await new NodesRepository(db).findById(nodeId);
  if (nodeId !== LOCAL_NODE_ID && !node) return usable;
  const inv = node ? readAgentInventory(node) : await probeLocally(installed);
  for (const report of installed) {
    if (report.broken) continue;
    if (inv.entries.get(report.id)?.installed === true) usable.add(report.id);
  }
  return usable;
}
```

**`allHarnesses()` is the wrong source and this is the trap of the task.** It returns only the compiled-in built-ins (`registry.ts`), never what is on disk in `<SUBSHELL_SERVER_DATA_DIR>/plugins/`. Every call site that uses it to mean "what harnesses exist" must move to the installed set from `localPluginReports()`. It keeps ONE honest use: the offline-installable catalog on the plugins page. Audit each of its current call sites in `harness-utils.ts`, `setup.route.ts` and `profiles.route.ts` and classify it as one or the other.

- [ ] **Step 4: The instance route**

Model it on `system-keys.route.ts`, which uses `requireAdmin` (`auth-guard.ts:234-246`: composes `authGuard`, then 403 unless `actor === "cookie"` and the role is admin, so bearer keys are refused outright).

```
GET    /api/plugins                    any authenticated actor: the catalog + installed + enabled
POST   /api/plugins                    admin: { pluginId, spec? }
DELETE /api/plugins/:pluginId          admin: ?mode=keep|delete   (default keep)
GET    /api/plugins/:pluginId/impact   admin: the counts the dialog renders
PATCH  /api/plugins/:pluginId          admin: { enabled }
```

Audit install, uninstall and the enable flip exactly as `system-keys.route.ts` does, with the metadata naming the plugin and, for a delete, the number of profiles removed. Do not audit reads.

- [ ] **Step 5: The repository methods that do not exist yet**

Two gaps, both needing new methods rather than a call to something existing:

- `ProfilesRepository` has `listByUser(userId, harnessId?)` and `delete(id)` and NO list-or-delete by harness across users. Add `listByHarness(harnessId)` and `deleteByHarness(harnessId)`, the latter used only by `mode=delete`.
- `SubshellsRepository` has `listRunning()` (all users) and no count by harness. Add `countRunningByHarness(harnessId)` for the impact endpoint.

The `isDefault === 1` guard at `profiles.route.ts:254-278` stays exactly as it is for the per-profile DELETE route. `deleteByHarness` deliberately does not consult it, and its JSDoc must say why: a Default for a harness that no longer exists is meaningless, and leaving it would be the one row its owner cannot remove.

- [ ] **Step 6: Green, then commit**

Message: `feat(server): one plugin host, and an instance-level door to it`.

---

### Task 9b: The control plane can launch what the registry installed (added by controller ruling R12, 2026-09-10)

**Why this task exists:** the plan had a hole. After Task 9 the instance door
sells registry installs, but every launch-path lookup —
`detectSpecs`/`getHarness`/profile validation — keys off pane-runtime's
compiled-in `BUILT_INS`, which has no registration path, while
`plugin-report.ts` loads each installed plugin via `runtime.load` and discards
the result. A third-party plugin therefore lists, toggles and uninstalls but
can never detect or launch, and Task 13's repointed e2e spec 14 (which asserts
launchability from a node holding nothing) cannot pass. The spec is the
authority: §2 says plugins stay "third-party authorable" and §8 already
accepts plugin code running in the control-plane process. This task closes the
last gap that claim implies.

**Files:**
- Modify: `packages/pane-runtime/src/registry.ts` (or a new `installed-registry.ts` beside it): a function that returns the RESOLVED plugin set = compiled built-ins + successfully-loaded installed plugins from a dataDir, memoized by dataDir+mtime, with per-plugin fault containment (a throwing installed plugin yields a broken entry, never a lost built-in)
- Modify: the server call sites to consult it: `services/nodes/inventory.ts` (`detectSpecs`, the local probe paths), `services/subshell-manager.service.ts` (the `getHarness` resolutions at create/revive), profile validation wherever `profiles.route.ts` resolves harness ids
- Test: pane-runtime suite for the merge (built-in + installed; shadowing rule: a built-in wins, with a warn, because the compiled copy is the one this release tested; corrupt install skipped as broken; same id re-installed → reload after memo invalidation) + one server test proving a scripted "acme" plugin installed into a temp dataDir flows into `detectSpecs()` output and a create against it builds argv

**Rules:** no new runtime deps; the loader stays the single sanctioned
`await import()` site (`plugin-runtime.ts`); loading must not run at module
import (lazy, per the registry's existing fault-boundary comment); the agent
NEVER calls this (the agent holds no plugins — Task 7). Commit subject:
`feat(runtime): installed plugins resolve where they now run`.

---

### Task 10: Drop the per-node plugin columns

**Files:**
- Create: `apps/server/api/src/db/migrations/0026-drop-node-plugins.ts` (drops `plugins_json`/`plugins_at`, creates `plugin_state`)
- Create: `apps/server/api/src/db/types/plugin-state.db-types.ts`
- Modify: `apps/server/api/src/db/migrate.ts`, `apps/server/api/src/db/types/nodes.db-types.ts`, `apps/server/api/src/db/repositories/nodes.repository.ts` (`recordPluginReport` 150-154)

One migration does both halves, because they are the same change of ownership: the per-node mirror goes and the instance-level state arrives. `plugin_state` holds `plugin_id` (PK), `enabled`, `updated_at`, and an absent row means enabled (spec §6.1).

**Context:** `nodes.plugins_json` and `nodes.plugins_at` have no reader after Task 9. Follow `0025-drop-harness-plugins.ts` exactly, including its reasoning for a `down()` that recreates empty columns: there is nothing to reconstruct and no data to preserve.

- [ ] **Step 1 to 4:** a test asserting the columns are gone and boot still migrates cleanly, implement, green, commit.

Message: `refactor(db): drop the per-node plugin mirror`.

---

### Task 11: The instance plugins page

**Files:**
- Create: `apps/server/web/src/routes/settings_.plugins.tsx`
- Modify: `apps/server/web/src/routes/settings.tsx` (link it, beside the existing `/settings/status` link at ~79)
- Create/modify hooks and tests

**Context:** `/settings/plugins`, following the existing sub-page pattern (`settings_.status.tsx` renders `/settings/status`). Carries over from the superseded phase 4 spec: the catalog with one-click installs, the install-by-name field, and the confirmation for a package we did not ship, whose copy states that it runs on the CONTROL PLANE now rather than on a node. That wording change matters: the trust statement is different and stronger than the one phase 4 drafted.

The page also carries §6.1's lifecycle: a Disable toggle per installed plugin, and an uninstall dialog that fetches the impact first and offers Keep (default) or Delete, with the counts spelled out. Copy must state that running subshells are unaffected and that restarting one whose profile was deleted will fail, because that is the surprise otherwise.

**Two constraints from the existing code.** The route file is `settings_.plugins.tsx` (`createFileRoute("/settings_/plugins")`), matching `settings_.status.tsx`. And the app's shared confirmation, `confirmAction` behind `ConfirmProvider`, resolves a BOOLEAN, so it fits the install-by-name prompt and cannot express the uninstall choice. The uninstall dialog is its own component over the `Dialog` primitives.

Follow `settings_.status.tsx`'s admin gate exactly, including its reasoning: `viewerIsAdmin` comes from `usePublicSettings()`, and `undefined` (still loading) is treated as NOT admin so a non-admin never fires a doomed 403. Link it from `settings.tsx` beside the existing Status link, as a `Link` wearing `buttonVariants` rather than a Button wrapping a Link.

- [ ] **Step 1: Write the failing tests**

```tsx
test("a catalog install asks nothing", async () => {
  renderPage({ admin: true, catalog: [{ id: "pi", name: "Pi", installed: false }] });
  await userEvent.click(await screen.findByRole("button", { name: /install/i }));
  expect(posted()).toMatchObject({ pluginId: "pi" });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

test("a typed package name confirms, and says it runs on the control plane", async () => {
  renderPage({ admin: true });
  await userEvent.type(screen.getByLabelText(/install from npm/i), "@acme/plugin-thing");
  await userEvent.click(screen.getByRole("button", { name: /^install$/i }));
  expect(await screen.findByText(/control plane/i)).toBeInTheDocument();
});

test("disabling a plugin marks it disabled without uninstalling", async () => {
  renderPage({ admin: true, installed: [{ id: "pi", name: "Pi", enabled: true }] });
  await userEvent.click(screen.getByRole("switch", { name: /enabled/i }));
  expect(patched()).toEqual({ enabled: false });
});

test("uninstall shows the blast radius and defaults to keeping profiles", async () => {
  renderPage({ admin: true, installed: [{ id: "acme", name: "Acme" }],
    impact: { profiles: 4, otherUsers: 3, defaults: 2, runningSubshells: 1 } });
  await userEvent.click(screen.getByRole("button", { name: /uninstall/i }));
  expect(await screen.findByText(/4 profiles use it, across 3 users/i)).toBeInTheDocument();
  expect(screen.getByRole("radio", { name: /keep the profiles/i })).toBeChecked();
  expect(screen.getByText(/running subshells are unaffected/i)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /^uninstall$/i }));
  expect(deletedWith()).toEqual({ mode: "keep" });
});

test("choosing delete sends mode=delete", async () => { /* same, selecting the other radio */ });

test("a non-admin sees the list and no controls", () => {
  renderPage({ admin: false, installed: [{ id: "pi", name: "Pi" }] });
  expect(screen.getByText("Pi")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /uninstall/i })).not.toBeInTheDocument();
  expect(screen.queryByLabelText(/install from npm/i)).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run red**

- [ ] **Step 3: Implement**

The page has three regions: installed plugins with an Enabled switch and Uninstall each; the offline catalog of embedded built-ins not yet installed, one click each; and the install-by-name field. The uninstall dialog fetches `/api/plugins/:id/impact` on open and renders the counts, defaulting to Keep. Its copy must include that running subshells are unaffected and that restarting one whose profile was deleted will fail.

Copy rule for the typed-name confirmation, and the reason it differs from the superseded phase-4 wording: the package now runs on the CONTROL PLANE, with the reach that implies, rather than on one node. Say that, not the old sentence about a node's OS user.

- [ ] **Step 4: Prove the default, then commit**

Flip the dialog's initial mode to `delete` and confirm the keep-by-default test fails. Restore.

Message: `feat(web): install plugins where they now live`.

---

### Task 12: The node page tells the truth

**Files:**
- Modify: `apps/server/web/src/components/nodes/node-harness-card.tsx`
- Test: alongside

**Context:** the card stops being a plugin manager and becomes detection output: which harnesses this machine can actually run, with `checkedAt` and Re-check. No install or remove controls, because a plugin is not a per-node thing any more. Re-check triggers the on-demand `detect` of Task 5.

**What survives from the current card and what goes.** `node-harness-card.tsx` today renders rows with `badgeLabel`/`badgeVariant` over `{ installed, broken, reason }`, a `checkedAtLabel`, the `restartRequired` notice, the `reason === "override-invalid"` and `"no-binary"` explanations, and per-row error state. Keep all of the rendering. Delete: the `useSetNodePlugin` mutation, the `change()` handler, the Remove buttons, the "Add a plugin" block, the `available` computation, and the `catalog` lookup that recovers a name.

`restartRequired` and `broken` are plugin-load facts that a node no longer produces, so those two branches go with them. Their absence is the visible proof this task landed.

- [ ] **Step 1: Write the failing tests**

```tsx
test("the card manages nothing", () => {
  renderCard({ harnesses: [{ harnessId: "pi", installed: true }] });
  expect(screen.queryByRole("button", { name: /remove/i })).not.toBeInTheDocument();
  expect(screen.queryByText(/add a plugin/i)).not.toBeInTheDocument();
});

test("rows come from detection, and say when they were checked", () => {
  renderCard({ harnesses: [{ harnessId: "pi", installed: true, version: "1.2.3", checkedAt: iso }] });
  expect(screen.getByText(/1\.2\.3/)).toBeInTheDocument();
  expect(screen.getByText(/checked/i)).toBeInTheDocument();
});

test("Re-check issues exactly one detect", async () => {
  renderCard({ harnesses: [], canManage: true });
  await userEvent.click(screen.getByRole("button", { name: /re-check/i }));
  expect(detectCalls()).toHaveLength(1);
});

test("a stale inventory says so rather than pretending", () => {
  renderCard({ harnesses: [{ harnessId: "pi", installed: true }], inventoryStale: true });
  expect(screen.getByText(/last-known/i)).toBeInTheDocument();
});

test("a harness the instance does not have is absent, not shown as broken", () => {
  renderCard({ harnesses: [{ harnessId: "gone", installed: true }], instanceHas: ["pi"] });
  expect(screen.queryByText("gone")).not.toBeInTheDocument();
});
```

- [ ] **Step 2 to 3: Run red, implement**

The card's title and description change with its meaning: it is no longer "what this machine offers" (a plugin set) but which harnesses this machine can run (detection). Say that plainly, and point at `/settings/plugins` for managing them, since an operator arriving here to install something needs to know where it moved.

- [ ] **Step 4: Commit**

Message: `feat(web): a node page that reports what it can run`.

---

### Task 13: Docs, e2e, and the whole-suite pass

**Files:**
- Modify: `AGENTS.md` (the "Plugins are packages, and the node loads them" section is now wrong in its title and its body), `docs/security.md`, `.claude/rules/security-context.md`, `docs/node-protocol.md`, `docs/architecture.md`, `apps/node/agent/AGENTS.md`, `apps/server/api/AGENTS.md`
- Modify: `.changeset/node-owns-its-plugin-set.md` and `.changeset/plugins-from-the-registry.md`
- Modify: `e2e/tests/14-registry-install.spec.ts`
- Test: the full suite

**Context on the changesets, and do not skip this:** both are UNRELEASED and describe the architecture this plan reverses. `node-owns-its-plugin-set.md` opens "A node now owns which harnesses it offers"; `plugins-from-the-registry.md` advertises the `subshell plugin` verbs. Publishing those and then retracting them next release narrates a round trip in a public changelog. Rewrite both to describe the end state, since a changeset is unconsumed markdown until the version PR merges.

- [ ] **Step 1: Docs.** `AGENTS.md`'s plugin section needs its central claim inverted, including the sentence "The NODE owns which plugins it offers" and the line "there is no enable flag on either side", which §6.1 makes false on purpose. `docs/security.md` gains the §8 accounting: third-party code now runs in the control-plane process, which is why installing is admin-only, set against the fact that nodes no longer execute third-party code at all. Add the §9.2 secrets note beside the `BETTER_AUTH_SECRET` guidance, including that a lost `SUBSHELL_SECRETS_KEY` is unrecoverable.
- [ ] **Step 2: e2e.** Spec 14 installs a plugin from the fake registry through the NODE route, which no longer exists. Repoint it at `/settings/plugins` and assert the plugin becomes launchable on a node without anything being installed there.
- [ ] **Step 3: Full verification.** `bunx turbo build`, `verify-types --force`, `lint:check`, `bun run test`, `bun run rust:check`, `cd e2e && bunx playwright test`.
- [ ] **Step 4: Tick and commit.**

Message: `docs: plugins live on the control plane`.

---

## Self-Review (plan author, 2026-09-10)

**Spec coverage.** §2's table: rows 1 to 3 are Tasks 7, 9, 10; row 4 detection is Task 5; `parseVersion` is Task 5; argv is Tasks 2 and 4; mcp args/env are Tasks 1, 2 and 4; the last row is Task 9. §3 the dumb executor is Task 7, proven by its no-plugins-directory test. §4 detection is Task 5. §5 launch and late binding are Tasks 1, 2, 4, with `path_exists` in Task 6. §6 install relocation is Task 9. §7 protocol is Tasks 1, 5, 6, 8. §8 security is Task 13. §9 the phase-4 carry-over is Tasks 11 and 12. §9.1 needs no task, being a decision not to build. §9.2 secrets are NOT in this plan, deliberately: no plugin needs one yet, and §9.2 says to build it against a real case. §10's tests are distributed; its first item is Task 3.

**Found while expanding the tasks, and it changes the shape of the work.**

- **Task 6 is a published-contract change, not a protocol rename.** `canResume(sessionId, cwd)` does its own `existsSync` and reads `process.env.CLAUDE_CONFIG_DIR`, so for the control plane to compute that path the member must become a pure `resumePath(sessionId, cwd, hostEnv)`. `@subshell-ai/plugin-api` is published, so this is a breaking change with a changeset, and every plugin implementing `resume` moves with it. The node must also report its HOME, not only the declared variables, because the fallback is `join(homedir(), ".claude")`.
- **`allHarnesses()` returns the EMBEDDED built-ins, never what is installed.** Every call site using it to mean "what harnesses exist" is wrong after this change, and the failure is SILENT: an installed third-party plugin simply never appears. Task 9 makes auditing those call sites an explicit step.
- **Three repository methods do not exist** and an earlier draft assumed them: profiles by harness across users, delete profiles by harness, and running subshells by harness. Task 9 adds all three.
- **The detect result can reuse `HarnessInventoryEntry`**, with `version` replaced by `rawVersion`. The server maps it through `parseVersion` and stores what it stores today, so the TTL cache and every reader are untouched. That is why Task 5 is small.
- **`confirmAction` resolves a boolean**, so it cannot express the uninstall choice. Task 11 builds that dialog on the `Dialog` primitives rather than bending the shared one.

**The riskiest thing here, named.** Task 3 is a gate rather than a step. If any built-in's argv does not survive placeholder substitution, the whole design assumption is wrong and the plan must stop. I put it before any deletion for exactly that reason, and it is cheap because `buildCommand` is pure.

**Ambiguities resolved here.**
- Task 4 keeps a local-build fallback so the task ends green; Task 7 removes it. Without that split, Task 4 and Task 7 would have to be one large task spanning the protocol and the demolition.
- `argv` and `resolve` are optional until Task 8 for the same reason. The protocol version moves once, not three times.
- Uninstall's effect on profiles is now DECIDED (spec §6.1, 2026-09-10): it asks, defaults to keeping them, and `delete` reaches every user's profiles including Defaults. Disabling is a separate operation that costs no per-profile state, because availability was already computed rather than stored.

**What this plan does NOT do:** instance-level plugin secrets (§9.2, no consumer yet); the setup step 2 rewrite (it keeps working unchanged, since installing to `local` and installing to the server are now the same act); per-node plugin settings (§9.1, decided against); and any Subshell Client node window work, which had a plugins card in the superseded phase 4 and now has nothing to manage.
