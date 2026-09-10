# Plugins on the Control Plane: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move harness plugins off agent nodes onto the control plane. Nodes stop holding plugin packages, manifests and plugin state, and become executors: resolve a binary, write a file, spawn, report.

**Architecture:** A strangler, not a big bang. The launch frame first gains OPTIONAL fields the server populates while the node keeps doing what it does today; a parity test proves the two agree; the node then switches to the sent values; only then is its plugin machinery deleted and the protocol tightened. Every task ends with a green suite, and the correctness claim of the whole change is pinned by a test before anything is removed.

**Tech Stack:** Bun 1.4.x, TypeScript strict, ElysiaJS + TypeBox, Kysely/SQLite, React 19 + TanStack Query, `bun test`, Playwright, biome.

**Spec:** `docs/superpowers/specs/2026-09-10-plugins-on-the-control-plane-design.md`. Read it before Task 1. It supersedes §6, §8.1 to §8.2, §10 and §11 of `2026-09-09-plugin-architecture-design.md`, which keeps everything else.

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

- [ ] **Step 1: Write the failing tests**

Node side: `detect` with two specs returns a row per spec, `found: false` with a `reason` for a missing binary, and raw unparsed version text for a present one. Server side: the driver caches results with `checkedAt`, and `parseVersion` is applied to hermes's real banner output to produce the version the UI shows.

- [ ] **Step 2 to 4:** run red, implement, green, commit.

Message: `feat: detection is a command the plane sends, and versions are parsed here`.

---

### Task 6: `probe_resume` becomes `path_exists`

**Files:**
- Modify: `packages/subshell-protocol/src/node-frames.ts` (variant ~186, parser ~525-528), `node-results.ts` (~199), `index.ts` (~68)
- Modify: `apps/node/agent/src/commands/basics.ts` (`execProbeResume` ~151-160)
- Modify: `apps/server/api/src/services/nodes/remote-launcher.ts` (`canResume` ~561-568)
- Test: alongside

**Context:** the shape changes from `{ harnessId, harnessSessionId, cwd }` to `{ path }`. The control plane computes the path with plugin code, which needs the node's `CLAUDE_CONFIG_DIR`, so this task also adds the node's manifest-declared env reporting (spec §5). A manifest naming the wrong variable fails silently as a resume that never offers itself, so test that case explicitly.

- [ ] **Step 1 to 4:** failing tests (including "a node that reports no env still resolves a default path", and "an unknown declared variable yields no resume rather than a crash"), implement, green, commit.

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
- Modify: `apps/server/api/src/api/setup.route.ts` (`declaredPluginIds` 24-32 reads the server's catalog)
- Test: alongside

**Context:** "usable" stops being "this node declared it" and becomes "the server has this plugin AND detection says the binary is present there". The instance route is MANDATORY in this task, not deferrable: deleting the per-node route without it leaves no way to install anything.

- [ ] **Step 1: Write the failing tests**

Cover: installing is admin-only and 403 for a non-admin; a non-admin can still LIST; uninstalling a plugin in use by a profile behaves as decided (refuse, or allow and let the profile go unusable, and whichever you choose, test it); `usableHarnessIds` for a node returns the intersection of the server's catalog and that node's detection.

- [ ] **Step 2 to 4:** run red, implement, green, commit.

Message: `feat(server): one plugin host, and an instance-level door to it`.

---

### Task 10: Drop the per-node plugin columns

**Files:**
- Create: `apps/server/api/src/db/migrations/0026-drop-node-plugins.ts`
- Modify: `apps/server/api/src/db/migrate.ts`, `apps/server/api/src/db/types/nodes.db-types.ts`, `apps/server/api/src/db/repositories/nodes.repository.ts` (`recordPluginReport` 150-154)

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

- [ ] **Step 1 to 4:** failing tests (catalog install sends no confirmation; a typed name confirms and names the control plane; a non-admin sees the list and no controls), implement, green, commit.

Message: `feat(web): install plugins where they now live`.

---

### Task 12: The node page tells the truth

**Files:**
- Modify: `apps/server/web/src/components/nodes/node-harness-card.tsx`
- Test: alongside

**Context:** the card stops being a plugin manager and becomes detection output: which harnesses this machine can actually run, with `checkedAt` and Re-check. No install or remove controls, because a plugin is not a per-node thing any more. Re-check triggers the on-demand `detect` of Task 5.

- [ ] **Step 1 to 4:** failing tests (no install or remove controls exist; rows render from detection; Re-check issues one detect; an offline node says so), implement, green, commit.

Message: `feat(web): a node page that reports what it can run`.

---

### Task 13: Docs, e2e, and the whole-suite pass

**Files:**
- Modify: `AGENTS.md` (the "Plugins are packages, and the node loads them" section is now wrong in its title and its body), `docs/security.md`, `.claude/rules/security-context.md`, `docs/node-protocol.md`, `docs/architecture.md`, `apps/node/agent/AGENTS.md`, `apps/server/api/AGENTS.md`
- Modify: `.changeset/node-owns-its-plugin-set.md` and `.changeset/plugins-from-the-registry.md`
- Modify: `e2e/tests/14-registry-install.spec.ts`
- Test: the full suite

**Context on the changesets, and do not skip this:** both are UNRELEASED and describe the architecture this plan reverses. `node-owns-its-plugin-set.md` opens "A node now owns which harnesses it offers"; `plugins-from-the-registry.md` advertises the `subshell plugin` verbs. Publishing those and then retracting them next release narrates a round trip in a public changelog. Rewrite both to describe the end state, since a changeset is unconsumed markdown until the version PR merges.

- [ ] **Step 1: Docs.** `AGENTS.md`'s plugin section needs its central claim inverted, including the sentence "The NODE owns which plugins it offers". `docs/security.md` gains the §8 accounting: third-party code now runs in the control-plane process, which is why installing is admin-only, set against the fact that nodes no longer execute third-party code at all. Add the §9.2 secrets note beside the `BETTER_AUTH_SECRET` guidance, including that a lost `SUBSHELL_SECRETS_KEY` is unrecoverable.
- [ ] **Step 2: e2e.** Spec 14 installs a plugin from the fake registry through the NODE route, which no longer exists. Repoint it at `/settings/plugins` and assert the plugin becomes launchable on a node without anything being installed there.
- [ ] **Step 3: Full verification.** `bunx turbo build`, `verify-types --force`, `lint:check`, `bun run test`, `bun run rust:check`, `cd e2e && bunx playwright test`.
- [ ] **Step 4: Tick and commit.**

Message: `docs: plugins live on the control plane`.

---

## Self-Review (plan author, 2026-09-10)

**Spec coverage.** §2's table: rows 1 to 3 are Tasks 7, 9, 10; row 4 detection is Task 5; `parseVersion` is Task 5; argv is Tasks 2 and 4; mcp args/env are Tasks 1, 2 and 4; the last row is Task 9. §3 the dumb executor is Task 7, proven by its no-plugins-directory test. §4 detection is Task 5. §5 launch and late binding are Tasks 1, 2, 4, with `path_exists` in Task 6. §6 install relocation is Task 9. §7 protocol is Tasks 1, 5, 6, 8. §8 security is Task 13. §9 the phase-4 carry-over is Tasks 11 and 12. §9.1 needs no task, being a decision not to build. §9.2 secrets are NOT in this plan, deliberately: no plugin needs one yet, and §9.2 says to build it against a real case. §10's tests are distributed; its first item is Task 3.

**The riskiest thing here, named.** Task 3 is a gate rather than a step. If any built-in's argv does not survive placeholder substitution, the whole design assumption is wrong and the plan must stop. I put it before any deletion for exactly that reason, and it is cheap because `buildCommand` is pure.

**Ambiguities resolved here.**
- Task 4 keeps a local-build fallback so the task ends green; Task 7 removes it. Without that split, Task 4 and Task 7 would have to be one large task spanning the protocol and the demolition.
- `argv` and `resolve` are optional until Task 8 for the same reason. The protocol version moves once, not three times.
- Task 9 must decide what uninstalling a plugin does to profiles that use it. I did not decide it because it is a product question, not a mechanical one: refusing is safer, allowing is simpler, and both are defensible. Whichever the implementer picks, the plan requires a test pinning it.

**What this plan does NOT do:** instance-level plugin secrets (§9.2, no consumer yet); the setup step 2 rewrite (it keeps working unchanged, since installing to `local` and installing to the server are now the same act); per-node plugin settings (§9.1, decided against); and any Subshell Client node window work, which had a plugins card in the superseded phase 4 and now has nothing to manage.
