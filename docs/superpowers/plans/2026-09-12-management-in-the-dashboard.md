# Management in the Dashboard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every server-up management surface of Subshell Server's native console moves into the SPA behind four new admin routes (so a browser on the LAN and a headless install get it too); the console window is deleted; the app boots to the dashboard when the server is running and to a one-screen native recovery assistant when it is not. The node agent reports how it runs and accepts a plane-sent restart, the SPA's node detail shows it, and Subshell Client's node window becomes the same kind of assistant.

**Architecture:** The server grows `GET /api/admin/server` (deployment view built from `collectStatus` + `queryService`), `PATCH /api/admin/server/config` (the CLI's `configure` core extracted into `applyConfig` and shared), `POST /api/admin/server/restart` (self-exit when the service manager's pid is this process; the unit/plist respawn it) `GET /api/admin/server/logs` (the last lines of a 200 KB capped log file on disk; nothing is kept in memory) and `PUT /api/admin/server/logging` (a debug toggle, off by default, that also switches HTTP request logging on). The SPA gets `/settings/service` composed of Service, Addresses, Locations and Server-log cards plus a restart waiter, an About dialog, and a Runtime card + Restart on node detail over a new `restart` node command. The Tauri server app keeps two windows (`main`, `wizard`), moves the console's poll into a Rust `watch` thread (tray state + re-pointing `main` after a port change), and turns the wizard into an assistant with Recovery, Update and Reset screens. Subshell Client's node page becomes the same assistant frame.

**Tech Stack:** ElysiaJS + `t` schemas + `bun test` (`apps/server/api`); React 19 + TanStack Router/Query + Base-UI/shadcn primitives + lucide-react (`apps/server/web`); Tauri v2 (Rust) + plain-DOM TypeScript + Vite (`apps/server/desktop/ui`); React + Vite (`apps/client/desktop/ui`); Bun agent (`apps/node/agent`); `@internal/subshell-protocol` hand-rolled validators.

**Spec:** `docs/superpowers/specs/2026-09-12-management-in-the-dashboard-design.md` — read it first. § 2 is the rule every task serves; § 3 the routes; § 4 the SPA; § 5 the server app; § 6 the client and agent.

## Global Constraints

- Bun only (`bun`, `bunx`); never npm/pnpm/yarn. Every dependency version pinned exactly (no `^`/`~`).
- No `await import()` anywhere (the one sanctioned exception is `packages/pane-runtime/src/plugin-runtime.ts`).
- Every Elysia `t` schema property carries a `description`. Schemas are named constants, never inline.
- All public functions and interface properties carry JSDoc.
- Vocabulary: **server** = control plane, **node** = a machine that runs agents, **client** = a human interface. The word "console" leaves the codebase with the window.
- `apps/server/**` is AGPL-3.0-only; everything else Apache-2.0. `packages/backend-errors` and `packages/subshell-protocol` receive only code that has no server import.
- Changesets: `@internal/server`, `@internal/desktop-server`, `@internal/node`, `@internal/desktop-client` only. **Never** `@internal/server-web`.
- No em dashes in user-facing copy of the desktop pages (house rule, `504b927`). Titles in Title Case, subtitles in sentence case (spec 2026-09-11 § 3.2). "this Mac" on darwin, "this machine" elsewhere.
- Verification after every task, from the repo root: `bun run verify-types && bun run lint:check && bun run test`. Rust tasks additionally `bun run rust:check`.
- Per-package test commands: API `cd apps/server/api && bun test <file>`; web `cd apps/server/web && bun test <file>`; agent `cd apps/node/agent && bun test <file>`; protocol `cd packages/subshell-protocol && bun test`; desktop UI `cd apps/server/desktop && bun run test` / `cd apps/client/desktop && bun run test`.
- After changing any API route or schema, run `turbo build` so `@internal/backend-client` re-infers the `App` type before touching the SPA.
- Commit after each task with trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Do not push. Work on branch `feat/management-in-the-dashboard`.
- Assistant frame constants (spec 2026-09-11 § 3.1) for every native screen: window 1024×720 fixed; column max-width 560px; illustration 96px; title 30px/600/-0.01em; subtitle 15px muted; content 36px below subtitle; forms 360px; bottom bar 72px with a hairline top; dots 8px (current 10px) at 10px gap.

## File Structure

**Server (`apps/server/api/src`)**
- `config-env.ts` — records which keys `loadConfigEnv` applied (`configEnvAppliedKeys()`).
- `commands/configure.ts` — `applyConfig(input, configDir)` extracted; `runConfigure` becomes prompt-collection + one `applyConfig` call.
- `services/server-deployment.ts` — `isSupervised`, `collectDeployment()`: the § 3.1 view.
- `services/server-restart.ts` — `performRestart(deps)`: close sockets, exit.
- `utils/log-file.ts` — `serverLogFile` (the capped file transport, whichever the spike chose), `readServerLogTail`, `SERVER_LOG_CAP_BYTES`.
- `services/logging-preference.ts` — `applyDebugLogging`, `debugLoggingState`, `currentDebugLogging`, `setDebugLogging`, `DEBUG_LOGGING_KEY`.
- `utils/logger.ts` — file transport beside stdout; stdout pinned at `info`.
- `plugins/context.plugin.ts` — `autoLogging` at `debug` with the polled routes ignored.
- `constants.ts` — `SUBSHELL_DEBUG_LOGGING`; `BACKEND_LOG_LEVEL` removed.
- `commands/status.ts` — `paths.serverLog`.
- `api/admin-server/{index,get-server.route,patch-config.route,restart.route,logs.route}.ts` + `__tests__/`.
- `api/routes.ts` — registers `adminServerRoutes` in `adminRoutes`.
- `services/nodes/node-registry.ts` — `NodeAgentFacts.runtime?`; `disconnectAllNodes()`.
- `services/nodes/node-ws-handler.ts` — stores `runtime` from `ready`.
- `api/nodes/node-view.ts` — `NodeRuntimeSchema`, `GetNodeResponseSchema.runtime?`.
- `api/nodes/get-node.route.ts` — attaches `runtime` for online, config-capable, agent nodes.
- `api/nodes/restart-node.route.ts` + test; `api/nodes/index.ts` registers it.
- `ws/viewers.ts` — `closeAllViewers(code, reason)`.

**Shared packages**
- `packages/backend-errors/src/error-codes.ts` — seven new codes.
- `packages/subshell-protocol/src/node-frames.ts` — `NodeRuntimeReport`, `ready.runtime?`, `restart` command, two result-error constants.

**Agent (`apps/node/agent/src`)**
- `runtime.ts` — `collectRuntime(deps)`.
- `daemon.ts` — `readyEvent(config, runtime)`; `DaemonDeps.runtime`; `requestRestart`.
- `commands/context.ts` — `runtime`, `requestRestart` on `CommandContext`; `commands/restart.ts`; dispatch case.
- `service.ts` — `AGENT_LOG_HINT`.

**SPA (`apps/server/web/src`)**
- `types/server-deployment.ts`; `hooks/use-server-deployment.ts`; `hooks/use-server-restart.ts`; `hooks/use-server-logs.ts`.
- `components/service/{service-card,addresses-card,locations-card,server-log-card,update-card,restart-dialog}.tsx`.
- `routes/settings_.service.tsx`; `components/app-sidebar.tsx` (seventh child).
- `lib/desktop.ts` (`bundledServer`); `components/desktop/desktop-server-pill.tsx`; `components/settings/reset-card.tsx`; `components/about-dialog.tsx`; `components/user-menu.tsx`.
- `types/node.ts` (`runtime?`); `hooks/use-nodes.ts` (`useRestartNode`); `components/nodes/node-runtime-card.tsx`; `routes/nodes_.$id.tsx`.

**Desktop server (`apps/server/desktop`)**
- `src-tauri/src/control.rs` — `boot_window`, `open_home`, `desktop_open_assistant`, `ACTION_IN_FLIGHT`, deleted commands.
- `src-tauri/src/watch.rs` — the poll thread.
- `src-tauri/src/windows.rs` — `open_console`/`tuck_console`/`open_manage_window` removed; `user_agent` gains `b=`.
- `src-tauri/src/tray.rs`, `menu.rs`, `lib.rs`, `reset.rs`.
- `src-tauri/permissions/desktop.toml`, `capabilities/{wizard,main}.json`; `capabilities/console.json` deleted.
- `ui/src/lib/wizard-state.ts` — `screensFor(probe, onboarded)`, `recoveryTitle`, `recoveryAction`; `ui/src/wizard.ts` — Recovery/Update/Reset screens; `ui/src/assistant/` (moved modules); `ui/index.html`, `ui/src/main.ts`, `ui/src/console/` deleted.

**Desktop client (`apps/client/desktop`)**
- `ui/src/lib/node-assistant-state.ts`; `ui/src/components/assistant/*`; `ui/src/app.tsx`.
- `src-tauri/src/tray.rs`, `control.rs`, `lib.rs`, `windows.rs`, `permissions/desktop.toml`, `capabilities/node.json`.

---

## Phase A — Server: the four admin routes

### Task 1: `loadConfigEnv` records the keys it applied

The server cannot tell "set in the real environment" from "loaded from config.env at boot" after the fact, and `status.ts`'s `tag()` compares `process.env` to the file, which is wrong inside a long-running process once the file is edited. Record what the loader applied.

**Files:**
- Modify: `apps/server/api/src/config-env.ts:142-151`
- Test: `apps/server/api/src/__tests__/config-env-applied.test.ts`

**Interfaces:**
- Produces: `export function configEnvAppliedKeys(): ReadonlySet<string>` — the keys `loadConfigEnv` copied into `process.env` in this process.

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/api/src/__tests__/config-env-applied.test.ts
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configEnvAppliedKeys, loadConfigEnv } from "@/config-env.js";

const made: string[] = [];
const KEY_A = `SUBSHELL_TEST_APPLIED_${process.pid}_A`;
const KEY_B = `SUBSHELL_TEST_APPLIED_${process.pid}_B`;

afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env[KEY_A];
  delete process.env[KEY_B];
  delete process.env.SUBSHELL_SERVER_CONFIG_DIR;
});

describe("configEnvAppliedKeys", () => {
  it("names exactly the keys the loader copied into process.env, never a key the environment already held", () => {
    const dir = mkdtempSync(join(tmpdir(), "subshell-cfg-"));
    made.push(dir);
    writeFileSync(join(dir, "config.env"), `${KEY_A}=from-file\n${KEY_B}=also-file\n`);
    process.env.SUBSHELL_SERVER_CONFIG_DIR = dir;
    process.env[KEY_B] = "from-env"; // env wins; the loader must not claim it
    loadConfigEnv();
    expect(process.env[KEY_A]).toBe("from-file");
    expect(process.env[KEY_B]).toBe("from-env");
    expect(configEnvAppliedKeys().has(KEY_A)).toBe(true);
    expect(configEnvAppliedKeys().has(KEY_B)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/server/api && bun test src/__tests__/config-env-applied.test.ts`
Expected: FAIL — `configEnvAppliedKeys` is not exported.

- [ ] **Step 3: Implement**

In `apps/server/api/src/config-env.ts`, above `loadConfigEnv`:

```ts
/** Keys this process's `loadConfigEnv` copied into `process.env` (module-level: one process, one boot). */
const appliedKeys = new Set<string>();

/**
 * Which `process.env` keys came from config.env at boot, as opposed to the
 * real environment. The running server needs this to attribute a setting's
 * source honestly: after boot, `process.env` holds the file's values too, so
 * comparing the two (what `status` does in a fresh CLI process) would call
 * every hand-edited key "process env".
 */
export function configEnvAppliedKeys(): ReadonlySet<string> {
  return appliedKeys;
}
```

Inside `loadConfigEnv`, where a key is written into `process.env` (the setdefault branch), add `appliedKeys.add(key);` beside the assignment.

- [ ] **Step 4: Run the test; then the whole package**

Run: `cd apps/server/api && bun test src/__tests__/config-env-applied.test.ts && bun test src/__tests__/config-env*.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/api/src/config-env.ts apps/server/api/src/__tests__/config-env-applied.test.ts
git commit -m "feat(server): config-env records which keys it applied at boot"
```

---

### Task 2: Extract `applyConfig` from `runConfigure`

The route and the CLI must write byte-identical files from the same input. One writer.

**Files:**
- Modify: `apps/server/api/src/commands/configure.ts:296-483`
- Test: `apps/server/api/src/commands/__tests__/apply-config.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ApplyConfigInput { port?: string; host?: string; baseUrl?: string; trustedOrigins?: string; dbPath?: string }
  export type ApplyConfigResult =
    | { ok: true; path: string; values: Record<string, string>; warnings: string[]; changed: { key: ConfigKey; from: string | undefined; to: string | undefined }[] }
    | { ok: false; key: ConfigKey; reason: string };
  export function applyConfig(input: ApplyConfigInput, configDir: string): ApplyConfigResult
  ```
  Consumed by Task 8 (the PATCH route) and by `runConfigure`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/api/src/commands/__tests__/apply-config.test.ts
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyConfig } from "@/commands/configure.js";

const made: string[] = [];
function dir(): string {
  const d = mkdtempSync(join(tmpdir(), "subshell-apply-"));
  made.push(d);
  return d;
}
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("applyConfig", () => {
  it("writes the four owned keys with defaults for what was not given, and preserves foreign keys verbatim", () => {
    const d = dir();
    writeFileSync(join(d, "config.env"), "BETTER_AUTH_SECRET=keepme\nSERVER_PORT=3080\n");
    const r = applyConfig({ port: "3090" }, d);
    expect(r.ok).toBe(true);
    const text = readFileSync(join(d, "config.env"), "utf8");
    expect(text).toContain("BETTER_AUTH_SECRET=keepme");
    expect(text).toContain("SERVER_PORT=3090");
    expect(text).toContain("HOST=0.0.0.0");
    expect(text).not.toContain("TRUSTED_ORIGINS=");
    if (r.ok) expect(r.changed).toEqual([{ key: "SERVER_PORT", from: "3080", to: "3090" }]);
  });

  it("refuses an invalid value with the key and the CLI's own reason, and writes nothing", () => {
    const d = dir();
    const r = applyConfig({ port: "70000" }, d);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.key).toBe("SERVER_PORT");
      expect(r.reason.length).toBeGreaterThan(0);
    }
    expect(() => readFileSync(join(d, "config.env"))).toThrow();
  });

  it("canonicalizes trusted origins, deletes the key when cleared, and warns on a LAN bind with a loopback base URL", () => {
    const d = dir();
    const first = applyConfig({ trustedOrigins: "HTTPS://Example.com:443/ , http://10.0.0.5:3080" }, d);
    expect(first.ok).toBe(true);
    expect(readFileSync(join(d, "config.env"), "utf8")).toContain("TRUSTED_ORIGINS=https://example.com,http://10.0.0.5:3080");
    if (first.ok) expect(first.warnings.some((w) => w.includes("loopback"))).toBe(true);
    const second = applyConfig({ trustedOrigins: "" }, d);
    expect(second.ok).toBe(true);
    expect(readFileSync(join(d, "config.env"), "utf8")).not.toContain("TRUSTED_ORIGINS");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/server/api && bun test src/commands/__tests__/apply-config.test.ts`
Expected: FAIL — `applyConfig` is not exported.

- [ ] **Step 3: Implement `applyConfig` and rebase `runConfigure` on it**

Add to `configure.ts` (above `runConfigure`), reusing the helpers that exist there today (`readExistingConfig`, `writeConfigEnv`, `isLoopbackUrl`, `baseUrlPort`, `normalizeTrustedOrigins`, `validateValue`, `OWNED_KEYS`, `FLAG_FOR_KEY`):

```ts
/** What a caller wants changed; an absent field means "keep the stored value, or the built-in default". */
export interface ApplyConfigInput {
  /** `SERVER_PORT` as text (the CLI passes flag text; the route stringifies its number). */
  port?: string;
  /** `HOST`. */
  host?: string;
  /** `APP_BASE_URL`. */
  baseUrl?: string;
  /** `TRUSTED_ORIGINS`, comma-joined; the empty string CLEARS the key. */
  trustedOrigins?: string;
  /** `DATABASE_PATH` (CLI only; the route never sends it). */
  dbPath?: string;
}

/** One key whose stored value the write changed. */
export interface ConfigChange {
  key: ConfigKey;
  from: string | undefined;
  to: string | undefined;
}

export type ApplyConfigResult =
  | { ok: true; path: string; values: Record<string, string>; warnings: string[]; changed: ConfigChange[] }
  | { ok: false; key: ConfigKey; reason: string };

/**
 * THE config.env writer: merge the input over the stored values (or the
 * built-in defaults), validate every key with `validateValue`, canonicalize
 * the origins, compute the two advisory warnings, and write the file
 * atomically, carrying every key this tool does not own forward verbatim.
 *
 * Shared by `configure`/`init` and by `PATCH /api/admin/server/config`, so
 * the CLI and the SPA cannot disagree about what a valid file is. No prompt,
 * no exit, no output: the caller renders the result.
 *
 * A stored value that is invalid and NOT being changed is kept (with a
 * warning) rather than refused — the CLI's long-standing leniency, so a bad
 * `DATABASE_PATH` someone wrote by hand does not block a port change.
 */
export function applyConfig(input: ApplyConfigInput, configDir: string): ApplyConfigResult {
  let existing: Record<string, string>;
  try {
    existing = readExistingConfig(configDir);
  } catch (err) {
    return { ok: false, key: "SERVER_PORT", reason: `refusing to rewrite ${join(configDir, "config.env")}: ${(err as Error).message}` };
  }
  const warnings: string[] = [];
  const dflt = (key: ConfigKey, builtin: string): string => existing[key] ?? builtin;
  const pick = (key: ConfigKey, given: string | undefined, builtin: string): { ok: true; value: string } | { ok: false; reason: string } => {
    const value = given === undefined ? dflt(key, builtin) : given.trim();
    const invalid = validateValue(key, value);
    if (invalid === null) return { ok: true, value };
    if (given === undefined && existing[key] === value) {
      warnings.push(`${key} kept as found in ${join(configDir, "config.env")}: ${invalid}. Pass ${FLAG_FOR_KEY[key]} to replace it.`);
      return { ok: true, value };
    }
    return { ok: false, reason: invalid };
  };

  const port = pick("SERVER_PORT", input.port, "3080");
  if (!port.ok) return { ok: false, key: "SERVER_PORT", reason: port.reason };
  const host = pick("HOST", input.host, "0.0.0.0");
  if (!host.ok) return { ok: false, key: "HOST", reason: host.reason };
  const baseUrl = pick("APP_BASE_URL", input.baseUrl, `http://localhost:${port.value}`);
  if (!baseUrl.ok) return { ok: false, key: "APP_BASE_URL", reason: baseUrl.reason };
  const origins = pick("TRUSTED_ORIGINS", input.trustedOrigins, "");
  if (!origins.ok) return { ok: false, key: "TRUSTED_ORIGINS", reason: origins.reason };
  const dbPath = pick("DATABASE_PATH", input.dbPath, join(configDir, "subshell.db"));
  if (!dbPath.ok) return { ok: false, key: "DATABASE_PATH", reason: dbPath.reason };

  if (host.value === "0.0.0.0" && isLoopbackUrl(baseUrl.value)) {
    warnings.push(
      `HOST=0.0.0.0 (LAN bind) but APP_BASE_URL is loopback (${baseUrl.value}); remote nodes will dial their OWN machine, not this server. ` +
        `Set a reachable APP_BASE_URL (e.g. http://<lan-ip>:${port.value}) unless every node is this box.`,
    );
  }
  const dialPort = baseUrlPort(baseUrl.value);
  if (dialPort !== null && dialPort !== 80 && dialPort !== 443 && String(dialPort) !== port.value) {
    warnings.push(
      `APP_BASE_URL is ${baseUrl.value} but the server will listen on ${port.value}; unless a proxy or an SSH forward maps port ${dialPort} to ${port.value}, ` +
        `a browser dialing ${dialPort} reaches nothing, and one dialing ${port.value} sends an origin this instance does not trust (403 "Invalid origin").`,
    );
  }

  const values: Record<string, string> = {
    ...existing,
    SERVER_PORT: port.value,
    HOST: host.value,
    APP_BASE_URL: baseUrl.value,
    DATABASE_PATH: dbPath.value,
  };
  const normalizedOrigins = normalizeTrustedOrigins(origins.value);
  if (normalizedOrigins === "") delete values.TRUSTED_ORIGINS;
  else values.TRUSTED_ORIGINS = normalizedOrigins;

  const changed: ConfigChange[] = [];
  for (const key of [...OWNED_KEYS, "TRUSTED_ORIGINS"] as ConfigKey[]) {
    if (existing[key] !== values[key]) changed.push({ key, from: existing[key], to: values[key] });
  }
  const path = writeConfigEnv(configDir, values);
  return { ok: true, path, values, warnings, changed };
}
```

Then rewrite the tail of `runConfigure` (from line 306 to the end): keep the tmux preflight and the `interactive` gate; keep `ask` for prompting (flag > prompt > stored default); collect the five answers as strings into an `ApplyConfigInput` (an answer that equals the stored default is still passed through explicitly, so behaviour is unchanged); on EOF keep the existing "stdin closed" message and `return 1`; then:

```ts
  const result = applyConfig(input, deps.configDir);
  if (!result.ok) {
    deps.error(result.reason);
    return 1;
  }
  for (const w of result.warnings) deps.log(`warning: ${w}`);
  deps.log(`wrote ${result.path} (0600)`);
  for (const key of OWNED_KEYS) deps.log(`  ${key} = ${result.values[key]}`);
  if (result.values.TRUSTED_ORIGINS) deps.log(`  TRUSTED_ORIGINS = ${result.values.TRUSTED_ORIGINS}`);
  deps.log("restart the server (or start it with: subshell-server) to apply.");
  return 0;
```

The two `warning:` texts move into `applyConfig` (above) so the CLI prints them from the result; the old inline copies are deleted. Note the CLI previously validated each answer as it was given; now an invalid interactive answer is reported after all questions are asked. That is acceptable (the operator decided no backwards-compatibility burden) and the message text is unchanged.

- [ ] **Step 4: Run the new test and every configure/init test**

Run: `cd apps/server/api && bun test src/commands/__tests__/`
Expected: PASS. If an existing configure test asserted the ORDER of "warning:" lines relative to prompts, update the expectation to the new order (warnings after all answers) and say so in the commit body.

- [ ] **Step 5: Commit**

```bash
git add apps/server/api/src/commands/configure.ts apps/server/api/src/commands/__tests__/apply-config.test.ts
git commit -m "refactor(server): applyConfig is the one config.env writer; configure calls it"
```

---

### Task 3: New error codes

**Files:**
- Modify: `packages/backend-errors/src/error-codes.ts`

**Interfaces:**
- Produces on `BackendErrorCodes`: `CONFIG_INVALID`, `CONFIG_KEY_FROM_ENV`, `RESTART_UNAVAILABLE`, `RESTART_KILLS_PANES`, `LOGGING_FROM_ENV`, `NODE_NOT_SUPERVISED`, `NODE_RESTART_KILLS_PANES`, `NODE_AGENT_TOO_OLD`.

- [ ] **Step 1: Add the members, alphabetically among their neighbours, each with a one-line JSDoc**

```ts
  /** `PATCH /api/admin/server/config`: a value failed the CLI's `validateValue`; the body names `field` and `reason`. */
  CONFIG_INVALID = "CONFIG_INVALID",
  /** `PATCH /api/admin/server/config`: the key is set in the process environment, so a file write would be masked at the next boot. */
  CONFIG_KEY_FROM_ENV = "CONFIG_KEY_FROM_ENV",
  /** `POST /api/nodes/:id/restart`: the node's agent predates the `restart` command. */
  NODE_AGENT_TOO_OLD = "NODE_AGENT_TOO_OLD",
  /** `POST /api/nodes/:id/restart`: the agent is not the process its service manager started, so exiting would not be a restart. */
  NODE_NOT_SUPERVISED = "NODE_NOT_SUPERVISED",
  /** `POST /api/nodes/:id/restart`: the installed service definition would take live panes down; pass `force`. */
  NODE_RESTART_KILLS_PANES = "NODE_RESTART_KILLS_PANES",
  /** `POST /api/admin/server/restart`: the installed service definition would take live panes down; pass `force`. */
  RESTART_KILLS_PANES = "RESTART_KILLS_PANES",
  /** `POST /api/admin/server/restart`: this server is not running under a service manager. */
  RESTART_UNAVAILABLE = "RESTART_UNAVAILABLE",
  /** `PUT /api/admin/server/logging`: `SUBSHELL_DEBUG_LOGGING` is set in the environment, so the setting is read-only. */
  LOGGING_FROM_ENV = "LOGGING_FROM_ENV",
```

- [ ] **Step 2: Build the package so dependents see the codes**

Run: `cd packages/backend-errors && bun run build`
Expected: builds clean.

- [ ] **Step 3: Commit**

```bash
git add packages/backend-errors/src/error-codes.ts
git commit -m "feat(backend-errors): codes for server config, restart, logging and node restart refusals"
```

---

### Task 4: The deployment view (`collectDeployment`) and `isSupervised`

**Files:**
- Create: `apps/server/api/src/services/server-deployment.ts`
- Test: `apps/server/api/src/services/__tests__/server-deployment.test.ts`

**Interfaces:**
- Consumes: `collectStatus(deps)` (`commands/status.ts`), `queryService(deps)`, `DEFAULT_DEPS(seed)`, `SYSTEMD_UNIT_NAME`, `type ServiceState` (`service.ts`), `configEnvAppliedKeys()` (Task 1), `resolveConfig()` (`config-env.ts`), constants `SERVER_PORT`, `HOST`, `APP_BASE_URL`, `DATABASE_PATH`, `DEFAULT_TRUSTED_ORIGINS`.
- Produces:
  ```ts
  export type DeploymentSettingKey = "SERVER_PORT" | "HOST" | "APP_BASE_URL" | "DATABASE_PATH" | "TRUSTED_ORIGINS";
  export const DEPLOYMENT_SETTING_KEYS: readonly DeploymentSettingKey[];
  export type SettingSource = "process env" | "config.env" | "default";
  export interface DeploymentSetting { saved: string; source: SettingSource; running: string; problems?: { entry: string; reason: string }[] }
  export interface DeploymentView { /* exactly spec § 3.1 */ }
  export function isSupervised(service: Pick<ServiceState, "state" | "pid">, pid: number): boolean
  export function settingSource(key: string, env: NodeJS.ProcessEnv, applied: ReadonlySet<string>): SettingSource
  export function collectDeployment(deps?: DeploymentDeps): DeploymentView
  export interface DeploymentDeps { platform?: NodeJS.Platform; home?: string; pid?: number; env?: NodeJS.ProcessEnv; applied?: ReadonlySet<string>; queryService?: () => ServiceState; status?: () => StatusView; debugLogging?: () => { debug: boolean; source: "process env" | "setting" | "default" } }
  ```
  `paths.serverLog` and `logging` get their real sources in Task 5 (`StatusView.paths.serverLog`, `currentDebugLogging()`); this task derives the path from `dataDir` and defaults `logging` to `{ debug: false, source: "default" }` through the `debugLogging` seam.

- [ ] **Step 1: Write the failing tests (pure functions first)**

```ts
// apps/server/api/src/services/__tests__/server-deployment.test.ts
import { describe, expect, it } from "bun:test";
import { isSupervised, settingSource } from "@/services/server-deployment.js";

describe("isSupervised", () => {
  it("is true only when the manager reports this very pid as running", () => {
    expect(isSupervised({ state: "running", pid: 4242 }, 4242)).toBe(true);
    expect(isSupervised({ state: "running", pid: 4243 }, 4242)).toBe(false);
    expect(isSupervised({ state: "stopped", pid: 4242 }, 4242)).toBe(false);
    expect(isSupervised({ state: "running", pid: null }, 4242)).toBe(false);
  });
});

describe("settingSource", () => {
  it("attributes a key the loader applied to config.env even though process.env now holds it", () => {
    expect(settingSource("HOST", { HOST: "0.0.0.0" }, new Set(["HOST"]))).toBe("config.env");
  });
  it("attributes a key present in the environment but not applied to the process env", () => {
    expect(settingSource("HOST", { HOST: "0.0.0.0" }, new Set())).toBe("process env");
  });
  it("attributes an absent key to the default", () => {
    expect(settingSource("HOST", {}, new Set())).toBe("default");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/server/api && bun test src/services/__tests__/server-deployment.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

```ts
// apps/server/api/src/services/server-deployment.ts
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_DATABASE_PATH } from "@internal/subshell-protocol";
import { collectStatus, type StatusView } from "@/commands/status.js";
import { configEnvAppliedKeys, resolveConfig, serverConfigDir } from "@/config-env.js";
import { APP_BASE_URL, DATABASE_PATH, DEFAULT_TRUSTED_ORIGINS, HOST, SERVER_PORT } from "@/constants.js";
import { DEFAULT_DEPS, queryService, type ServiceState, SYSTEMD_UNIT_NAME } from "@/service.js";

/** The `configure`-owned keys, in the order the Service page lists them. */
export const DEPLOYMENT_SETTING_KEYS = ["SERVER_PORT", "HOST", "APP_BASE_URL", "DATABASE_PATH", "TRUSTED_ORIGINS"] as const;
export type DeploymentSettingKey = (typeof DEPLOYMENT_SETTING_KEYS)[number];

/** Where a setting's SAVED value comes from. */
export type SettingSource = "process env" | "config.env" | "default";

/** One setting, as saved versus as running. */
export interface DeploymentSetting {
  /** What config.env (or the built-in default) says now. */
  saved: string;
  /** Which layer `saved` came from; `process env` means the file cannot change it. */
  source: SettingSource;
  /** What THIS process booted with. */
  running: string;
  /** Diagnostics the CLI's `status` attaches to the saved value, verbatim. */
  problems?: { entry: string; reason: string }[];
}

/** The service manager's view plus the one fact only the running process can add. */
export interface DeploymentService {
  /** `launchd` on darwin, `systemd` on linux, null elsewhere. */
  manager: "launchd" | "systemd" | null;
  /** Whether a unit/plist exists on disk. */
  installed: boolean;
  /** Where that definition lives, or would. */
  definitionPath: string | null;
  /** The manager's word for the process state, verbatim. */
  state: string;
  /** The manager's main pid, when it reports one. */
  pid: number | null;
  /** Whether it starts at login. */
  enabled: boolean | null;
  /** Whether stopping keeps live panes. */
  paneSafety: "keeps" | "kills" | "unknown";
  /** The launchd log file; null under systemd (the journal). */
  logPath: string | null;
  /** The command that reads the journal when `logPath` is null. */
  logHint: string | null;
  /** Whether exiting this process is a restart (the manager started it and will respawn it). */
  supervised: boolean;
}

/** `GET /api/admin/server` — how this server is deployed (spec § 3.1). */
export interface DeploymentView {
  configEnv: { path: string; exists: boolean };
  settings: Record<DeploymentSettingKey, DeploymentSetting>;
  restartRequired: boolean;
  authSecret: { state: "set" | "missing"; source: SettingSource };
  paths: { dataDir: string; database: string; logsDir: string; nodeArtifacts: string; serverLog: string };
  service: DeploymentService;
  /** § 3.4: effective debug state, where it comes from, and the file it writes. */
  logging: { debug: boolean; source: "process env" | "setting" | "default"; file: string; capBytes: number };
  restart: { available: boolean; reason: string | null };
  tmuxPath: string | null;
  mcp: { command: string; args: string[]; source: string } | null;
  mcpError: string | null;
  platform: string;
  generatedAt: string;
}

/** Injectable seams; production passes nothing. */
export interface DeploymentDeps {
  platform?: NodeJS.Platform;
  home?: string;
  pid?: number;
  env?: NodeJS.ProcessEnv;
  applied?: ReadonlySet<string>;
  queryService?: () => ServiceState;
  status?: () => StatusView;
}

/**
 * Whether exiting is a restart: the manager says the unit is running AND the
 * pid it reports is this process. `bun run start`, a terminal, a container
 * with no init: all false, and the route says so instead of exiting into
 * nothing.
 */
export function isSupervised(service: Pick<ServiceState, "state" | "pid">, pid: number): boolean {
  return service.state === "running" && service.pid === pid;
}

/** The source rule (Task 1's reason to exist): applied ⇒ config.env, else present ⇒ process env, else default. */
export function settingSource(key: string, env: NodeJS.ProcessEnv, applied: ReadonlySet<string>): SettingSource {
  if (applied.has(key)) return "config.env";
  if (env[key] !== undefined) return "process env";
  return "default";
}

const RESTART_UNSUPERVISED_REASON =
  "This server is not running under a service manager; restart it where you started it.";

/** The value THIS process booted with, per key, from the same constants the server runs on. */
function runningValue(key: DeploymentSettingKey, env: NodeJS.ProcessEnv): string {
  switch (key) {
    case "SERVER_PORT":
      return String(SERVER_PORT);
    case "HOST":
      return HOST;
    case "APP_BASE_URL":
      return APP_BASE_URL;
    case "DATABASE_PATH":
      return DATABASE_PATH;
    case "TRUSTED_ORIGINS":
      return env.TRUSTED_ORIGINS ?? DEFAULT_TRUSTED_ORIGINS;
  }
}

/** The value config.env holds, or the same default `runningValue` falls back to. */
function savedValue(key: DeploymentSettingKey, file: Record<string, string>, savedPort: string): string {
  const fromFile = file[key];
  if (fromFile !== undefined) return fromFile;
  switch (key) {
    case "SERVER_PORT":
      return "3080";
    case "HOST":
      return "0.0.0.0";
    case "APP_BASE_URL":
      return `http://localhost:${savedPort}`;
    case "DATABASE_PATH":
      return DEFAULT_DATABASE_PATH;
    case "TRUSTED_ORIGINS":
      return DEFAULT_TRUSTED_ORIGINS;
  }
}

/** Build the whole § 3.1 view. Reads only. */
export function collectDeployment(deps: DeploymentDeps = {}): DeploymentView {
  const platform = deps.platform ?? process.platform;
  const home = deps.home ?? homedir();
  const pid = deps.pid ?? process.pid;
  const env = deps.env ?? process.env;
  const applied = deps.applied ?? configEnvAppliedKeys();
  const status = (deps.status ?? (() => collectStatus({ platform, home })))();
  const service = (deps.queryService ??
    (() =>
      queryService(
        DEFAULT_DEPS({
          platform,
          home,
          uid: process.getuid?.() ?? 0,
          servicePath: process.execPath,
          argv1: process.argv[1] ?? "",
          configDir: serverConfigDir(),
          env,
          which: (name) => Bun.which(name) ?? null,
          pathEnv: env.PATH,
        }),
      )))();
  const file = resolveConfig().values;
  const savedPort = savedValue("SERVER_PORT", file, "3080");

  const settings = Object.fromEntries(
    DEPLOYMENT_SETTING_KEYS.map((key) => {
      const problems = status.settings[key]?.problems;
      return [
        key,
        {
          saved: savedValue(key, file, savedPort),
          source: settingSource(key, env, applied),
          running: runningValue(key, env),
          ...(problems && problems.length > 0 ? { problems } : {}),
        } satisfies DeploymentSetting,
      ];
    }),
  ) as Record<DeploymentSettingKey, DeploymentSetting>;

  const supervised = isSupervised(service, pid);
  const manager = platform === "darwin" ? "launchd" : platform === "linux" ? "systemd" : null;
  return {
    configEnv: status.configEnv,
    settings,
    restartRequired: DEPLOYMENT_SETTING_KEYS.some((k) => settings[k].saved !== settings[k].running),
    authSecret: status.authSecret,
    paths: { ...status.paths, serverLog: join(status.paths.dataDir, "logs", "server.log") },
    service: {
      manager,
      installed: service.installed,
      definitionPath: service.definitionPath,
      state: service.state,
      pid: service.pid,
      enabled: service.enabled,
      paneSafety: service.paneSafety ?? "unknown",
      logPath: service.logPath ?? null,
      logHint: manager === "systemd" ? `journalctl --user -u ${SYSTEMD_UNIT_NAME} -f` : null,
      supervised,
    },
    restart: { available: supervised, reason: supervised ? null : RESTART_UNSUPERVISED_REASON },
    logging: { ...(deps.debugLogging ?? (() => ({ debug: false as boolean, source: "default" as const })))(), file: join(status.paths.dataDir, "logs", "server.log"), capBytes: 204_800 },
    tmuxPath: status.tmux,
    mcp: status.mcp,
    mcpError: status.mcpError,
    platform,
    generatedAt: new Date().toISOString(),
  };
}
```

`DEFAULT_DEPS`'s seed type is `ServiceSeed` (service.ts:932); pass exactly the fields `cli.ts:325-334` passes, minus `tmuxOffer` (optional). If `serverConfigDir` is not exported from `config-env.ts`, export it (it is defined at line 27).

- [ ] **Step 4: Add a `collectDeployment` test with injected seams**

Append to the test file:

```ts
import { collectDeployment } from "@/services/server-deployment.js";

describe("collectDeployment", () => {
  const service = {
    installed: true, definitionPath: "/u/.config/systemd/user/subshell-server.service", state: "running",
    pid: 777, enabled: true, paneSafety: "keeps", detail: "", logPath: null,
  } as const;
  it("marks restartRequired when a saved value differs from the running one, and reports supervision from the pid", () => {
    const view = collectDeployment({
      platform: "linux", pid: 777, env: { ...process.env, TRUSTED_ORIGINS: undefined }, applied: new Set(),
      queryService: () => service as never,
    });
    expect(view.service.supervised).toBe(true);
    expect(view.restart.available).toBe(true);
    expect(view.service.logHint).toContain("journalctl");
    expect(typeof view.restartRequired).toBe("boolean");
    expect(Object.keys(view.settings)).toEqual(["SERVER_PORT", "HOST", "APP_BASE_URL", "DATABASE_PATH", "TRUSTED_ORIGINS"]);
    expect(view.paths.serverLog.endsWith("/logs/server.log")).toBe(true);
    expect(view.logging).toEqual({ debug: false, source: "default", file: view.paths.serverLog, capBytes: 204_800 });
  });
  it("names the reason when not supervised", () => {
    const view = collectDeployment({ platform: "linux", pid: 1, applied: new Set(), queryService: () => service as never });
    expect(view.restart.available).toBe(false);
    expect(view.restart.reason).toContain("service manager");
  });
});
```

Run: `cd apps/server/api && bun test src/services/__tests__/server-deployment.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/api/src/services/server-deployment.ts apps/server/api/src/services/__tests__/server-deployment.test.ts apps/server/api/src/config-env.ts
git commit -m "feat(server): collectDeployment — the server's own view of how it is deployed"
```

---

### Task 5: The server log file (200 KB, replaced when full), the level policy, and the debug-logging plumbing

Nothing about the log is kept in memory (operator direction 2026-09-12). The server writes one JSON-lines file under its data directory, capped at 200 KB and replaced when full; stdout stays at `info` for the service manager; HTTP request lines are emitted at `debug` and so appear only when debug logging is on.

**Files:**
- Modify: `apps/server/api/src/constants.ts` (add `SUBSHELL_DEBUG_LOGGING`; delete the unused `BACKEND_LOG_LEVEL`)
- Modify: `apps/server/api/src/commands/status.ts:104-108, 218-223` (`paths.serverLog`)
- Create: `apps/server/api/src/utils/log-file.ts`
- Create: `apps/server/api/src/services/logging-preference.ts`
- Modify: `apps/server/api/src/utils/logger.ts:6, 27-38`
- Modify: `apps/server/api/src/plugins/context.plugin.ts:17-23` (`autoLogging`)
- Modify: `apps/server/api/src/index.ts` (apply the stored preference once the database is open, after migrations)
- Modify: `apps/server/api/src/services/server-deployment.ts` (real `paths.serverLog` and `logging` sources replace Task 4's stubs)
- Modify: `apps/server/api/package.json` (the rotation transport, only if the spike passes)
- Test: `apps/server/api/src/utils/__tests__/log-file.test.ts`, `apps/server/api/src/services/__tests__/logging-preference.test.ts`
- Spike (throwaway, not committed): `scratch/log-rotation-spike.ts`

**Interfaces:**
- Produces:
  ```ts
  // utils/log-file.ts
  export const SERVER_LOG_CAP_BYTES = 204_800;
  export function serverLogPath(): string                      // `${SUBSHELL_SERVER_DATA_DIR}/logs/server.log`
  export interface ServerLogLine { ts: string; level: string; message: string; data?: unknown }
  export function parseServerLogLine(line: string): ServerLogLine   // non-JSON → { level: "raw", message: line, ts: "" }
  export function readServerLogTail(path: string, lines: number): Promise<{ lines: ServerLogLine[]; bytes: number }>
  export interface LevelledTransport { level: LogLevelType }   // the one thing the toggle touches
  export const serverLogFile: LevelledTransport                 // the file transport instance (rotation or capped), id "file"
  // services/logging-preference.ts
  export const DEBUG_LOGGING_KEY = "debug_logging";
  export type DebugLoggingSource = "process env" | "setting" | "default";
  export function debugLoggingState(env?: NodeJS.ProcessEnv, stored?: boolean | null): { debug: boolean; source: DebugLoggingSource }
  export function applyDebugLogging(debug: boolean, transport?: LevelledTransport): void   // sets transport.level = debug ? "debug" : "info"
  export async function loadAndApplyDebugLogging(): Promise<void>                          // boot: read the setting, apply
  export async function setDebugLogging(debug: boolean): Promise<void>                     // persist + apply (the route's body)
  ```

- [ ] **Step 1: The spike — does the rotation transport work under Bun, and compiled?**

Install it in a scratch dir outside the repo (`mkdir -p /tmp/lfr && cd /tmp/lfr && bun init -y && bun add @loglayer/transport-log-file-rotation@3.3.0 loglayer@9.4.0`), write:

```ts
// /tmp/lfr/spike.ts
import { LogFileRotationTransport } from "@loglayer/transport-log-file-rotation";
import { LogLayer } from "loglayer";
import { readdirSync, statSync } from "node:fs";
const t = new LogFileRotationTransport({ id: "file", filename: "./out/server.log", size: "200k", maxLogs: 1 });
const log = new LogLayer({ transport: t });
for (let i = 0; i < 6000; i++) log.info(`line ${i} ${"x".repeat(60)}`);   // ≈ 450 KB → must rotate twice
await new Promise((r) => setTimeout(r, 500));
for (const f of readdirSync("./out")) console.log(f, statSync(`./out/${f}`).size);
```

Run: `bun run spike.ts && bun build --compile spike.ts --outfile spike-bin && rm -rf out && ./spike-bin`
Expected for a PASS: both runs print exactly ONE file in `out/`, under 204 800 bytes, with no error and no `moment`/`fs` incompatibility warning. Anything else — an exception, two or more files left behind, a file over the cap, or the compiled binary failing to start — is a FAIL. Record the verdict and the output in this task's commit body.

- [ ] **Step 2: Write the failing tests (writer-agnostic)**

```ts
// apps/server/api/src/utils/__tests__/log-file.test.ts
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseServerLogLine, readServerLogTail, SERVER_LOG_CAP_BYTES } from "@/utils/log-file.js";

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("parseServerLogLine", () => {
  it("reads timestamp, level, message and keeps the rest as data", () => {
    expect(parseServerLogLine('{"timestamp":"2026-09-12T10:00:00.000Z","level":"info","message":"hi","context":{"requestId":"r1"}}')).toEqual({
      ts: "2026-09-12T10:00:00.000Z", level: "info", message: "hi", data: { context: { requestId: "r1" } },
    });
  });
  it("returns a non-JSON line as raw", () => {
    expect(parseServerLogLine("half a li")).toEqual({ ts: "", level: "raw", message: "half a li" });
  });
});

describe("readServerLogTail", () => {
  it("returns the last N lines oldest first, and the file size", async () => {
    const dir = mkdtempSync(join(tmpdir(), "subshell-log-")); made.push(dir);
    const path = join(dir, "server.log");
    writeFileSync(path, [1, 2, 3, 4, 5].map((i) => JSON.stringify({ timestamp: `t${i}`, level: "info", message: `m${i}` })).join("\n") + "\n");
    const r = await readServerLogTail(path, 2);
    expect(r.lines.map((l) => l.message)).toEqual(["m4", "m5"]);
    expect(r.bytes).toBeGreaterThan(0);
  });
  it("answers empty for a missing file", async () => {
    expect(await readServerLogTail("/nonexistent/server.log", 10)).toEqual({ lines: [], bytes: 0 });
  });
  it("the cap is 200 KB", () => {
    expect(SERVER_LOG_CAP_BYTES).toBe(204_800);
  });
});
```

```ts
// apps/server/api/src/services/__tests__/logging-preference.test.ts
import { describe, expect, it } from "bun:test";
import { applyDebugLogging, debugLoggingState } from "@/services/logging-preference.js";

describe("debugLoggingState", () => {
  it("the environment forces on and is read-only; otherwise the stored setting; otherwise off", () => {
    expect(debugLoggingState({ SUBSHELL_DEBUG_LOGGING: "1" }, false)).toEqual({ debug: true, source: "process env" });
    expect(debugLoggingState({}, true)).toEqual({ debug: true, source: "setting" });
    expect(debugLoggingState({}, false)).toEqual({ debug: false, source: "setting" });
    expect(debugLoggingState({}, null)).toEqual({ debug: false, source: "default" });
    expect(debugLoggingState({ SUBSHELL_DEBUG_LOGGING: "0" }, null)).toEqual({ debug: false, source: "default" });
  });
});

describe("applyDebugLogging", () => {
  it("flips only the file transport's level", () => {
    const t = { level: "info" as const } as { level: string };
    applyDebugLogging(true, t);
    expect(t.level).toBe("debug");
    applyDebugLogging(false, t);
    expect(t.level).toBe("info");
  });
});
```

Run: `cd apps/server/api && bun test src/utils/__tests__/log-file.test.ts src/services/__tests__/logging-preference.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the reader, the path, and the writer (per the spike's verdict)**

`constants.ts`: delete `BACKEND_LOG_LEVEL` (line 374; nothing reads it). Add:
```ts
/** Forces debug logging on (debug level + HTTP request lines into the log file) and makes the setting read-only. `1`/`true` only. */
export const SUBSHELL_DEBUG_LOGGING = env.get("SUBSHELL_DEBUG_LOGGING").default("false").asBool();
```

`commands/status.ts`: `paths` gains `serverLog: string` (doc: "the server's own log file, one 200 KB file replaced when full"); value `join(SUBSHELL_SERVER_DATA_DIR, "logs", "server.log")`. The desktop reset parses the four it knows and ignores extras (verify `reset.rs::parse_delete_plan` reads keys by name, not by count); `serverLog` lives inside `dataDir`, so the data-dir delete covers it.

`utils/log-file.ts` — the reader half is the same on both branches:
```ts
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { LogLevelType } from "loglayer";
import { SUBSHELL_SERVER_DATA_DIR } from "@/constants.js";

/** Size at which the file is replaced (spec § 3.4). */
export const SERVER_LOG_CAP_BYTES = 204_800;

/** `<dataDir>/logs/server.log` — one file, every platform. */
export function serverLogPath(): string {
  return join(SUBSHELL_SERVER_DATA_DIR, "logs", "server.log");
}

/** One parsed line of the file. */
export interface ServerLogLine {
  ts: string;
  level: string;
  message: string;
  /** Everything else the line carried (context, metadata, err). */
  data?: unknown;
}

/** JSON line → fields; a non-JSON line (a partial write at the cap) comes back as `raw`. */
export function parseServerLogLine(line: string): ServerLogLine {
  try {
    const v = JSON.parse(line) as Record<string, unknown>;
    const { timestamp, level, message, ...rest } = v;
    return {
      ts: typeof timestamp === "string" ? timestamp : "",
      level: typeof level === "string" ? level : "raw",
      message: typeof message === "string" ? message : line,
      ...(Object.keys(rest).length > 0 ? { data: rest } : {}),
    };
  } catch {
    return { ts: "", level: "raw", message: line };
  }
}

/** The last `lines` lines of the file (≤ 200 KB by construction, so a whole read is fine), oldest first. */
export async function readServerLogTail(path: string, lines: number): Promise<{ lines: ServerLogLine[]; bytes: number }> {
  if (!existsSync(path)) return { lines: [], bytes: 0 };
  const [text, st] = await Promise.all([readFile(path, "utf8"), stat(path)]);
  const all = text.split("\n").filter((l) => l.length > 0);
  return { lines: all.slice(-Math.max(0, lines)).map(parseServerLogLine), bytes: st.size };
}

/** What the debug toggle touches on the writer. */
export interface LevelledTransport {
  level: LogLevelType;
}
```

**Writer, if the spike PASSED** — `bun add @loglayer/transport-log-file-rotation@3.3.0` (then `bun run syncpack:format && bun install`), and in `log-file.ts`:
```ts
import { LogFileRotationTransport } from "@loglayer/transport-log-file-rotation";
/** The file writer: JSON lines, rotated at the cap, the rotated file deleted at once (`maxLogs: 1` = replaced when full). */
export const serverLogFile: LogFileRotationTransport = new LogFileRotationTransport({
  id: "file",
  filename: serverLogPath(),
  size: "200k",
  maxLogs: 1,
  level: "info",
});
```
Ensure the directory exists 0700 before the transport opens it (`mkdirSync(dirname(serverLogPath()), { recursive: true, mode: 0o700 })` at module top, guarded by `IS_TEST` so tests never touch the real data dir) and `chmodSync` the file 0600 after the first write if the transport does not honour a mode (check on macOS with `ls -l`).

**Writer, if the spike FAILED** — no new dependency; in `log-file.ts`:
```ts
import { appendFileSync, chmodSync, mkdirSync, statSync, truncateSync } from "node:fs";
import { dirname } from "node:path";
import { type LogLayerTransportParams, LoggerlessTransport } from "@loglayer/transport";

/**
 * A size-capped appender: one JSON line per log call; when the next line
 * would push the file past the cap, the file is truncated and started over
 * — "replaced when full", nothing kept anywhere else. Synchronous appends,
 * like the pane-log pipe: a log line lost to buffering at a crash is the
 * line that explains the crash.
 */
export class CappedFileTransport extends LoggerlessTransport implements LevelledTransport {
  constructor(private readonly path: string, private readonly capBytes: number, level: LogLevelType = "info") {
    super({ id: "file", level });
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  }
  shipToLogger({ logLevel, messages, data, hasData }: LogLayerTransportParams): unknown[] {
    const message = messages.map((m) => (typeof m === "string" ? m : JSON.stringify(m))).join(" ");
    const line = `${JSON.stringify({ timestamp: new Date().toISOString(), level: logLevel, message, ...(hasData && data ? (data as object) : {}) })}\n`;
    let size = 0;
    try {
      size = statSync(this.path).size;
    } catch {
      // no file yet
    }
    if (size + line.length > this.capBytes) truncateSync(this.path, 0);
    appendFileSync(this.path, line, { mode: 0o600 });
    if (size === 0) chmodSync(this.path, 0o600);
    return messages;
  }
}
export const serverLogFile: CappedFileTransport = new CappedFileTransport(serverLogPath(), SERVER_LOG_CAP_BYTES);
```
and add a test: 4 000 lines of ~120 bytes through `shipToLogger` leave ONE file under 204 800 bytes whose first line is a complete JSON object. `@loglayer/transport@3.3.0` becomes a direct dependency in this branch (`bun add @loglayer/transport@3.3.0`).

`services/logging-preference.ts`:
```ts
import { SUBSHELL_DEBUG_LOGGING } from "@/constants.js";
import { db } from "@/db/index.js";
import { SettingsRepository } from "@/db/repositories/settings.repository.js";
import { type LevelledTransport, serverLogFile } from "@/utils/log-file.js";

/** The `settings` row; absent = off. */
export const DEBUG_LOGGING_KEY = "debug_logging";
export type DebugLoggingSource = "process env" | "setting" | "default";

/** Env forces on (read-only); else the stored boolean; else off. Pure. */
export function debugLoggingState(env: NodeJS.ProcessEnv = process.env, stored: boolean | null = null): { debug: boolean; source: DebugLoggingSource } {
  const forced = env.SUBSHELL_DEBUG_LOGGING === "1" || env.SUBSHELL_DEBUG_LOGGING === "true";
  if (forced) return { debug: true, source: "process env" };
  if (stored === null) return { debug: false, source: "default" };
  return { debug: stored, source: "setting" };
}

/** Flip the file transport's level; stdout is never touched (spec § 3.4). */
export function applyDebugLogging(debug: boolean, transport: LevelledTransport = serverLogFile): void {
  transport.level = debug ? "debug" : "info";
}

let stored: boolean | null = null;

/** Boot: read the setting once the database is open, and apply. Env wins. */
export async function loadAndApplyDebugLogging(): Promise<void> {
  const row = await new SettingsRepository(db).get(DEBUG_LOGGING_KEY);
  stored = typeof row === "boolean" ? row : row === null || row === undefined ? null : row === "true" || row === "1";
  applyDebugLogging(debugLoggingState(process.env, stored).debug);
}

/** The route's body: persist, remember, apply. Callers have already refused the env-forced case. */
export async function setDebugLogging(debug: boolean): Promise<void> {
  await new SettingsRepository(db).set(DEBUG_LOGGING_KEY, debug);
  stored = debug;
  applyDebugLogging(debug);
}

/** For the deployment view. */
export function currentDebugLogging(): { debug: boolean; source: DebugLoggingSource } {
  return debugLoggingState(process.env, stored);
}
```
(`SettingsRepository.get` — use the read method the repository exposes; `set(key, value)` exists at line 18.) `SUBSHELL_DEBUG_LOGGING` from constants is unused here on purpose: the pure function takes `env` so it can be tested; export it anyway for `status`.

`utils/logger.ts`:
```ts
import { serverLogFile } from "@/utils/log-file.js";
const transport = getSimplePrettyTerminal({ runtime: "node", id: "pretty", level: "info" });   // stdout stays quiet in debug mode
export const logger = new LogLayer({
  transport: [transport, bannerTransport, serverLogFile],
  groups: { [BANNER_GROUP]: { transports: [BANNER_GROUP] } },
  // Ordinary logs go to stdout AND the file — never the banner.
  ungroupedBehavior: ["pretty", "file"],
  …
```
If `getSimplePrettyTerminal` has no `level` option, wrap it: LogLayer transports carry `level` on `LoggerlessTransport`/`BaseTransport`; set `transport.level = "info"` after construction and verify a `logger.debug(…)` does not reach stdout.

`plugins/context.plugin.ts`:
```ts
    elysiaLogLayer({
      instance: logger,
      requestId: () => nanoid(12),
      // HTTP request/response lines at DEBUG: they reach the log file only in
      // debug mode and never reach the manager's log (spec 2026-09-12 § 3.4).
      // The SPA's own polling is ignored, or a debug session fills the cap
      // with itself.
      autoLogging: {
        logLevel: "debug",
        ignore: ["/api/admin/status", "/api/admin/server", "/api/admin/server/logs", "/api/setup/status", "/api/settings/public", /^\/ws(\/|$)/, /^\/api\/subshells\/live/],
      },
    }),
```

`index.ts`: after `runMigrations()`/auth migrations and before `startServer`, `await loadAndApplyDebugLogging();`.

`server-deployment.ts`: replace Task 4's stubs — `paths: status.paths` (it now carries `serverLog`), `logging: { ...(deps.debugLogging ?? currentDebugLogging)(), file: status.paths.serverLog, capBytes: SERVER_LOG_CAP_BYTES }`.

- [ ] **Step 4: Run the tests, then boot once and look at the file**

Run: `cd apps/server/api && bun test src/utils/__tests__/log-file.test.ts src/services/__tests__/logging-preference.test.ts && bun test`
Then `bun run start` from the repo root, hit a few routes, and: `ls -l "$(bun -e 'console.log(process.env.SUBSHELL_SERVER_DATA_DIR ?? "")')"/logs/server.log` (or the default data dir) — mode `-rw-------`, JSON lines, no `incoming request` lines. Set `SUBSHELL_DEBUG_LOGGING=1`, restart, hit `/api/nodes`: the file now has `incoming request`/`request completed` lines at `debug`, and stdout does not.
Expected: PASS; both observations true.

- [ ] **Step 5: Commit**

```bash
git add apps/server/api/package.json bun.lock apps/server/api/src/constants.ts apps/server/api/src/commands/status.ts apps/server/api/src/utils/log-file.ts apps/server/api/src/utils/logger.ts apps/server/api/src/services/logging-preference.ts apps/server/api/src/plugins/context.plugin.ts apps/server/api/src/index.ts apps/server/api/src/services/server-deployment.ts apps/server/api/src/utils/__tests__/log-file.test.ts apps/server/api/src/services/__tests__/logging-preference.test.ts
git commit -m "feat(server): one 200 KB log file, replaced when full; debug logging off by default, HTTP lines only in debug"
```
Body: the spike's verdict and the exact output, and which writer shipped.

---

### Task 6: Socket teardown helpers and `performRestart`

The server has no graceful shutdown today (index.ts has only `unhandledRejection`/`uncaughtException`). Add just what a self-restart needs.

**Files:**
- Modify: `apps/server/api/src/ws/viewers.ts` (add `closeAllViewers`)
- Modify: `apps/server/api/src/services/nodes/node-registry.ts` (add `disconnectAllNodes`)
- Create: `apps/server/api/src/services/server-restart.ts`
- Test: `apps/server/api/src/services/__tests__/server-restart.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // viewers.ts
  export function closeAllViewers(code: number, reason: string): number   // returns how many were closed
  // node-registry.ts
  export function disconnectAllNodes(code: number, reason: string): number
  // server-restart.ts
  export const WS_CLOSE_SERVICE_RESTART = 1012;
  export interface RestartDeps { delayMs?: number; closeViewers?: (code: number, reason: string) => number; closeNodes?: (code: number, reason: string) => number; exit?: (code: number) => void; setTimer?: typeof setTimeout }
  export function performRestart(deps?: RestartDeps): void
  ```

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/api/src/services/__tests__/server-restart.test.ts
import { describe, expect, it } from "bun:test";
import { performRestart, WS_CLOSE_SERVICE_RESTART } from "@/services/server-restart.js";

describe("performRestart", () => {
  it("after the delay closes viewers and nodes with 1012 and exits 0, in that order", () => {
    const calls: string[] = [];
    let scheduled: (() => void) | undefined;
    performRestart({
      delayMs: 250,
      setTimer: ((fn: () => void, ms: number) => {
        expect(ms).toBe(250);
        scheduled = fn;
        return 0 as never;
      }) as never,
      closeViewers: (code, reason) => {
        calls.push(`viewers:${code}:${reason}`);
        return 2;
      },
      closeNodes: (code, reason) => {
        calls.push(`nodes:${code}:${reason}`);
        return 1;
      },
      exit: (code) => calls.push(`exit:${code}`),
    });
    expect(calls).toEqual([]); // nothing before the timer fires — the 202 must flush first
    scheduled?.();
    expect(calls).toEqual([
      `viewers:${WS_CLOSE_SERVICE_RESTART}:server restart`,
      `nodes:${WS_CLOSE_SERVICE_RESTART}:server restart`,
      "exit:0",
    ]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/server/api && bun test src/services/__tests__/server-restart.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the two helpers and the module**

In `ws/viewers.ts`, next to `detachViewer` (line 396), using whatever map/set holds the live viewer sockets there (the registry `registerViewer` writes into):

```ts
/**
 * Close every browser terminal socket with one code. Used by the self-restart
 * (1012 Service Restart, below the 4000 line so `use-subshell-ws.ts` retries).
 * @returns how many sockets were closed
 */
export function closeAllViewers(code: number, reason: string): number {
  let n = 0;
  for (const ws of allViewerSockets()) {
    try {
      ws.close(code, reason);
      n++;
    } catch {
      // a socket already gone is the outcome we want
    }
  }
  return n;
}
```

where `allViewerSockets()` is a small private iterator over the existing viewer registry (add it beside the registry if no accessor exists). In `node-registry.ts`, after `disconnectNode`:

```ts
/** Close every live node socket with one code; each agent's backoff loop reconnects. */
export function disconnectAllNodes(code: number, reason: string): number {
  let n = 0;
  for (const id of listOnline()) if (disconnectNode(id, code, reason)) n++;
  return n;
}
```

Then:

```ts
// apps/server/api/src/services/server-restart.ts
import { disconnectAllNodes } from "@/services/nodes/node-registry.js";
import { closeAllViewers } from "@/ws/viewers.js";

/** WebSocket close code "Service Restart" (RFC 6455 §7.4.1 registry). Below 4000: the SPA retries it. */
export const WS_CLOSE_SERVICE_RESTART = 1012;

/** Injectable seams so a test never exits the test process. */
export interface RestartDeps {
  /** How long after the call the shutdown begins; the route's 202 must flush first (default 250 ms). */
  delayMs?: number;
  closeViewers?: (code: number, reason: string) => number;
  closeNodes?: (code: number, reason: string) => number;
  exit?: (code: number) => void;
  setTimer?: typeof setTimeout;
}

/**
 * Restart by exiting: the service manager (`Restart=always` / `KeepAlive`)
 * brings the process back. Only called after `isSupervised` said so. Closes
 * the browser and node sockets first so both sides see a clean 1012 rather
 * than a dropped connection, then exits 0. SQLite needs no close: bun:sqlite
 * releases on exit and the WAL is durable.
 */
export function performRestart(deps: RestartDeps = {}): void {
  const timer = deps.setTimer ?? setTimeout;
  const closeViewers = deps.closeViewers ?? closeAllViewers;
  const closeNodes = deps.closeNodes ?? disconnectAllNodes;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  timer(() => {
    closeViewers(WS_CLOSE_SERVICE_RESTART, "server restart");
    closeNodes(WS_CLOSE_SERVICE_RESTART, "server restart");
    exit(0);
  }, deps.delayMs ?? 250);
}
```

- [ ] **Step 4: Run the test**

Run: `cd apps/server/api && bun test src/services/__tests__/server-restart.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/api/src/ws/viewers.ts apps/server/api/src/services/nodes/node-registry.ts apps/server/api/src/services/server-restart.ts apps/server/api/src/services/__tests__/server-restart.test.ts
git commit -m "feat(server): performRestart — close sockets with 1012 and exit for the manager to respawn"
```

---

### Task 7: `GET /api/admin/server`

**Files:**
- Create: `apps/server/api/src/api/admin-server/get-server.route.ts`
- Create: `apps/server/api/src/api/admin-server/schemas.ts` (shared `DeploymentViewSchema`)
- Create: `apps/server/api/src/api/admin-server/index.ts`
- Modify: `apps/server/api/src/api/routes.ts:72`
- Test: `apps/server/api/src/api/admin-server/__tests__/get-server.route.test.ts`

**Interfaces:**
- Consumes: `collectDeployment` (Task 4), `requireAdmin`.
- Produces: `export const adminServerRoutes: Elysia` mounted at `/api/admin/server`; `DeploymentViewSchema` reused by Task 8.

- [ ] **Step 1: Write the failing test**

Model on `admin-status-route.test.ts` (imports, `setupAuthTables`, `signIn`, `authedRequest`, `deleteUserByEmailOrId`, an admin and a non-admin user, a subshell bearer key):

```ts
// apps/server/api/src/api/admin-server/__tests__/get-server.route.test.ts
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { adminServerRoutes } from "@/api/admin-server/index.js";
import { db } from "@/db/index.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { issueSubshellToken } from "@/services/subshell-tokens.js";
import { authedRequest, deleteUserByEmailOrId, setupAuthTables, signIn } from "../../__tests__/helpers/auth-tables.js";

const app = new Elysia().use(errorHandlerPlugin).use(adminServerRoutes);

/** Every top-level key, asserted whole so a field cannot be added without a decision (the settings/instance pattern). */
const VIEW_KEYS = [
  "configEnv", "settings", "restartRequired", "authSecret", "paths", "service", "restart",
  "logging", "tmuxPath", "mcp", "mcpError", "platform", "generatedAt",
].sort();

describe("GET /api/admin/server", () => {
  let adminId: string;
  let userId: string;
  let adminCookie: string;
  let userCookie: string;
  let bearer: string;
  const subshells: string[] = [];
  beforeAll(async () => {
    await setupAuthTables();
    const users = new UsersRepository(db);
    const adminEmail = `srv-admin-${crypto.randomUUID()}@subshell.local`;
    const userEmail = `srv-user-${crypto.randomUUID()}@subshell.local`;
    adminId = await users.createUser({ email: adminEmail, passwordHash: await hashPassword("srv-admin-pass-1"), role: "admin" });
    userId = await users.createUser({ email: userEmail, passwordHash: await hashPassword("srv-user-pass-1"), role: "user" });
    adminCookie = await signIn(adminEmail, "srv-admin-pass-1");
    userCookie = await signIn(userEmail, "srv-user-pass-1");
    const sid = crypto.randomUUID();
    subshells.push(sid);
    await new SubshellsRepository(db).create({ id: sid, userId: adminId, profileId: "p", harnessId: "claude-code", name: "t", workingDir: "/tmp", tmuxSocket: null });
    bearer = await issueSubshellToken(sid, adminId);
  });
  afterAll(async () => {
    for (const id of subshells) await new SubshellsRepository(db).delete(id);
    await deleteUserByEmailOrId(adminId);
    await deleteUserByEmailOrId(userId);
  });

  it("answers an admin cookie with the whole view and nothing more", async () => {
    const res = await app.fetch(authedRequest("/api/admin/server", adminCookie));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(VIEW_KEYS);
    const settings = body.settings as Record<string, { saved: string; running: string; source: string }>;
    expect(Object.keys(settings)).toEqual(["SERVER_PORT", "HOST", "APP_BASE_URL", "DATABASE_PATH", "TRUSTED_ORIGINS"]);
    expect(["process env", "config.env", "default"]).toContain(settings.HOST?.source);
    expect(JSON.stringify(body)).not.toContain("BETTER_AUTH_SECRET=");
  });
  it("refuses a non-admin cookie and any bearer key with 403, and anonymous with 401", async () => {
    expect((await app.fetch(authedRequest("/api/admin/server", userCookie))).status).toBe(403);
    expect((await app.fetch(new Request("http://localhost:3080/api/admin/server", { headers: { authorization: `Bearer ${bearer}` } }))).status).toBe(403);
    expect((await app.fetch(new Request("http://localhost:3080/api/admin/server"))).status).toBe(401);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/server/api && bun test src/api/admin-server/__tests__/get-server.route.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement schemas, route, index, registration**

```ts
// apps/server/api/src/api/admin-server/schemas.ts
import { t } from "elysia";

const SettingSourceSchema = t.Union([t.Literal("process env"), t.Literal("config.env"), t.Literal("default")], {
  description: "Which layer the saved value comes from; `process env` means config.env cannot change it",
});

const DeploymentSettingSchema = t.Object({
  saved: t.String({ description: "What config.env (or the built-in default) says now" }),
  source: SettingSourceSchema,
  running: t.String({ description: "What THIS process booted with" }),
  problems: t.Optional(
    t.Array(
      t.Object({
        entry: t.String({ description: "The offending entry" }),
        reason: t.String({ description: "Why it is a problem" }),
      }),
      { description: "Diagnostics the CLI's status attaches to the saved value" },
    ),
  ),
});

/** `GET /api/admin/server` (spec § 3.1). */
export const DeploymentViewSchema = t.Object({
  configEnv: t.Object({
    path: t.String({ description: "Resolved config.env path" }),
    exists: t.Boolean({ description: "Whether the file is there" }),
  }),
  settings: t.Object(
    {
      SERVER_PORT: DeploymentSettingSchema,
      HOST: DeploymentSettingSchema,
      APP_BASE_URL: DeploymentSettingSchema,
      DATABASE_PATH: DeploymentSettingSchema,
      TRUSTED_ORIGINS: DeploymentSettingSchema,
    },
    { description: "The configure-owned keys, saved versus running" },
  ),
  restartRequired: t.Boolean({ description: "True when any saved value differs from the running one" }),
  authSecret: t.Object({
    state: t.Union([t.Literal("set"), t.Literal("missing")], { description: "Presence only, never the value" }),
    source: SettingSourceSchema,
  }),
  paths: t.Object({
    dataDir: t.String({ description: "Instance data directory" }),
    database: t.String({ description: "SQLite file" }),
    logsDir: t.String({ description: "Pane logs directory" }),
    nodeArtifacts: t.String({ description: "Published node binaries directory" }),
    serverLog: t.String({ description: "The server's own log file (200 KB cap, replaced when full)" }),
  }),
  service: t.Object({
    manager: t.Nullable(t.Union([t.Literal("launchd"), t.Literal("systemd")]), { description: "The per-user service manager on this platform, or null" }),
    installed: t.Boolean({ description: "Whether a unit/plist exists on disk" }),
    definitionPath: t.Nullable(t.String(), { description: "Where that definition lives, or would" }),
    state: t.String({ description: "The manager's word for the process state, verbatim" }),
    pid: t.Nullable(t.Number(), { description: "The manager's main pid" }),
    enabled: t.Nullable(t.Boolean(), { description: "Whether it starts at login" }),
    paneSafety: t.Union([t.Literal("keeps"), t.Literal("kills"), t.Literal("unknown")], { description: "Whether stopping keeps live panes" }),
    logPath: t.Nullable(t.String(), { description: "The launchd log file; null under systemd" }),
    logHint: t.Nullable(t.String(), { description: "The journal command when logPath is null" }),
    supervised: t.Boolean({ description: "Whether this process is the one the manager started (so exiting is a restart)" }),
  }),
  restart: t.Object({
    available: t.Boolean({ description: "Whether POST /api/admin/server/restart would work" }),
    reason: t.Nullable(t.String(), { description: "Why not, when it would not" }),
  }),
  logging: t.Object({
    debug: t.Boolean({ description: "Whether debug logging (and with it HTTP request logging) is on" }),
    source: t.Union([t.Literal("process env"), t.Literal("setting"), t.Literal("default")], { description: "Where the effective value comes from; process env means the switch is read-only" }),
    file: t.String({ description: "The log file the toggle governs" }),
    capBytes: t.Number({ description: "Size at which the file is replaced" }),
  }),
  tmuxPath: t.Nullable(t.String(), { description: "Absolute path to tmux, or null" }),
  mcp: t.Nullable(
    t.Object({
      command: t.String({ description: "MCP entrypoint command" }),
      args: t.Array(t.String({ description: "Argument" }), { description: "MCP entrypoint args" }),
      source: t.String({ description: "Which rung resolved it" }),
    }),
    { description: "The resolved subshell mcp entrypoint" },
  ),
  mcpError: t.Nullable(t.String(), { description: "Why the MCP entrypoint did not resolve" }),
  platform: t.String({ description: "process.platform" }),
  generatedAt: t.String({ description: "ISO 8601 snapshot time" }),
});
```

```ts
// apps/server/api/src/api/admin-server/get-server.route.ts
import { Elysia } from "elysia";
import { DeploymentViewSchema } from "@/api/admin-server/schemas.js";
import { requireAdmin } from "@/api/auth-guard.js";
import { collectDeployment } from "@/services/server-deployment.js";

/** `GET /api/admin/server` — how this server is deployed. Cookie-admin only. */
export const getServerRoute = new Elysia().use(requireAdmin).get("/", () => collectDeployment(), {
  response: DeploymentViewSchema,
  detail: {
    operationId: "getServerDeployment",
    tags: ["admin"],
    description:
      "The server's own view of its deployment: config.env values saved versus running, the service manager's state, data locations, and whether a self-restart is possible. Cookie-admin only; bearer keys are refused. No secret in any form.",
  },
});
```

```ts
// apps/server/api/src/api/admin-server/index.ts
import { Elysia } from "elysia";
import { getServerRoute } from "@/api/admin-server/get-server.route.js";

/** `/api/admin/server` — one Elysia instance per endpoint (the channels-directory convention). */
export const adminServerRoutes = new Elysia({ prefix: "/api/admin/server" }).use(getServerRoute);
```

In `routes.ts:72`: `const adminRoutes = new Elysia().use(adminStatusRoutes).use(adminServerRoutes);` with the import added.

- [ ] **Step 4: Run the test, then `turbo build`**

Run: `cd apps/server/api && bun test src/api/admin-server/ && cd ../../.. && bunx turbo build --filter=@internal/server --filter=@internal/backend-client`
Expected: PASS; build clean (type-depth budget still holds — if TS2589 appears, the fix is a second `adminRoutes2` group in routes.ts, mirroring the existing comment at `routes.ts:68-71`).

- [ ] **Step 5: Commit**

```bash
git add apps/server/api/src/api/admin-server apps/server/api/src/api/routes.ts
git commit -m "feat(server): GET /api/admin/server — the deployment view"
```

---

### Task 8: `PATCH /api/admin/server/config`

**Files:**
- Create: `apps/server/api/src/api/admin-server/patch-config.route.ts`
- Modify: `apps/server/api/src/api/admin-server/index.ts`
- Test: `apps/server/api/src/api/admin-server/__tests__/patch-config.route.test.ts`

**Interfaces:**
- Consumes: `applyConfig` (Task 2), `collectDeployment`, `settingSource`, `audit`, `apiErrorBody`, `apiModels`, `BackendErrorCodes.CONFIG_INVALID` / `CONFIG_KEY_FROM_ENV` (Task 3), `serverConfigDir()`.
- Produces: response `{ ...DeploymentView, warnings: string[] }`.

- [ ] **Step 1: Write the failing test**

Same fixture shape as Task 7 (admin cookie). The test points the server at a temp config dir with `process.env.SUBSHELL_SERVER_CONFIG_DIR` set in `beforeAll` (before the first request) and restores it after.

```ts
// apps/server/api/src/api/admin-server/__tests__/patch-config.route.test.ts
// … same imports/fixture as get-server.route.test.ts plus:
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditRepository } from "@/db/repositories/audit.repository.js";

describe("PATCH /api/admin/server/config", () => {
  let dir: string;
  const previousDir = process.env.SUBSHELL_SERVER_CONFIG_DIR;
  beforeAll(async () => {
    // … users/cookies as in Task 7 …
    dir = mkdtempSync(join(tmpdir(), "subshell-patch-"));
    writeFileSync(join(dir, "config.env"), "BETTER_AUTH_SECRET=s3cret\nSERVER_PORT=3080\nHOST=0.0.0.0\n");
    process.env.SUBSHELL_SERVER_CONFIG_DIR = dir;
  });
  afterAll(async () => {
    if (previousDir === undefined) delete process.env.SUBSHELL_SERVER_CONFIG_DIR;
    else process.env.SUBSHELL_SERVER_CONFIG_DIR = previousDir;
    rmSync(dir, { recursive: true, force: true });
    // … user cleanup …
  });

  it("writes the file exactly as the CLI would, answers the view plus warnings, and audits the change without the secret", async () => {
    const res = await app.fetch(authedRequest("/api/admin/server/config", adminCookie, { method: "PATCH", body: JSON.stringify({ port: 3090, trustedOrigins: ["http://10.0.0.5:3090"] }) }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { settings: { SERVER_PORT: { saved: string } }; warnings: string[]; restartRequired: boolean };
    expect(body.settings.SERVER_PORT.saved).toBe("3090");
    expect(body.restartRequired).toBe(true);
    const text = readFileSync(join(dir, "config.env"), "utf8");
    expect(text).toContain("BETTER_AUTH_SECRET=s3cret");
    expect(text).toContain("SERVER_PORT=3090");
    expect(text).toContain("TRUSTED_ORIGINS=http://10.0.0.5:3090");
    const events = await new AuditRepository(db).list({ limit: 5 });
    const ev = events.find((e) => e.action === "server.config.update");
    expect(ev).toBeDefined();
    expect(ev?.metadataJson ?? "").not.toContain("s3cret");
    expect(ev?.metadataJson ?? "").toContain("SERVER_PORT");
  });

  it("400 CONFIG_INVALID names the field and the CLI's reason, writing nothing", async () => {
    const before = readFileSync(join(dir, "config.env"), "utf8");
    const res = await app.fetch(authedRequest("/api/admin/server/config", adminCookie, { method: "PATCH", body: JSON.stringify({ baseUrl: "ftp://nope" }) }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("CONFIG_INVALID");
    expect(body.message).toContain("APP_BASE_URL");
    expect(readFileSync(join(dir, "config.env"), "utf8")).toBe(before);
  });

  it("409 CONFIG_KEY_FROM_ENV when the key is set in the process environment", async () => {
    process.env.HOST_PATCH_TEST_MARKER = "1";
    const prev = process.env.HOST;
    process.env.HOST = "127.0.0.1";
    try {
      const res = await app.fetch(authedRequest("/api/admin/server/config", adminCookie, { method: "PATCH", body: JSON.stringify({ host: "0.0.0.0" }) }));
      expect(res.status).toBe(409);
      const body = (await res.json()) as { code: string; message: string };
      expect(body.code).toBe("CONFIG_KEY_FROM_ENV");
      expect(body.message).toContain("HOST");
    } finally {
      if (prev === undefined) delete process.env.HOST;
      else process.env.HOST = prev;
      delete process.env.HOST_PATCH_TEST_MARKER;
    }
  });

  it("400 on an empty body", async () => {
    const res = await app.fetch(authedRequest("/api/admin/server/config", adminCookie, { method: "PATCH", body: "{}" }));
    expect(res.status).toBe(400);
  });
});
```

(`AuditRepository.list` — use whatever the repository's newest-first read is called; `audit.route.ts:26` shows the call the route makes.)

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/server/api && bun test src/api/admin-server/__tests__/patch-config.route.test.ts`
Expected: FAIL — 404 (route absent).

- [ ] **Step 3: Implement**

```ts
// apps/server/api/src/api/admin-server/patch-config.route.ts
import { BackendErrorCodes } from "@internal/backend-errors";
import { Elysia, t } from "elysia";
import { DeploymentViewSchema } from "@/api/admin-server/schemas.js";
import { requireAdmin } from "@/api/auth-guard.js";
import { applyConfig } from "@/commands/configure.js";
import { configEnvAppliedKeys, serverConfigDir } from "@/config-env.js";
import { apiErrorBody } from "@/lib/api-error.js";
import { apiModels } from "@/schema/index.js";
import { audit } from "@/services/audit.js";
import { collectDeployment, type DeploymentSettingKey, settingSource } from "@/services/server-deployment.js";

const ConfigPatchSchema = t.Object(
  {
    port: t.Optional(t.Integer({ minimum: 1, maximum: 65535, description: "SERVER_PORT" })),
    host: t.Optional(t.String({ minLength: 1, description: "HOST (bind address)" })),
    baseUrl: t.Optional(t.String({ minLength: 1, description: "APP_BASE_URL" })),
    trustedOrigins: t.Optional(
      t.Array(t.String({ description: "One origin, scheme + host [+ port]" }), {
        description: "TRUSTED_ORIGINS; an empty array clears the key",
      }),
    ),
  },
  { description: "Fields to change; absent fields keep their stored value. DATABASE_PATH is CLI-only.", minProperties: 1 },
);

const ConfigPatchResponseSchema = t.Object({
  ...DeploymentViewSchema.properties,
  warnings: t.Array(t.String({ description: "One advisory sentence" }), {
    description: "The CLI's advisory warnings for the values written (LAN bind with loopback base URL; base URL port ≠ bind port)",
  }),
});

/** Body field → config.env key, for the env-override refusal. */
const KEY_FOR_FIELD: Record<"port" | "host" | "baseUrl" | "trustedOrigins", DeploymentSettingKey> = {
  port: "SERVER_PORT",
  host: "HOST",
  baseUrl: "APP_BASE_URL",
  trustedOrigins: "TRUSTED_ORIGINS",
};

/**
 * `PATCH /api/admin/server/config` — rewrite config.env through the CLI's own
 * writer (spec § 3.2). Refuses a key the process environment sets (409): a
 * file write would be masked at the next boot and this route would report a
 * success that never takes effect. Audits `server.config.update` with the
 * changed keys; the values are addresses, never secrets, and the auth secret
 * is never among the keys this route can touch.
 */
export const patchConfigRoute = new Elysia()
  .use(requireAdmin)
  .use(apiModels)
  .patch(
    "/config",
    async ({ body, user, status }) => {
      if (Object.keys(body).length === 0) {
        return status(400, apiErrorBody({ code: BackendErrorCodes.BAD_REQUEST, message: "Nothing to change" }));
      }
      for (const field of Object.keys(body) as (keyof typeof KEY_FOR_FIELD)[]) {
        const key = KEY_FOR_FIELD[field];
        if (settingSource(key, process.env, configEnvAppliedKeys()) === "process env") {
          return status(
            409,
            apiErrorBody({
              code: BackendErrorCodes.CONFIG_KEY_FROM_ENV,
              message: `${key} is set in the server's environment, so config.env cannot change it; change ${key} where the server is started`,
            }),
          );
        }
      }
      const result = applyConfig(
        {
          ...(body.port !== undefined ? { port: String(body.port) } : {}),
          ...(body.host !== undefined ? { host: body.host } : {}),
          ...(body.baseUrl !== undefined ? { baseUrl: body.baseUrl } : {}),
          ...(body.trustedOrigins !== undefined ? { trustedOrigins: body.trustedOrigins.join(",") } : {}),
        },
        serverConfigDir(),
      );
      if (!result.ok) {
        return status(
          400,
          apiErrorBody({ code: BackendErrorCodes.CONFIG_INVALID, message: `${result.key}: ${result.reason}` }),
        );
      }
      if (result.changed.length > 0) {
        await audit({
          actorUserId: user.id,
          action: "server.config.update",
          targetType: "server",
          targetId: "config.env",
          metadataJson: JSON.stringify({ changes: result.changed }),
        });
      }
      return { ...collectDeployment(), warnings: result.warnings };
    },
    {
      body: ConfigPatchSchema,
      response: { 200: ConfigPatchResponseSchema, 400: "ApiErrorResponse", 401: "ApiErrorResponse", 403: "ApiErrorResponse", 409: "ApiErrorResponse" },
      detail: {
        operationId: "updateServerConfig",
        tags: ["admin"],
        description:
          "Rewrite config.env (port, bind address, public base URL, trusted origins) through the CLI's own validated writer; the change applies at the next restart. Cookie-admin only.",
      },
    },
  );
```

Register in `index.ts`: `.use(patchConfigRoute)`.

- [ ] **Step 4: Run the tests, then `turbo build`**

Run: `cd apps/server/api && bun test src/api/admin-server/ && cd ../../.. && bunx turbo build --filter=@internal/server --filter=@internal/backend-client`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/api/src/api/admin-server
git commit -m "feat(server): PATCH /api/admin/server/config rewrites config.env through applyConfig"
```

---

### Task 9: `POST /api/admin/server/restart`, `GET /api/admin/server/logs`, `PUT /api/admin/server/logging`

**Files:**
- Create: `apps/server/api/src/api/admin-server/restart.route.ts`, `logs.route.ts`, `logging.route.ts`
- Modify: `apps/server/api/src/api/admin-server/index.ts`
- Test: `apps/server/api/src/api/admin-server/__tests__/restart.route.test.ts`, `logs.route.test.ts`, `logging.route.test.ts`

**Interfaces:**
- Consumes: `collectDeployment` (Task 4), `performRestart` (Task 6), `readServerLogTail`, `serverLogPath`, `SERVER_LOG_CAP_BYTES` (Task 5), `setDebugLogging`, `currentDebugLogging` (Task 5), `audit`, `BackendErrorCodes.LOGGING_FROM_ENV`.
- Produces: `export const restartRoute`, `export const logsRoute`, `export const loggingRoute`; a test seam `export const restartSeams = { deployment: collectDeployment, perform: performRestart }`; `export const logsSeams = { path: serverLogPath }`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/server/api/src/api/admin-server/__tests__/restart.route.test.ts
// … admin fixture as in Task 7 …
import { restartSeams } from "@/api/admin-server/restart.route.js";
import type { DeploymentView } from "@/services/server-deployment.js";

function viewWith(over: { supervised: boolean; paneSafety: "keeps" | "kills" | "unknown" }): DeploymentView {
  const base = restartSeams.deployment();
  return {
    ...base,
    service: { ...base.service, supervised: over.supervised, paneSafety: over.paneSafety },
    restart: { available: over.supervised, reason: over.supervised ? null : "not supervised" },
  };
}

describe("POST /api/admin/server/restart", () => {
  const realDeployment = restartSeams.deployment;
  const realPerform = restartSeams.perform;
  let performed = 0;
  beforeEach(() => {
    performed = 0;
    restartSeams.perform = () => {
      performed++;
    };
  });
  afterEach(() => {
    restartSeams.deployment = realDeployment;
    restartSeams.perform = realPerform;
  });

  it("409 RESTART_UNAVAILABLE when not supervised, and nothing is scheduled", async () => {
    restartSeams.deployment = () => viewWith({ supervised: false, paneSafety: "keeps" });
    const res = await app.fetch(authedRequest("/api/admin/server/restart", adminCookie, { method: "POST", body: "{}" }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("RESTART_UNAVAILABLE");
    expect(performed).toBe(0);
  });
  it("409 RESTART_KILLS_PANES without force; 202 with force", async () => {
    restartSeams.deployment = () => viewWith({ supervised: true, paneSafety: "kills" });
    const refused = await app.fetch(authedRequest("/api/admin/server/restart", adminCookie, { method: "POST", body: "{}" }));
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { code: string }).code).toBe("RESTART_KILLS_PANES");
    const forced = await app.fetch(authedRequest("/api/admin/server/restart", adminCookie, { method: "POST", body: JSON.stringify({ force: true }) }));
    expect(forced.status).toBe(202);
    expect(performed).toBe(1);
  });
  it("202 when supervised and pane-safe, with resumeAt and an audit row", async () => {
    restartSeams.deployment = () => viewWith({ supervised: true, paneSafety: "keeps" });
    const res = await app.fetch(authedRequest("/api/admin/server/restart", adminCookie, { method: "POST", body: "{}" }));
    expect(res.status).toBe(202);
    const body = (await res.json()) as { restarting: boolean; resumeAt: string };
    expect(body.restarting).toBe(true);
    expect(body.resumeAt.startsWith("http")).toBe(true);
    expect(performed).toBe(1);
    const events = await new AuditRepository(db).list({ limit: 5 });
    expect(events.some((e) => e.action === "server.restart")).toBe(true);
  });
  it("bearer 403, non-admin 403", async () => {
    expect((await app.fetch(new Request("http://localhost:3080/api/admin/server/restart", { method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, body: "{}" }))).status).toBe(403);
    expect((await app.fetch(authedRequest("/api/admin/server/restart", userCookie, { method: "POST", body: "{}" }))).status).toBe(403);
  });
});
```

```ts
// apps/server/api/src/api/admin-server/__tests__/logs.route.test.ts
// … admin fixture …
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logsSeams } from "@/api/admin-server/logs.route.js";

describe("GET /api/admin/server/logs", () => {
  const realPath = logsSeams.path;
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "subshell-logs-route-"));
    const file = join(dir, "server.log");
    const lines = [0, 1, 2, 3, 4].map((i) => JSON.stringify({ timestamp: `2026-09-12T10:00:0${i}.000Z`, level: i === 3 ? "warn" : "info", message: `line-${i}` }));
    writeFileSync(file, `${lines.join("\n")}\n{not json`);
    logsSeams.path = () => file;
  });
  afterAll(() => {
    logsSeams.path = realPath;
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns the file's tail, oldest first, with a raw entry for a non-JSON line", async () => {
    const res = await app.fetch(authedRequest("/api/admin/server/logs?lines=3", adminCookie));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { lines: { level: string; message: string }[]; file: string; bytes: number; capBytes: number };
    expect(body.lines.map((l) => l.message)).toEqual(["line-3", "line-4", "{not json"]);
    expect(body.lines[0]?.level).toBe("warn");
    expect(body.lines[2]?.level).toBe("raw");
    expect(body.capBytes).toBe(204_800);
    expect(body.bytes).toBeGreaterThan(0);
    expect(body.file.endsWith("server.log")).toBe(true);
  });
  it("clamps lines to 1..1000", async () => {
    expect((await app.fetch(authedRequest("/api/admin/server/logs?lines=0", adminCookie))).status).toBe(400);
    expect((await app.fetch(authedRequest("/api/admin/server/logs?lines=5000", adminCookie))).status).toBe(400);
  });
  it("answers empty, not 500, when the file does not exist yet", async () => {
    logsSeams.path = () => join(dir, "absent.log");
    const res = await app.fetch(authedRequest("/api/admin/server/logs", adminCookie));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { lines: unknown[]; bytes: number }).lines).toEqual([]);
  });
});
```

```ts
// apps/server/api/src/api/admin-server/__tests__/logging.route.test.ts
// … admin fixture …
import { currentDebugLogging } from "@/services/logging-preference.js";
import { serverLogFile } from "@/utils/log-file.js";

describe("PUT /api/admin/server/logging", () => {
  afterEach(() => {
    delete process.env.SUBSHELL_DEBUG_LOGGING;
  });
  it("turns debug on and off, live, and persists it; the view reflects it", async () => {
    let res = await app.fetch(authedRequest("/api/admin/server/logging", adminCookie, { method: "PUT", body: JSON.stringify({ debug: true }) }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { logging: { debug: boolean; source: string } }).logging).toEqual(expect.objectContaining({ debug: true, source: "setting" }));
    expect(serverLogFile.level).toBe("debug");
    expect(currentDebugLogging()).toEqual({ debug: true, source: "setting" });
    res = await app.fetch(authedRequest("/api/admin/server/logging", adminCookie, { method: "PUT", body: JSON.stringify({ debug: false }) }));
    expect(res.status).toBe(200);
    expect(serverLogFile.level).toBe("info");
    const events = await new AuditRepository(db).list({ limit: 5 });
    expect(events.filter((e) => e.action === "server.logging.update").length).toBeGreaterThanOrEqual(2);
  });
  it("409 LOGGING_FROM_ENV while the environment forces it", async () => {
    process.env.SUBSHELL_DEBUG_LOGGING = "1";
    const res = await app.fetch(authedRequest("/api/admin/server/logging", adminCookie, { method: "PUT", body: JSON.stringify({ debug: false }) }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("LOGGING_FROM_ENV");
  });
  it("bearer 403, non-admin 403", async () => { /* as above */ });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/server/api && bun test src/api/admin-server/`
Expected: the three new files FAIL (404 / module not found).

- [ ] **Step 3: Implement the three routes**

```ts
// apps/server/api/src/api/admin-server/restart.route.ts
import { BackendErrorCodes } from "@internal/backend-errors";
import { Elysia, t } from "elysia";
import { requireAdmin } from "@/api/auth-guard.js";
import { apiErrorBody } from "@/lib/api-error.js";
import { apiModels } from "@/schema/index.js";
import { audit } from "@/services/audit.js";
import { collectDeployment } from "@/services/server-deployment.js";
import { performRestart } from "@/services/server-restart.js";

const RestartBodySchema = t.Object({
  force: t.Optional(t.Boolean({ description: "Restart even though the installed service definition would take live panes down" })),
});

const RestartResponseSchema = t.Object({
  restarting: t.Literal(true, { description: "The shutdown is scheduled; the manager respawns the process" }),
  resumeAt: t.String({ description: "The saved APP_BASE_URL — where the server comes back, which may differ from where this request went" }),
});

/** Test seams: the view and the act, replaceable without a module mock. @internal */
export const restartSeams = { deployment: collectDeployment, perform: performRestart };

/**
 * `POST /api/admin/server/restart` — the server restarts itself by exiting,
 * only when the service manager reports this very pid (spec § 3.3). Refuses
 * when not supervised and, without `force`, when the definition would kill
 * panes. Audits, answers 202, then shuts down after the response flushes.
 */
export const restartRoute = new Elysia()
  .use(requireAdmin)
  .use(apiModels)
  .post(
    "/restart",
    async ({ body, user, status }) => {
      const view = restartSeams.deployment();
      if (!view.service.supervised) {
        return status(409, apiErrorBody({ code: BackendErrorCodes.RESTART_UNAVAILABLE, message: view.restart.reason ?? "This server is not running under a service manager" }));
      }
      if (view.service.paneSafety !== "keeps" && body.force !== true) {
        return status(
          409,
          apiErrorBody({
            code: BackendErrorCodes.RESTART_KILLS_PANES,
            message: "The installed service definition would close every running subshell on restart; reinstall the service definition, or pass force to restart anyway",
          }),
        );
      }
      await audit({
        actorUserId: user.id,
        action: "server.restart",
        targetType: "server",
        targetId: "process",
        metadataJson: JSON.stringify({ forced: body.force === true, resumeAt: view.settings.APP_BASE_URL.saved }),
      });
      restartSeams.perform();
      return status(202, { restarting: true as const, resumeAt: view.settings.APP_BASE_URL.saved });
    },
    {
      body: RestartBodySchema,
      response: { 202: RestartResponseSchema, 401: "ApiErrorResponse", 403: "ApiErrorResponse", 409: "ApiErrorResponse" },
      detail: {
        operationId: "restartServer",
        tags: ["admin"],
        description: "Restart the server by exiting for its service manager to respawn (409 when not supervised, or when the definition would kill panes and force is not set). Cookie-admin only.",
      },
    },
  );
```

```ts
// apps/server/api/src/api/admin-server/logs.route.ts
import { Elysia, t } from "elysia";
import { requireAdmin } from "@/api/auth-guard.js";
import { readServerLogTail, SERVER_LOG_CAP_BYTES, serverLogPath } from "@/utils/log-file.js";

const LogsQuerySchema = t.Object({
  lines: t.Optional(t.Numeric({ minimum: 1, maximum: 1000, default: 200, description: "How many of the newest lines to return (1..1000)" })),
});

const LogsResponseSchema = t.Object({
  lines: t.Array(
    t.Object({
      ts: t.String({ description: "ISO 8601 timestamp; empty for a raw line" }),
      level: t.String({ description: "Log level word, or `raw` for a line that was not JSON" }),
      message: t.String({ description: "The message" }),
      data: t.Optional(t.Unknown({ description: "Context, metadata and error fields the line carried" })),
    }),
    { description: "Oldest first" },
  ),
  file: t.String({ description: "The log file read" }),
  bytes: t.Number({ description: "The file's current size" }),
  capBytes: t.Number({ description: "Size at which the file is replaced" }),
});

/** Test seam: where the file is. @internal */
export const logsSeams = { path: serverLogPath };

/** `GET /api/admin/server/logs` — the newest lines of the server's own log file (spec § 3.4). */
export const logsRoute = new Elysia().use(requireAdmin).get(
  "/logs",
  async ({ query }) => {
    const path = logsSeams.path();
    const { lines, bytes } = await readServerLogTail(path, query.lines ?? 200);
    return { lines, file: path, bytes, capBytes: SERVER_LOG_CAP_BYTES };
  },
  {
    query: LogsQuerySchema,
    response: LogsResponseSchema,
    detail: {
      operationId: "readServerLogs",
      tags: ["admin"],
      description: "The server's most recent log lines, read from its capped log file. Cookie-admin only.",
    },
  },
);
```

```ts
// apps/server/api/src/api/admin-server/logging.route.ts
import { BackendErrorCodes } from "@internal/backend-errors";
import { Elysia, t } from "elysia";
import { DeploymentViewSchema } from "@/api/admin-server/schemas.js";
import { requireAdmin } from "@/api/auth-guard.js";
import { apiErrorBody } from "@/lib/api-error.js";
import { apiModels } from "@/schema/index.js";
import { audit } from "@/services/audit.js";
import { currentDebugLogging, setDebugLogging } from "@/services/logging-preference.js";
import { collectDeployment } from "@/services/server-deployment.js";

const LoggingBodySchema = t.Object({
  debug: t.Boolean({ description: "Debug logging on: debug-level lines and every HTTP request go to the log file" }),
});

/**
 * `PUT /api/admin/server/logging` — the debug-logging switch (spec § 3.4).
 * Applied live (the file transport's level) and persisted as an instance
 * setting. Refused while `SUBSHELL_DEBUG_LOGGING` forces it from the
 * environment, so the page never reports a success that the next boot
 * undoes.
 */
export const loggingRoute = new Elysia()
  .use(requireAdmin)
  .use(apiModels)
  .put(
    "/logging",
    async ({ body, user, status }) => {
      const before = currentDebugLogging();
      if (before.source === "process env") {
        return status(409, apiErrorBody({ code: BackendErrorCodes.LOGGING_FROM_ENV, message: "SUBSHELL_DEBUG_LOGGING is set in the server's environment; unset it there to control debug logging from here" }));
      }
      await setDebugLogging(body.debug);
      if (before.debug !== body.debug) {
        await audit({ actorUserId: user.id, action: "server.logging.update", targetType: "server", targetId: "debug_logging", metadataJson: JSON.stringify({ from: before.debug, to: body.debug }) });
      }
      return collectDeployment();
    },
    {
      body: LoggingBodySchema,
      response: { 200: DeploymentViewSchema, 401: "ApiErrorResponse", 403: "ApiErrorResponse", 409: "ApiErrorResponse" },
      detail: { operationId: "updateServerLogging", tags: ["admin"], description: "Turn debug logging (and with it HTTP request logging) on or off, live and persisted. Cookie-admin only; 409 while the environment forces it." },
    },
  );
```

Register all three in `index.ts`.

- [ ] **Step 4: Run all admin-server tests, `turbo build`, then the full verification trio**

Run: `cd apps/server/api && bun test src/api/admin-server/ && cd ../../.. && bunx turbo build && bun run verify-types && bun run lint:check && bun run test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/api/src/api/admin-server
git commit -m "feat(server): restart, log tail and the debug-logging switch under /api/admin/server"
```

---

### Task 10: Protocol — `ready.runtime`, the `restart` command, two result-error constants

**Files:**
- Modify: `packages/subshell-protocol/src/node-frames.ts` (`NodeCommandBody` union ~347, `NodeEvent.ready` ~434-470, `parseNodeCommandBody` ~696, `parseNodeEvent` ~716-728)
- Modify: `packages/subshell-protocol/src/index.ts` (export the new names)
- Test: `packages/subshell-protocol/src/__tests__/node-frames.test.ts` (append)

**Interfaces:**
- Produces:
  ```ts
  export interface NodeRuntimeReport {
    startedAt: string; supervised: boolean;
    service: { manager: "launchd" | "systemd" | null; installed: boolean; definitionPath: string | null; state: string; pid: number | null; enabled: boolean | null; paneSafety: "keeps" | "kills" | "unknown" };
    configPath: string; logPath: string | null; logHint: string | null; tmuxPath: string | null; binaryPath: string;
  }
  // NodeEvent ready gains: runtime?: NodeRuntimeReport
  // NodeCommandBody gains: | { type: "restart"; force?: boolean }
  export const NODE_RESULT_NOT_SUPERVISED = "not supervised";
  export const NODE_RESULT_KILLS_PANES = "kills panes";
  export function parseNodeRuntimeReport(value: unknown): NodeRuntimeReport | null
  ```

- [ ] **Step 1: Write the failing tests**

Append to `node-frames.test.ts`:

```ts
describe("ready.runtime (additive)", () => {
  const base = { type: "ready", agentVersion: "0.2.0", protocolVersion: NODE_PROTOCOL_VERSION, os: "linux", arch: "x64", hostname: "h", dataDir: "/d", capabilities: [] };
  const runtime = {
    startedAt: "2026-09-12T10:00:00.000Z", supervised: true,
    service: { manager: "systemd", installed: true, definitionPath: "/u/.config/systemd/user/subshell.service", state: "running", pid: 42, enabled: true, paneSafety: "keeps" },
    configPath: "/u/.config/subshell/config.json", logPath: null, logHint: "journalctl --user -u subshell.service -f", tmuxPath: "/usr/bin/tmux", binaryPath: "/u/.local/bin/subshell",
  };
  it("accepts a ready with a well-formed runtime and without one", () => {
    expect(parseNodeEvent({ ...base, runtime })).toMatchObject({ type: "ready", runtime });
    expect(parseNodeEvent(base)).toMatchObject({ type: "ready" });
  });
  it("drops a malformed runtime but keeps the ready", () => {
    const ev = parseNodeEvent({ ...base, runtime: { startedAt: 5 } });
    expect(ev?.type).toBe("ready");
    expect(ev && "runtime" in ev ? ev.runtime : undefined).toBeUndefined();
  });
});

describe("restart command", () => {
  it("parses with and without force", () => {
    expect(parseNodeCommandBody({ type: "restart" })).toEqual({ type: "restart" });
    expect(parseNodeCommandBody({ type: "restart", force: true })).toEqual({ type: "restart", force: true });
    expect(parseNodeCommandBody({ type: "restart", force: "yes" })).toBeNull();
  });
  it("names the two refusal strings as constants", () => {
    expect(NODE_RESULT_NOT_SUPERVISED).toBe("not supervised");
    expect(NODE_RESULT_KILLS_PANES).toBe("kills panes");
  });
});
```

Add `NODE_RESULT_KILLS_PANES`, `NODE_RESULT_NOT_SUPERVISED`, `parseNodeCommandBody` to the test's import list.

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/subshell-protocol && bun test src/__tests__/node-frames.test.ts`
Expected: FAIL — names not exported.

- [ ] **Step 3: Implement**

In `node-frames.ts`, after `NODE_CLOSE_SUPERSEDED`:

```ts
/** `result.error` from a `restart` the agent refused because its service manager did not start it (exiting would not be a restart). */
export const NODE_RESULT_NOT_SUPERVISED = "not supervised";
/** `result.error` from a `restart` the agent refused because the installed definition would take live panes down (send `force: true`). */
export const NODE_RESULT_KILLS_PANES = "kills panes";

/**
 * How an agent process is running, reported once per connect in `ready`
 * (spec 2026-09-12 § 6.1). Facts about a PROCESS, so the plane keeps them on
 * the live connection and never in the nodes table.
 */
export interface NodeRuntimeReport {
  /** ISO 8601 start time of this agent process. */
  startedAt: string;
  /** `service.state === "running" && service.pid === process.pid`: exiting is a restart. */
  supervised: boolean;
  /** The service manager's view of the unit, as `subshell service status --json` reports it. */
  service: {
    manager: "launchd" | "systemd" | null;
    installed: boolean;
    definitionPath: string | null;
    state: string;
    pid: number | null;
    enabled: boolean | null;
    paneSafety: "keeps" | "kills" | "unknown";
  };
  /** `~/.config/subshell/config.json`, resolved. */
  configPath: string;
  /** The launchd log file; null under systemd. */
  logPath: string | null;
  /** The journal command when `logPath` is null. */
  logHint: string | null;
  /** tmux on the daemon's PATH, or null. */
  tmuxPath: string | null;
  /** The agent binary this process re-enters (`selfInvoke.command`). */
  binaryPath: string;
}

/** Shape-check a `NodeRuntimeReport`; null when malformed (the ready is still accepted without it). */
export function parseNodeRuntimeReport(value: unknown): NodeRuntimeReport | null {
  if (!isRecord(value) || !isRecord(value.service)) return null;
  const s = value.service;
  const manager = s.manager === "launchd" || s.manager === "systemd" || s.manager === null ? s.manager : undefined;
  const paneSafety = s.paneSafety === "keeps" || s.paneSafety === "kills" || s.paneSafety === "unknown" ? s.paneSafety : undefined;
  if (
    !isStr(value.startedAt) || !isBool(value.supervised) || manager === undefined || !isBool(s.installed) ||
    !(s.definitionPath === null || isStr(s.definitionPath)) || !isStr(s.state) || !(s.pid === null || isInt(s.pid)) ||
    !(s.enabled === null || isBool(s.enabled)) || paneSafety === undefined || !isStr(value.configPath) ||
    !(value.logPath === null || isStr(value.logPath)) || !(value.logHint === null || isStr(value.logHint)) ||
    !(value.tmuxPath === null || isStr(value.tmuxPath)) || !isStr(value.binaryPath)
  ) {
    return null;
  }
  return {
    startedAt: value.startedAt, supervised: value.supervised,
    service: { manager, installed: s.installed, definitionPath: s.definitionPath, state: s.state, pid: s.pid, enabled: s.enabled, paneSafety },
    configPath: value.configPath, logPath: value.logPath, logHint: value.logHint, tmuxPath: value.tmuxPath, binaryPath: value.binaryPath,
  };
}
```

- In the `NodeEvent` `ready` variant add `/** How the agent process runs (spec 2026-09-12 § 6.1). Absent from agents that predate it. */ runtime?: NodeRuntimeReport;`.
- In `parseNodeEvent`'s `ready` case: keep the existing required-field check; then, instead of `(value as unknown as NodeEvent)`, build the event by spreading the validated required fields and add `runtime` only when `parseNodeRuntimeReport(value.runtime)` returns non-null:
  ```ts
  case "ready": {
    if (!(/* existing conjunction, unchanged */)) return null;
    const { runtime: rawRuntime, ...rest } = value as Record<string, unknown> & { runtime?: unknown };
    const runtime = rawRuntime === undefined ? null : parseNodeRuntimeReport(rawRuntime);
    return { ...(rest as unknown as Extract<NodeEvent, { type: "ready" }>), ...(runtime ? { runtime } : {}) };
  }
  ```
- In `NodeCommandBody` add `| { /** Exit for the service manager to respawn (spec 2026-09-12 § 6.3). */ type: "restart"; force?: boolean }` next to `ping`.
- In `parseNodeCommandBody`: `case "restart": return !("force" in value) ? { type: "restart" } : isBool(value.force) ? { type: "restart", force: value.force } : null;`
- Export `NodeRuntimeReport`, `parseNodeRuntimeReport`, `NODE_RESULT_NOT_SUPERVISED`, `NODE_RESULT_KILLS_PANES` from `src/index.ts` wherever `NODE_CLOSE_SUPERSEDED` is exported.

- [ ] **Step 4: Run the protocol tests and build**

Run: `cd packages/subshell-protocol && bun test && bun run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/subshell-protocol/src
git commit -m "feat(protocol): ready.runtime report and the restart node command"
```

---

### Task 11: Agent — collect the runtime report and send it in `ready`

**Files:**
- Create: `apps/node/agent/src/runtime.ts`
- Modify: `apps/node/agent/src/service.ts` (export `AGENT_LOG_HINT`)
- Modify: `apps/node/agent/src/daemon.ts:93-121` (`DaemonDeps.runtime`), `:226-260` (`readyEvent(config, runtime)`), `:279-281`, `:533-544`
- Test: `apps/node/agent/src/__tests__/runtime.test.ts`

**Interfaces:**
- Consumes: `queryService`, `DEFAULT_DEPS`, `type ServiceState` (`service.ts`); `selfInvokePrefix()` (`self-invoke.ts`); `configPath()` — whatever `config.ts` exports for `~/.config/subshell/config.json` (it is built from `clientHome()`; if only the directory function is exported, add `export function configFilePath(): string`).
- Produces: `export async function collectRuntime(deps?: RuntimeDeps): Promise<NodeRuntimeReport>` with `RuntimeDeps { platform?: NodeJS.Platform; pid?: number; queryService?: () => Promise<ServiceState>; which?: (name: string) => string | null; configPath?: string; binaryPath?: string; now?: () => number; uptimeSeconds?: () => number }`; `readyEvent(config, runtime: NodeRuntimeReport | null)`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/node/agent/src/__tests__/runtime.test.ts
import { describe, expect, it } from "bun:test";
import { collectRuntime } from "../runtime.js";

const running = { installed: true, definitionPath: "/u/.config/systemd/user/subshell.service", state: "running", pid: 99, enabled: true, paneSafety: "keeps", detail: "", logPath: null } as const;

describe("collectRuntime", () => {
  it("is supervised only when the manager's pid is ours, names the journal on linux, and dates startedAt from uptime", async () => {
    const r = await collectRuntime({
      platform: "linux", pid: 99, queryService: async () => running as never, which: (n) => (n === "tmux" ? "/usr/bin/tmux" : null),
      configPath: "/u/.config/subshell/config.json", binaryPath: "/u/.local/bin/subshell",
      now: () => Date.UTC(2026, 8, 12, 10, 0, 30), uptimeSeconds: () => 30,
    });
    expect(r.supervised).toBe(true);
    expect(r.service.manager).toBe("systemd");
    expect(r.logHint).toContain("journalctl --user -u subshell.service");
    expect(r.startedAt).toBe("2026-09-12T10:00:00.000Z");
    expect(r.tmuxPath).toBe("/usr/bin/tmux");
    expect(r.binaryPath).toBe("/u/.local/bin/subshell");
  });
  it("is not supervised under a different pid, and reports the log file on darwin", async () => {
    const r = await collectRuntime({
      platform: "darwin", pid: 1, queryService: async () => ({ ...running, logPath: "/u/Library/Logs/subshell.log" }) as never,
      which: () => null, configPath: "/c", binaryPath: "/b",
    });
    expect(r.supervised).toBe(false);
    expect(r.service.manager).toBe("launchd");
    expect(r.logPath).toBe("/u/Library/Logs/subshell.log");
    expect(r.logHint).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/node/agent && bun test src/__tests__/runtime.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

In `service.ts`, beside `SYSTEMD_UNIT_NAME`:
```ts
/** How to read the daemon's log where the unit redirects nothing (Linux). The desktop app used to hold this string; the agent reports it now. */
export const AGENT_LOG_HINT = `journalctl --user -u ${SYSTEMD_UNIT_NAME} -f`;
```

```ts
// apps/node/agent/src/runtime.ts
import type { NodeRuntimeReport } from "@internal/subshell-protocol";
import { configFilePath } from "./config.js";
import { selfInvokePrefix } from "./self-invoke.js";
import { AGENT_LOG_HINT, DEFAULT_DEPS, queryService, type ServiceState } from "./service.js";

/** Injectable seams; production passes nothing. */
export interface RuntimeDeps {
  platform?: NodeJS.Platform;
  pid?: number;
  queryService?: () => Promise<ServiceState>;
  which?: (name: string) => string | null;
  configPath?: string;
  binaryPath?: string;
  now?: () => number;
  uptimeSeconds?: () => number;
}

/**
 * How this agent process runs, for the `ready` frame (spec 2026-09-12 § 6.1).
 * One `service status` spawn; computed once at daemon start so `ready` stays
 * synchronous. `supervised` is the fact `restart` turns on: exiting is a
 * restart only when the manager started THIS pid.
 */
export async function collectRuntime(deps: RuntimeDeps = {}): Promise<NodeRuntimeReport> {
  const platform = deps.platform ?? process.platform;
  const pid = deps.pid ?? process.pid;
  const service = await (deps.queryService ?? (() => queryService(DEFAULT_DEPS(async () => true))))();
  const which = deps.which ?? ((name: string) => Bun.which(name) ?? null);
  const now = (deps.now ?? Date.now)();
  const uptime = (deps.uptimeSeconds ?? (() => process.uptime()))();
  const manager = platform === "darwin" ? "launchd" : platform === "linux" ? "systemd" : null;
  const logPath = service.logPath ?? null;
  return {
    startedAt: new Date(now - uptime * 1000).toISOString(),
    supervised: service.state === "running" && service.pid === pid,
    service: {
      manager,
      installed: service.installed,
      definitionPath: service.definitionPath,
      state: service.state,
      pid: service.pid,
      enabled: service.enabled,
      paneSafety: service.paneSafety ?? "unknown",
    },
    configPath: deps.configPath ?? configFilePath(),
    logPath,
    logHint: logPath === null && manager === "systemd" ? AGENT_LOG_HINT : null,
    tmuxPath: which("tmux"),
    binaryPath: deps.binaryPath ?? selfInvokePrefix().command,
  };
}
```

In `daemon.ts`:
- `DaemonDeps` gains `/** The runtime report to send in ready (default: collectRuntime() once at start). Tests pass a literal or null to skip the spawn. */ runtime?: NodeRuntimeReport | null;`
- `readyEvent(config: AgentConfig, runtime: NodeRuntimeReport | null)` adds `...(runtime ? { runtime } : {})` to the returned object.
- In `runDaemon`, before the connect loop: `const runtime = deps.runtime === undefined ? await collectRuntime().catch(() => null) : deps.runtime;` and the `open` listener sends `readyEvent(config, runtime)`. The comment there about `ready` being built synchronously stays true.

- [ ] **Step 4: Run the runtime test and the daemon tests**

Run: `cd apps/node/agent && bun test src/__tests__/runtime.test.ts && bun test src/__tests__/daemon*.test.ts`
Expected: PASS. Existing daemon tests that construct `runDaemon(config, deps)` should pass `runtime: null` to avoid a real `service status` spawn — add it where they build deps.

- [ ] **Step 5: Commit**

```bash
git add apps/node/agent/src/runtime.ts apps/node/agent/src/service.ts apps/node/agent/src/daemon.ts apps/node/agent/src/config.ts apps/node/agent/src/__tests__
git commit -m "feat(node): report how the agent runs in ready"
```

---

### Task 12: Agent — the `restart` command

**Files:**
- Modify: `apps/node/agent/src/commands/context.ts` (`CommandContext.runtime`, `CommandContext.requestRestart`)
- Create: `apps/node/agent/src/commands/restart.ts`
- Modify: `apps/node/agent/src/commands/index.ts` (dispatch case)
- Modify: `apps/node/agent/src/daemon.ts` (build the context with `runtime` and `requestRestart`)
- Modify: every test that builds a `CommandContext` literal (grep `uploads: new Map()` under `apps/node/agent/src/__tests__/`) — add `runtime: null, requestRestart: () => {}`.
- Test: `apps/node/agent/src/__tests__/commands-restart.test.ts`

**Interfaces:**
- Produces: `CommandContext.runtime: NodeRuntimeReport | null`, `CommandContext.requestRestart: () => void`; `execRestart(ctx, cmd): Promise<CommandResult>`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/node/agent/src/__tests__/commands-restart.test.ts
import { describe, expect, it } from "bun:test";
import { NODE_RESULT_KILLS_PANES, NODE_RESULT_NOT_SUPERVISED, type NodeRuntimeReport } from "@internal/subshell-protocol";
import type { CommandContext } from "../commands/context.js";
import { dispatchCommand } from "../commands/index.js";

function ctxWith(runtime: NodeRuntimeReport | null, onRestart: () => void): CommandContext {
  return {
    config: { serverUrl: "http://localhost:1", nodeId: "n", nodeKey: "k", controlPublicKey: "{}", dataDir: "/tmp/x", name: "t" },
    tmux: {} as CommandContext["tmux"],
    meta: {} as CommandContext["meta"],
    nowMs: () => 0,
    ws: { send: () => {} },
    watchers: new Map(),
    tails: new Map(),
    uploads: new Map(),
    runtime,
    requestRestart: onRestart,
  };
}
const supervised: NodeRuntimeReport = {
  startedAt: "2026-09-12T00:00:00.000Z", supervised: true,
  service: { manager: "systemd", installed: true, definitionPath: "/x", state: "running", pid: 1, enabled: true, paneSafety: "keeps" },
  configPath: "/c", logPath: null, logHint: "j", tmuxPath: null, binaryPath: "/b",
};

describe("restart", () => {
  it("refuses when not supervised and asks for no exit", async () => {
    let asked = 0;
    const res = await dispatchCommand(ctxWith({ ...supervised, supervised: false }, () => asked++), { type: "restart" });
    expect(res).toEqual({ ok: false, error: NODE_RESULT_NOT_SUPERVISED });
    expect(asked).toBe(0);
  });
  it("refuses a pane-killing definition without force, accepts with force", async () => {
    let asked = 0;
    const kills = { ...supervised, service: { ...supervised.service, paneSafety: "kills" as const } };
    expect(await dispatchCommand(ctxWith(kills, () => asked++), { type: "restart" })).toEqual({ ok: false, error: NODE_RESULT_KILLS_PANES });
    expect(await dispatchCommand(ctxWith(kills, () => asked++), { type: "restart", force: true })).toEqual({ ok: true });
    expect(asked).toBe(1);
  });
  it("accepts when supervised and pane-safe, and asks the daemon to exit", async () => {
    let asked = 0;
    expect(await dispatchCommand(ctxWith(supervised, () => asked++), { type: "restart" })).toEqual({ ok: true });
    expect(asked).toBe(1);
  });
  it("refuses when no runtime was collected", async () => {
    expect(await dispatchCommand(ctxWith(null, () => {}), { type: "restart" })).toEqual({ ok: false, error: NODE_RESULT_NOT_SUPERVISED });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/node/agent && bun test src/__tests__/commands-restart.test.ts`
Expected: FAIL — `unsupported` returned / type errors on the context.

- [ ] **Step 3: Implement**

`context.ts` — add to `CommandContext`:
```ts
  /** How this process runs (Task 11); null when the report could not be collected. `restart` refuses on null. */
  runtime: NodeRuntimeReport | null;
  /**
   * Ask the daemon to exit 0 AFTER the current result frame is sent. The
   * executor cannot exit itself: the daemon is the only sender of `result`,
   * and a restart that never answered would read as a timeout on the plane.
   */
  requestRestart: () => void;
```

```ts
// apps/node/agent/src/commands/restart.ts
import { NODE_RESULT_KILLS_PANES, NODE_RESULT_NOT_SUPERVISED } from "@internal/subshell-protocol";
import type { Cmd, CommandContext, CommandResult } from "./context.js";

/**
 * `restart`: exit for the service manager to respawn (spec 2026-09-12 § 6.3).
 * Refused when this process is not the one the manager started (exiting
 * would just stop it), and — mirroring `subshell service restart` — when the
 * installed definition would take live panes down, unless `force`.
 */
export async function execRestart(ctx: CommandContext, cmd: Cmd<"restart">): Promise<CommandResult> {
  const runtime = ctx.runtime;
  if (!runtime || !runtime.supervised) return { ok: false, error: NODE_RESULT_NOT_SUPERVISED };
  if (runtime.service.paneSafety !== "keeps" && cmd.force !== true) return { ok: false, error: NODE_RESULT_KILLS_PANES };
  ctx.requestRestart();
  return { ok: true };
}
```

`index.ts`: import `execRestart` and add `case "restart": return await execRestart(ctx, cmd);` before `default`.

`daemon.ts`: where the `CommandContext` is built, add `runtime` (from Task 11) and
```ts
    requestRestart: () => {
      // After the result frame has gone out: the send chain is synchronous
      // per frame, so a macrotask later is after it. Same exit path as a
      // signal: the loop sees `shuttingDown` and calls `stop(0)`, and the
      // manager (Restart=always / KeepAlive) brings the process back.
      setTimeout(() => {
        shuttingDown = true;
        currentWs?.close(1000, "restart");
      }, 250);
    },
```
where `currentWs` is the socket of the live `runConnection()` (hold it in a `let` the connection sets on open and clears on close; if a variable like that already exists for the signal handler, reuse it).

Update every test that builds a `CommandContext` literal to add `runtime: null, requestRestart: () => {}`.

- [ ] **Step 4: Run the agent tests**

Run: `cd apps/node/agent && bun test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/node/agent/src
git commit -m "feat(node): the restart command exits for the service manager to respawn"
```

---

### Task 13: Plane — keep `runtime` on the connection, expose it on node detail, add `POST /api/nodes/:id/restart`

**Files:**
- Modify: `apps/server/api/src/services/nodes/node-registry.ts:61-80` (`NodeAgentFacts.runtime?`)
- Modify: `apps/server/api/src/services/nodes/node-ws-handler.ts:270-283` (store it)
- Modify: `apps/server/api/src/api/nodes/node-view.ts:170-175` (`NodeRuntimeSchema`, `GetNodeResponseSchema.runtime?`)
- Modify: `apps/server/api/src/api/nodes/get-node.route.ts` (attach `runtime`)
- Create: `apps/server/api/src/api/nodes/restart-node.route.ts`
- Modify: `apps/server/api/src/api/nodes/index.ts`
- Test: `apps/server/api/src/api/nodes/__tests__/restart-node.route.test.ts`

**Interfaces:**
- Consumes: `sendCommand`, `NodeRpcError` (`node-rpc.ts`); `loadNodeGate`; `nodeCanConfigure`; `getLive`; `NODE_RESULT_*` constants (Task 10); `BackendErrorCodes.NODE_*` (Task 3).
- Produces: `GET /api/nodes/:id` → `runtime?: NodeRuntimeReport`; `POST /api/nodes/:id/restart` body `{ force?: boolean }` → `{ ok: true }`.

- [ ] **Step 1: Write the failing test**

Model on `node-harnesses-route.test.ts` (`req`, `mkAgent`, `fakeSocket`, `waitFor`, `liveConn`, `resolveResult`, users alice/carol, `nodeShares.replaceForNode`):

```ts
// apps/server/api/src/api/nodes/__tests__/restart-node.route.test.ts
// … imports and fixture copied from node-harnesses-route.test.ts …
import { NODE_RESULT_KILLS_PANES, NODE_RESULT_NOT_SUPERVISED, type NodeRuntimeReport } from "@internal/subshell-protocol";

const runtime: NodeRuntimeReport = {
  startedAt: "2026-09-12T00:00:00.000Z", supervised: true,
  service: { manager: "systemd", installed: true, definitionPath: "/x", state: "running", pid: 1, enabled: true, paneSafety: "keeps" },
  configPath: "/c", logPath: null, logHint: "journalctl --user -u subshell.service -f", tmuxPath: "/usr/bin/tmux", binaryPath: "/b",
};

/** Fire a restart and answer its one command. */
async function restartWithAnswer(nodeId: string, cookie: string, body: unknown, answer: { ok: true } | { ok: false; error: string }): Promise<Response> {
  const sock = fakeSocket();
  const conn = attachConnection(nodeId, sock);
  conn.agent = { dataDir: "/d", capabilities: [], hostname: "h", agentVersion: "0.2.0", runtime };
  try {
    const resP = req("POST", `/api/nodes/${nodeId}/restart`, { cookie, body });
    await waitFor(() => sock.sent.length > 0, "restart command on the wire");
    const frame = JSON.parse(sock.sent[0] as string) as { jws: string };
    const claim = JSON.parse(Buffer.from(frame.jws.split(".")[1], "base64url").toString("utf8")) as { jti: string; cmd: { type: string; force?: boolean } };
    expect(claim.cmd.type).toBe("restart");
    expect(claim.cmd.force).toBe((body as { force?: boolean }).force);
    const ev = answer.ok ? ({ type: "result", ref: claim.jti, ok: true } as const) : ({ type: "result", ref: claim.jti, ok: false, error: answer.error } as const);
    expect(resolveResult(liveConn(nodeId), ev)).toBe(true);
    return await resP;
  } finally {
    resetNodeRegistryForTests();
  }
}

describe("POST /api/nodes/:id/restart", () => {
  it("offline → 409 NODE_OFFLINE", async () => {
    const id = await mkAgent();
    const res = await req("POST", `/api/nodes/${id}/restart`, { cookie: aliceCookie, body: {} });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("NODE_OFFLINE");
  });
  it("view grantee 403, local 400, unknown 404, bearer 403, anon 401", async () => {
    const id = await mkAgent();
    await nodeShares.replaceForNode(id, [{ granteeUserId: carolId, permission: "view" }], aliceId);
    expect((await req("POST", `/api/nodes/${id}/restart`, { cookie: carolCookie, body: {} })).status).toBe(403);
    expect((await req("POST", `/api/nodes/local/restart`, { cookie: aliceCookie, body: {} })).status).toBe(400);
    expect((await req("POST", `/api/nodes/nope-${crypto.randomUUID()}/restart`, { cookie: aliceCookie, body: {} })).status).toBe(404);
    expect((await req("POST", `/api/nodes/${id}/restart`, { bearer: subshellKey, body: {} })).status).toBe(403);
    expect((await req("POST", `/api/nodes/${id}/restart`, { body: {} })).status).toBe(401);
  });
  it("online: sends the signed restart, answers {ok:true}, audits node.restart", async () => {
    const id = await mkAgent();
    const res = await restartWithAnswer(id, aliceCookie, {}, { ok: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
  it("maps the agent's refusals: not supervised, kills panes, unsupported", async () => {
    const id = await mkAgent();
    let res = await restartWithAnswer(id, aliceCookie, {}, { ok: false, error: NODE_RESULT_NOT_SUPERVISED });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("NODE_NOT_SUPERVISED");
    res = await restartWithAnswer(id, aliceCookie, {}, { ok: false, error: NODE_RESULT_KILLS_PANES });
    expect(((await res.json()) as { code: string }).code).toBe("NODE_RESTART_KILLS_PANES");
    res = await restartWithAnswer(id, aliceCookie, { force: true }, { ok: false, error: "unsupported" });
    expect(((await res.json()) as { code: string }).code).toBe("NODE_AGENT_TOO_OLD");
  });
});

describe("GET /api/nodes/:id runtime", () => {
  it("is present for an online node's owner and absent for a view grantee and when offline", async () => {
    const id = await mkAgent();
    await nodeShares.replaceForNode(id, [{ granteeUserId: carolId, permission: "view" }], aliceId);
    expect(((await (await req("GET", `/api/nodes/${id}`, { cookie: aliceCookie })).json()) as { runtime?: unknown }).runtime).toBeUndefined();
    const conn = attachConnection(id, fakeSocket());
    conn.agent = { dataDir: "/d", capabilities: [], hostname: "h", agentVersion: "0.2.0", runtime };
    try {
      expect(((await (await req("GET", `/api/nodes/${id}`, { cookie: aliceCookie })).json()) as { runtime?: NodeRuntimeReport }).runtime).toEqual(runtime);
      expect(((await (await req("GET", `/api/nodes/${id}`, { cookie: carolCookie })).json()) as { runtime?: unknown }).runtime).toBeUndefined();
    } finally {
      resetNodeRegistryForTests();
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/server/api && bun test src/api/nodes/__tests__/restart-node.route.test.ts`
Expected: FAIL — 404 on restart; `runtime` undefined.

- [ ] **Step 3: Implement**

`node-registry.ts` — add to `NodeAgentFacts`: `/** How the agent process runs (spec 2026-09-12 § 6.1); absent from agents that predate it. */ runtime?: NodeRuntimeReport;`

`node-ws-handler.ts` — in the `conn.agent = {…}` literal add `...(event.runtime ? { runtime: event.runtime } : {}),` (conditional spread, like `homeDir`).

`node-view.ts` — add:
```ts
/** `ready.runtime`, mirrored for the detail view (spec 2026-09-12 § 6.2). */
export const NodeRuntimeSchema = t.Object({
  startedAt: t.String({ description: "ISO 8601 start of the agent process" }),
  supervised: t.Boolean({ description: "Whether the service manager started this process (so a restart is possible)" }),
  service: t.Object({
    manager: t.Nullable(t.Union([t.Literal("launchd"), t.Literal("systemd")]), { description: "Per-user service manager" }),
    installed: t.Boolean({ description: "Unit/plist exists on disk" }),
    definitionPath: t.Nullable(t.String(), { description: "Where the definition lives" }),
    state: t.String({ description: "The manager's word for the process state" }),
    pid: t.Nullable(t.Number(), { description: "Main pid" }),
    enabled: t.Nullable(t.Boolean(), { description: "Starts at login" }),
    paneSafety: t.Union([t.Literal("keeps"), t.Literal("kills"), t.Literal("unknown")], { description: "Whether stopping keeps live panes" }),
  }),
  configPath: t.String({ description: "The agent's config.json" }),
  logPath: t.Nullable(t.String(), { description: "The launchd log file; null under systemd" }),
  logHint: t.Nullable(t.String(), { description: "Journal command when logPath is null" }),
  tmuxPath: t.Nullable(t.String(), { description: "tmux on the daemon's PATH" }),
  binaryPath: t.String({ description: "The agent binary" }),
});
```
and to `GetNodeResponseSchema`: `runtime: t.Optional(NodeRuntimeSchema)` with description "How the agent runs — present only while online and only for config-capable viewers".

`get-node.route.ts` — after building the view, when `gate.row.kind === "agent" && nodeCanConfigure(gate.access)`: `const runtime = getLive(gate.row.id)?.agent?.runtime; if (runtime) out.runtime = runtime;`.

```ts
// apps/server/api/src/api/nodes/restart-node.route.ts
import { BackendErrorCodes } from "@internal/backend-errors";
import { NODE_RESULT_KILLS_PANES, NODE_RESULT_NOT_SUPERVISED } from "@internal/subshell-protocol";
import { Elysia, t } from "elysia";
import { authGuard, ForbiddenError, requireCookieActor } from "@/api/auth-guard.js";
import { loadNodeGate } from "@/api/nodes/node-gate.js";
import { apiErrorBody } from "@/lib/api-error.js";
import { nodeCanConfigure } from "@/lib/node-access.js";
import { apiModels } from "@/schema/index.js";
import { audit } from "@/services/audit.js";
import { NodeRpcError, sendCommand } from "@/services/nodes/node-rpc.js";

const RestartBodySchema = t.Object({
  force: t.Optional(t.Boolean({ description: "Restart even though the node's service definition would take live panes down" })),
});
const RestartResponseSchema = t.Object({ ok: t.Literal(true, { description: "The agent accepted and is exiting for its manager to respawn" }) });

/** The agent's `result.error` → API code, for the refusals it can send. */
function codeFor(err: NodeRpcError): BackendErrorCodes {
  if (err.code === "offline") return BackendErrorCodes.NODE_OFFLINE;
  if (err.code === "unsupported") return BackendErrorCodes.NODE_AGENT_TOO_OLD;
  if (err.message.includes(NODE_RESULT_NOT_SUPERVISED)) return BackendErrorCodes.NODE_NOT_SUPERVISED;
  if (err.message.includes(NODE_RESULT_KILLS_PANES)) return BackendErrorCodes.NODE_RESTART_KILLS_PANES;
  return BackendErrorCodes.NODE_UNREACHABLE;
}

/**
 * `POST /api/nodes/:id/restart` — ask an enrolled node's agent to exit for its
 * service manager to respawn (spec 2026-09-12 § 6.3). Owner or `edit`, cookie
 * only; `local` → 400 (the server has its own restart). No new trust: the
 * plane already runs arbitrary launches on this node.
 */
export const restartNodeRoute = new Elysia()
  .use(authGuard)
  .use(apiModels)
  .post(
    "/:id/restart",
    async ({ params, body, user, actor, status }) => {
      requireCookieActor(actor, "Node restarts are restricted to browser sessions");
      const gate = await loadNodeGate(user.id, params.id);
      if (!gate) return status(404, apiErrorBody({ code: BackendErrorCodes.NOT_FOUND_ERROR, message: "Node not found" }));
      if (!nodeCanConfigure(gate.access)) throw new ForbiddenError();
      if (gate.row.kind === "local") {
        return status(400, apiErrorBody({ code: BackendErrorCodes.BAD_REQUEST, message: "The control-plane host restarts from Server Settings → Service, not as a node" }));
      }
      try {
        await sendCommand(gate.row.id, body.force ? { type: "restart", force: true } : { type: "restart" });
      } catch (err) {
        if (err instanceof NodeRpcError) return status(409, apiErrorBody({ code: codeFor(err), message: err.message }));
        throw err;
      }
      await audit({ actorUserId: user.id, action: "node.restart", targetType: "node", targetId: gate.row.id, metadataJson: JSON.stringify({ forced: body.force === true }) });
      return { ok: true } as const;
    },
    {
      params: t.Object({ id: t.String({ description: "Node id" }) }),
      body: RestartBodySchema,
      response: { 200: RestartResponseSchema, 400: "ApiErrorResponse", 401: "ApiErrorResponse", 403: "ApiErrorResponse", 404: "ApiErrorResponse", 409: "ApiErrorResponse" },
      detail: { operationId: "restartNode", tags: ["nodes"], description: "Ask an enrolled node's agent to restart (409 when offline, not supervised, too old, or pane-unsafe without force)" },
    },
  );
```

Check how `NodeRpcError` carries an `ok:false` error text (`node-rpc.ts:24-72`: `failed` carries the message) — `codeFor` relies on the message containing the agent's string; if the class exposes the raw error separately, prefer that field.

Register in `index.ts`: `.use(restartNodeRoute)`.

- [ ] **Step 4: Run the nodes tests, `turbo build`**

Run: `cd apps/server/api && bun test src/api/nodes/ && cd ../../.. && bunx turbo build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/api/src/services/nodes apps/server/api/src/api/nodes
git commit -m "feat(server): node detail carries the agent's runtime; POST /api/nodes/:id/restart"
```

---

### Task 14: SPA — Runtime card and Restart on node detail

**Files:**
- Modify: `apps/server/web/src/types/node.ts:114-117` (`NodeDetail.runtime?`, `NodeRuntime` interface mirroring `NodeRuntimeSchema`)
- Modify: `apps/server/web/src/hooks/use-nodes.ts` (`useRestartNode`)
- Create: `apps/server/web/src/components/nodes/node-runtime-card.tsx`
- Create: `apps/server/web/src/hooks/use-node-restart-wait.ts`
- Modify: `apps/server/web/src/routes/nodes_.$id.tsx` (mount the card after `NodeKeyRotate`)
- Test: `apps/server/web/src/components/__tests__/node-runtime-card.test.tsx`

**Interfaces:**
- Produces: `useRestartNode(id): UseMutationResult<{ok:true}, ApiError, { force?: boolean }>`; `NodeRuntimeCard({ node })`; `useNodeRestartWait(id): { waiting: boolean; begin(): void; outcome: "idle" | "waiting" | "back" | "timeout" }`.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/server/web/src/components/__tests__/node-runtime-card.test.tsx
import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { NodeRuntimeCard } from "@/components/nodes/node-runtime-card";
import type { NodeDetail } from "@/types/node";

const base = {
  id: "n1", name: "devbox", kind: "agent", os: "linux", arch: "x64", hostname: "h", status: "online", lastSeenAt: null,
  agentVersion: "0.2.0", protocolVersion: 4, access: "owner", canManage: true, allowedDirs: [], capabilities: [], harnesses: [], inventoryStale: false,
} as unknown as NodeDetail;

function renderCard(node: NodeDetail) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><NodeRuntimeCard node={node} /></QueryClientProvider>);
}
afterEach(cleanup);

describe("NodeRuntimeCard", () => {
  it("renders nothing without a runtime report", () => {
    renderCard(base);
    expect(screen.queryByText("Runtime")).toBeNull();
  });
  it("shows supervision, paths and the journal hint, and offers Restart when supervised", () => {
    renderCard({
      ...base,
      runtime: {
        startedAt: "2026-09-12T10:00:00.000Z", supervised: true,
        service: { manager: "systemd", installed: true, definitionPath: "/u/.config/systemd/user/subshell.service", state: "running", pid: 511, enabled: true, paneSafety: "keeps" },
        configPath: "/u/.config/subshell/config.json", logPath: null, logHint: "journalctl --user -u subshell.service -f", tmuxPath: null, binaryPath: "/u/.local/bin/subshell",
      },
    });
    expect(screen.getByText("Runtime")).toBeTruthy();
    expect(screen.getByText(/systemd \(pid 511\)/)).toBeTruthy();
    expect(screen.getByText("journalctl --user -u subshell.service -f")).toBeTruthy();
    expect(screen.getByText(/not found: this node accepts no launches/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Restart agent" }) as HTMLButtonElement).disabled).toBe(false);
  });
  it("disables Restart with the reason when not supervised", () => {
    renderCard({ ...base, runtime: { startedAt: "2026-09-12T10:00:00.000Z", supervised: false, service: { manager: null, installed: false, definitionPath: null, state: "unknown", pid: null, enabled: null, paneSafety: "unknown" }, configPath: "/c", logPath: null, logHint: null, tmuxPath: "/t", binaryPath: "/b" } });
    const btn = screen.getByRole("button", { name: "Restart agent" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(screen.getByText(/Not supervised/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/server/web && bun test src/components/__tests__/node-runtime-card.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`types/node.ts`:
```ts
/** How an agent process runs; mirrors the backend `NodeRuntimeSchema`. Present only while online, for config-capable viewers. */
export interface NodeRuntime {
  startedAt: string;
  supervised: boolean;
  service: { manager: "launchd" | "systemd" | null; installed: boolean; definitionPath: string | null; state: string; pid: number | null; enabled: boolean | null; paneSafety: "keeps" | "kills" | "unknown" };
  configPath: string;
  logPath: string | null;
  logHint: string | null;
  tmuxPath: string | null;
  binaryPath: string;
}
export interface NodeDetail extends Node {
  shares?: NodeShare[];
  /** How the agent runs (online + config-capable viewers only) */
  runtime?: NodeRuntime;
}
```

`use-nodes.ts`:
```ts
/** `POST /api/nodes/:id/restart`. Invalidation is the waiter's job (the node goes offline first). */
export function useRestartNode(id: string) {
  return useMutation({
    mutationFn: (body: { force?: boolean }) => apiFetch<{ ok: true }>(`/api/nodes/${id}/restart`, { method: "POST", body: JSON.stringify(body) }),
  });
}
```

`hooks/use-node-restart-wait.ts`:
```ts
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import { NODE_QUERY_KEY, NODES_QUERY_KEY } from "@/lib/query-keys";
import type { NodeDetail } from "@/types/node";

export type RestartWaitOutcome = "idle" | "waiting" | "back" | "timeout";
const POLL_MS = 1500;
const TIMEOUT_MS = 60_000;

/**
 * After a node restart: poll the detail until the agent has gone away and
 * come back (a `runtime.startedAt` later than the one we started with), cap
 * at 60 s. Invalidates the node queries when done.
 */
export function useNodeRestartWait(id: string, startedAtBefore: string | undefined) {
  const qc = useQueryClient();
  const [outcome, setOutcome] = useState<RestartWaitOutcome>("idle");
  const began = useRef<number>(0);
  useEffect(() => {
    if (outcome !== "waiting") return;
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      try {
        const d = await apiFetch<NodeDetail>(`/api/nodes/${id}`);
        if (d.status === "online" && d.runtime && d.runtime.startedAt !== startedAtBefore) {
          setOutcome("back");
          void qc.invalidateQueries({ queryKey: [...NODE_QUERY_KEY, id] });
          void qc.invalidateQueries({ queryKey: NODES_QUERY_KEY });
          return;
        }
      } catch {
        // the node is on its way down or up; keep polling
      }
      if (Date.now() - began.current > TIMEOUT_MS) {
        setOutcome("timeout");
        return;
      }
      setTimeout(() => void tick(), POLL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
    };
  }, [outcome, id, startedAtBefore, qc]);
  return {
    outcome,
    waiting: outcome === "waiting",
    begin: () => {
      began.current = Date.now();
      setOutcome("waiting");
    },
    reset: () => setOutcome("idle"),
  };
}
```

`components/nodes/node-runtime-card.tsx` — a bordered card titled **Runtime**, a `<dl>` in the same idiom as the facts grid in `nodes_.$id.tsx:160-234`:
- *Up since* — `new Date(startedAt).toLocaleString()`
- *Supervised by* — `${manager} (pid ${pid})` + ` · starts at login` when `enabled`; or **Not supervised** when `!supervised`, with the muted sentence *Restart it where it was started.*
- *Agent binary*, *Config file*, *Data directory* (`node.dataDir` is not on the view; omit), *Log* (`logPath ?? logHint`, mono), *tmux* (path, or warning `Badge` "not found: this node accepts no launches").
- Below: **Restart agent** button (`variant="outline"`), `disabled={!runtime.supervised || waiting}`, `title` = the reason when disabled; a confirm dialog (reuse the project's `ConfirmDialog`/`AlertDialog` primitive used by the delete flow in `nodes.tsx`) with text *Restart the agent on devbox? Subshells running there keep running; the node is offline for a few seconds.* — when `paneSafety !== "keeps"` the text adds *This node's service definition will close every subshell running there.* and the confirm sends `{ force: true }`. On success `wait.begin()`; while waiting render *Restarting… waiting for devbox to come back.*; on `back` *Back.*; on `timeout` *The node has not come back. Check the agent on that machine.*; on a 409 render `err.message`.
- Return `null` when `!node.runtime`.

Mount in `nodes_.$id.tsx` after `<NodeKeyRotate … />`: `{n.kind === "agent" && <NodeRuntimeCard node={n} />}`.

- [ ] **Step 4: Run the web tests**

Run: `cd apps/server/web && bun test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/web/src/types/node.ts apps/server/web/src/hooks/use-nodes.ts apps/server/web/src/hooks/use-node-restart-wait.ts apps/server/web/src/components/nodes/node-runtime-card.tsx apps/server/web/src/routes/nodes_.\$id.tsx apps/server/web/src/components/__tests__/node-runtime-card.test.tsx
git commit -m "feat(web): node detail shows how the agent runs and can restart it"
```

---

## Phase C — SPA: the Service page, restart, About, desktop affordances

### Task 15: Types and hooks for the deployment view, logs and the restart waiter

**Files:**
- Create: `apps/server/web/src/types/server-deployment.ts`
- Create: `apps/server/web/src/hooks/use-server-deployment.ts`
- Create: `apps/server/web/src/hooks/use-server-logs.ts`
- Create: `apps/server/web/src/hooks/use-server-restart.ts`
- Modify: `apps/server/web/src/lib/query-keys.ts` (add `SERVER_DEPLOYMENT_QUERY_KEY`, `SERVER_LOGS_QUERY_KEY`)
- Test: `apps/server/web/src/hooks/__tests__/use-server-restart.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  export interface ServerDeployment { /* mirror of DeploymentViewSchema, Task 7 */ }
  export interface ServerConfigPatch { port?: number; host?: string; baseUrl?: string; trustedOrigins?: string[] }
  export function useServerDeployment(enabled: boolean): UseQueryResult<ServerDeployment>
  export function useUpdateServerConfig(): UseMutationResult<ServerDeployment & { warnings: string[] }, ApiError, ServerConfigPatch>
  export function useServerLogs(enabled: boolean, lines?: number): UseQueryResult<{ lines: {ts:string;level:string;message:string;data?:unknown}[]; file: string; bytes: number; capBytes: number }>
  export function useSetDebugLogging(): UseMutationResult<ServerDeployment, ApiError, boolean>   // PUT /api/admin/server/logging { debug }
  export type RestartOutcome = "idle" | "waiting" | "back" | "timeout";
  export function useServerRestart(): { outcome: RestartOutcome; error: string | null; resumeAt: string | null; restart(opts: { force?: boolean }): Promise<void>; reset(): void }
  ```

- [ ] **Step 1: Write the failing test for the waiter**

```tsx
// apps/server/web/src/hooks/__tests__/use-server-restart.test.tsx
import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { useServerRestart } from "@/hooks/use-server-restart";

const restore: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const undo of restore.splice(0)) undo();
});

/** Scripted fetch: the restart 202, then /api/meta/status answers as given per call. */
function stubFetch(statusAnswers: (() => Response)[]) {
  const original = globalThis.fetch;
  restore.push(() => {
    globalThis.fetch = original;
  });
  let i = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith("/api/admin/server/restart") && init?.method === "POST") {
      return new Response(JSON.stringify({ restarting: true, resumeAt: "http://localhost:3080" }), { status: 202, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/api/admin/status")) return (statusAnswers[Math.min(i++, statusAnswers.length - 1)] as () => Response)();
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof globalThis.fetch;
}
const statusWith = (bootedAt: string) => () =>
  new Response(JSON.stringify({ runtime: { bootedAt } }), { status: 200, headers: { "content-type": "application/json" } });
const down = () => {
  throw new TypeError("fetch failed");
};

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(["admin-status"], { runtime: { bootedAt: "2026-09-12T10:00:00.000Z" } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("useServerRestart", () => {
  it("waits through the outage and reports back once bootedAt changes", async () => {
    stubFetch([down, down, statusWith("2026-09-12T10:00:07.000Z")]);
    const { result } = renderHook(() => useServerRestart({ pollMs: 5, timeoutMs: 5000 }), { wrapper });
    await act(() => result.current.restart({}));
    expect(result.current.outcome).toBe("waiting");
    expect(result.current.resumeAt).toBe("http://localhost:3080");
    await waitFor(() => expect(result.current.outcome).toBe("back"));
  });
  it("times out when the server never answers with a new boot", async () => {
    stubFetch([statusWith("2026-09-12T10:00:00.000Z")]);
    const { result } = renderHook(() => useServerRestart({ pollMs: 5, timeoutMs: 40 }), { wrapper });
    await act(() => result.current.restart({}));
    await waitFor(() => expect(result.current.outcome).toBe("timeout"));
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/server/web && bun test src/hooks/__tests__/use-server-restart.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`types/server-deployment.ts` — the TypeScript mirror of `DeploymentViewSchema` (every field documented with the same one-liners), plus `ServerConfigPatch` and `ServerLogs`.

`lib/query-keys.ts`:
```ts
/** `GET /api/admin/server`. */
export const SERVER_DEPLOYMENT_QUERY_KEY = ["server-deployment"] as const;
/** `GET /api/admin/server/logs`. */
export const SERVER_LOGS_QUERY_KEY = ["server-logs"] as const;
```

`hooks/use-server-deployment.ts`:
```ts
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { SERVER_DEPLOYMENT_QUERY_KEY } from "@/lib/query-keys";
import type { ServerConfigPatch, ServerDeployment } from "@/types/server-deployment";

/** The deployment view, admin-only; `enabled` is the caller's confirmed admin flag (the /settings gate pattern). */
export function useServerDeployment(enabled: boolean) {
  return useQuery({
    queryKey: SERVER_DEPLOYMENT_QUERY_KEY,
    queryFn: () => apiFetch<ServerDeployment>("/api/admin/server"),
    enabled,
    refetchInterval: 15_000,
    staleTime: 10_000,
  });
}

/** `PATCH /api/admin/server/config`; the answer IS the fresh view, so it is written into the cache directly. */
export function useUpdateServerConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: ServerConfigPatch) =>
      apiFetch<ServerDeployment & { warnings: string[] }>("/api/admin/server/config", { method: "PATCH", body: JSON.stringify(patch) }),
    onSuccess: ({ warnings: _warnings, ...view }) => {
      qc.setQueryData(SERVER_DEPLOYMENT_QUERY_KEY, view);
    },
  });
}
```

`hooks/use-server-logs.ts` (also holds the toggle mutation):
```ts
/** `PUT /api/admin/server/logging`; the answer is the fresh view, written into the cache. */
export function useSetDebugLogging() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (debug: boolean) => apiFetch<ServerDeployment>("/api/admin/server/logging", { method: "PUT", body: JSON.stringify({ debug }) }),
    onSuccess: (view) => qc.setQueryData(SERVER_DEPLOYMENT_QUERY_KEY, view),
  });
}

export function useServerLogs(enabled: boolean, lines = 200) {
  return useQuery({
    queryKey: [...SERVER_LOGS_QUERY_KEY, lines],
    queryFn: () => apiFetch<ServerLogs>(`/api/admin/server/logs?lines=${lines}`),
    enabled,
    refetchInterval: 5_000,
    staleTime: 2_000,
  });
}
```

`hooks/use-server-restart.ts`:
```ts
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { ADMIN_STATUS_QUERY_KEY, type AdminStatus } from "@/hooks/use-admin-status";
import { apiFetch, errMessage } from "@/lib/api";
import { SERVER_DEPLOYMENT_QUERY_KEY } from "@/lib/query-keys";

export type RestartOutcome = "idle" | "waiting" | "back" | "timeout";

/**
 * Press → 202 → wait. The wait polls `/api/admin/status` directly (not
 * through the query cache, whose unbounded network retry is the offline
 * banner's business) until `runtime.bootedAt` differs from the value the
 * cache held before the press, or the cap passes. Then invalidates the
 * deployment and status queries so the page reflects the new boot.
 */
export function useServerRestart(opts: { pollMs?: number; timeoutMs?: number } = {}) {
  const pollMs = opts.pollMs ?? 1500;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const qc = useQueryClient();
  const [outcome, setOutcome] = useState<RestartOutcome>("idle");
  const [error, setError] = useState<string | null>(null);
  const [resumeAt, setResumeAt] = useState<string | null>(null);
  const cancelled = useRef(false);

  async function waitForNewBoot(before: string | undefined): Promise<void> {
    const began = Date.now();
    for (;;) {
      if (cancelled.current) return;
      try {
        const s = await apiFetch<AdminStatus>("/api/admin/status");
        if (s.runtime.bootedAt !== before) {
          setOutcome("back");
          void qc.invalidateQueries({ queryKey: ADMIN_STATUS_QUERY_KEY });
          void qc.invalidateQueries({ queryKey: SERVER_DEPLOYMENT_QUERY_KEY });
          return;
        }
      } catch {
        // down, or coming up: keep waiting
      }
      if (Date.now() - began > timeoutMs) {
        setOutcome("timeout");
        return;
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  return {
    outcome,
    error,
    resumeAt,
    async restart(body: { force?: boolean }): Promise<void> {
      setError(null);
      const before = qc.getQueryData<AdminStatus>(ADMIN_STATUS_QUERY_KEY)?.runtime.bootedAt;
      try {
        const res = await apiFetch<{ restarting: true; resumeAt: string }>("/api/admin/server/restart", { method: "POST", body: JSON.stringify(body) });
        setResumeAt(res.resumeAt);
        setOutcome("waiting");
        cancelled.current = false;
        void waitForNewBoot(before);
      } catch (err) {
        setError(errMessage(err, "The restart could not be requested"));
      }
    },
    reset() {
      cancelled.current = true;
      setOutcome("idle");
      setError(null);
    },
  };
}
```

`bootedAt` in `admin/status` is derived (`now - uptime*1000`) and so drifts by a second between reads; compare with a tolerance: treat "different" as `Math.abs(Date.parse(a) - Date.parse(b)) > 5000`. Apply that in `waitForNewBoot` and adjust the test's second answer accordingly (it already differs by 7 s).

- [ ] **Step 4: Run the test**

Run: `cd apps/server/web && bun test src/hooks/__tests__/use-server-restart.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/web/src/types/server-deployment.ts apps/server/web/src/hooks/use-server-deployment.ts apps/server/web/src/hooks/use-server-logs.ts apps/server/web/src/hooks/use-server-restart.ts apps/server/web/src/hooks/__tests__/use-server-restart.test.tsx apps/server/web/src/lib/query-keys.ts
git commit -m "feat(web): deployment, logs and restart hooks for the Service page"
```

---

### Task 16: The Service page — Service, Addresses, Locations, Server log cards

**Files:**
- Create: `apps/server/web/src/components/service/service-card.tsx`, `addresses-card.tsx`, `locations-card.tsx`, `server-log-card.tsx`, `restart-dialog.tsx`, `restart-strip.tsx`
- Create: `apps/server/web/src/routes/settings_.service.tsx`
- Modify: `apps/server/web/src/components/app-sidebar.tsx:91-100` (seventh child)
- Test: `apps/server/web/src/components/__tests__/addresses-card.test.tsx`, `apps/server/web/src/components/__tests__/service-card.test.tsx`; update `app-sidebar.test.ts` / `sidebar-nav.test.ts` expectations for the new child.

**Interfaces:**
- Consumes: Task 15 hooks; `FactCard`/`Fact` (`components/admin-status/fact-list.tsx`); `Badge`, `Button`, `Input`, `Label`, `Dialog` primitives from `components/ui/*`; `usePublicSettings`.
- Produces: `ServiceCard({ view, restart })`, `AddressesCard({ view, restart })`, `LocationsCard({ view })`, `ServerLogCard({ enabled })`, `RestartDialog({ open, onOpenChange, view, onConfirm })`, `RestartStrip({ view, restart })`.

- [ ] **Step 1: Write the failing tests**

```tsx
// apps/server/web/src/components/__tests__/addresses-card.test.tsx
import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AddressesCard } from "@/components/service/addresses-card";
import type { ServerDeployment } from "@/types/server-deployment";

const restore: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const undo of restore.splice(0)) undo();
});

function view(over: Partial<ServerDeployment["settings"]> = {}): ServerDeployment {
  const s = (saved: string, source: ServerDeployment["settings"]["HOST"]["source"] = "config.env") => ({ saved, source, running: saved });
  return {
    configEnv: { path: "/c/config.env", exists: true },
    settings: { SERVER_PORT: s("3080"), HOST: s("0.0.0.0"), APP_BASE_URL: s("http://localhost:3080"), DATABASE_PATH: s("/c/subshell.db"), TRUSTED_ORIGINS: s(""), ...over },
    restartRequired: false,
    authSecret: { state: "set", source: "config.env" },
    paths: { dataDir: "/c", database: "/c/subshell.db", logsDir: "/c/subshells", nodeArtifacts: "/c/node-artifacts", serverLog: "/c/logs/server.log" },
    service: { manager: "launchd", installed: true, definitionPath: "/p", state: "running", pid: 1, enabled: true, paneSafety: "keeps", logPath: "/l", logHint: null, supervised: true },
    restart: { available: true, reason: null },
    logging: { debug: false, source: "default", file: "/c/logs/server.log", capBytes: 204_800 },
    tmuxPath: "/t", mcp: null, mcpError: null, platform: "darwin", generatedAt: "2026-09-12T10:00:00.000Z",
  };
}
const noRestart = { outcome: "idle" as const, error: null, resumeAt: null, restart: async () => {}, reset: () => {} };

describe("AddressesCard", () => {
  it("renders a field set by the environment read-only with the reason", () => {
    const qc = new QueryClient();
    render(<QueryClientProvider client={qc}><AddressesCard view={view({ HOST: { saved: "127.0.0.1", source: "process env", running: "127.0.0.1" } })} restart={noRestart} /></QueryClientProvider>);
    const host = screen.getByLabelText("Bind address") as HTMLInputElement;
    expect(host.readOnly).toBe(true);
    expect(screen.getByText(/Set by the environment \(HOST\)/)).toBeTruthy();
  });
  it("PATCHes only the fields the person touched", async () => {
    const sent: unknown[] = [];
    const original = globalThis.fetch;
    restore.push(() => {
      globalThis.fetch = original;
    });
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ ...view({ SERVER_PORT: { saved: "3090", source: "config.env", running: "3080" } }), restartRequired: true, warnings: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof globalThis.fetch;
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    render(<QueryClientProvider client={qc}><AddressesCard view={view()} restart={noRestart} /></QueryClientProvider>);
    fireEvent.change(screen.getByLabelText("Port"), { target: { value: "3090" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(sent).toEqual([{ port: 3090 }]));
  });
});
```

```tsx
// apps/server/web/src/components/__tests__/service-card.test.tsx
// same `view` helper (export it from a test helper file `__tests__/helpers/deployment-view.ts` and import in both tests)
describe("ServiceCard", () => {
  it("says who supervises the process and offers Restart", () => {
    render(<ServiceCard view={view()} restart={noRestart} />);
    expect(screen.getByText(/Running under launchd as pid 1/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Restart server" }) as HTMLButtonElement).disabled).toBe(false);
  });
  it("disables Restart with the reason when not supervised", () => {
    const v = view();
    v.service.supervised = false;
    v.restart = { available: false, reason: "This server is not running under a service manager; restart it where you started it." };
    render(<ServiceCard view={v} restart={noRestart} />);
    expect((screen.getByRole("button", { name: "Restart server" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/not running under a service manager/)).toBeTruthy();
  });
  it("warns when the definition kills panes", () => {
    const v = view();
    v.service.paneSafety = "kills";
    render(<ServiceCard view={v} restart={noRestart} />);
    expect(screen.getByText(/close every running subshell/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/server/web && bun test src/components/__tests__/addresses-card.test.tsx src/components/__tests__/service-card.test.tsx`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the cards**

Common prop: `restart: ReturnType<typeof useServerRestart>`.

**`restart-dialog.tsx`** — a `Dialog` (from `@/components/ui/dialog`) with title *Restart the server?*, body *Running subshells keep running; open terminals reconnect in a few seconds.* When `view.service.paneSafety !== "keeps"` the body is instead *This server's service definition will close every running subshell. Reinstall the service definition to fix this, or restart anyway.* and the confirm button reads **Restart anyway** and sends `{ force: true }`. When `view.settings.APP_BASE_URL.saved`'s origin ≠ `window.location.origin`, add *The server will come back at* `<a href=saved>saved</a>`. Buttons: Cancel (ghost), Restart server (destructive-outline).

**`restart-strip.tsx`** — renders by `restart.outcome`: `waiting` → an amber strip *Restarting… waiting for the server to come back.* plus the resumeAt link when its origin differs from the page's; `back` → green *Back.* with a dismiss (×) calling `restart.reset()`; `timeout` → *The server has not come back. Check the service where it runs.* plus the link; `restart.error` → the message in `text-destructive`.

**`service-card.tsx`**:
```tsx
export function ServiceCard({ view, restart }: { view: ServerDeployment; restart: ReturnType<typeof useServerRestart> }) {
  const [confirm, setConfirm] = useState(false);
  const s = view.service;
  const since = /* AdminStatus.runtime.bootedAt is not on this view; read it from useAdminStatus(true).data?.runtime.bootedAt when available, else omit "since …" */;
  const line = s.supervised
    ? `Running under ${s.manager} as pid ${s.pid}${since ? ` since ${since}` : ""}${s.enabled ? " · starts at login" : ""}`
    : "Running, not supervised";
  return (
    <FactCard title="Service">
      <p className="col-span-full text-sm">{line}</p>
      {!s.supervised && view.restart.reason && <p className="col-span-full text-muted-foreground text-sm">{view.restart.reason}</p>}
      {s.paneSafety !== "keeps" && (
        <p className="col-span-full text-sm text-warning">Restarting will close every running subshell; reinstall the service definition to fix this.</p>
      )}
      <div className="col-span-full flex items-center gap-3">
        <Button variant="outline" disabled={!view.restart.available || restart.outcome === "waiting"} title={view.restart.available ? undefined : (view.restart.reason ?? undefined)} onClick={() => setConfirm(true)}>
          Restart server
        </Button>
      </div>
      <RestartStrip view={view} restart={restart} />
      <RestartDialog open={confirm} onOpenChange={setConfirm} view={view} onConfirm={(force) => { setConfirm(false); void restart.restart(force ? { force: true } : {}); }} />
    </FactCard>
  );
}
```

**`addresses-card.tsx`** — four labelled `Input`s (labels exactly: **Port**, **Bind address**, **Public base URL**, **Other addresses browsers will use**), seeded from `settings[KEY].saved` while untouched (the `InstanceNameCard` seeding rule: a late load never clobbers typing); `TRUSTED_ORIGINS` shown comma-joined and split on save. A field whose `source === "process env"` is `readOnly` with the sentence *Set by the environment (`HOST`); change it there.* under it. `problems[].reason` render under their field. Passkey note under Public base URL: *Changing this moves where passkeys work.* **Save** button PATCHes only touched fields (`{ port: Number(...) }`, `host`, `baseUrl`, `trustedOrigins: string[]`); `CONFIG_INVALID` (400) renders `err.message` under the form; success renders `warnings` as a list and re-seeds from the answer. Above the form, when `view.restartRequired`, a strip *Saved. Restart the server to apply.* with a **Restart** button that opens the same `RestartDialog` — this strip is driven by the VIEW, so a hand edit shows it too.

**`locations-card.tsx`** — `FactCard title="Locations"` with mono `Fact`s: Config file (`view.configEnv.path` + muted *missing* when `!exists`), Data directory, Database, Pane logs, Node artifacts, Service definition (`definitionPath ?? "not installed"`), Server log (`paths.serverLog`), Service manager log (`service.logPath ?? service.logHint ?? "—"`). Each value has a small copy button (reuse the copy affordance `SystemApiKeysCard` uses for the one-time key, if there is one; else a `Button variant="ghost" size="icon"` calling `navigator.clipboard.writeText`).

**`server-log-card.tsx`** — takes `view` and `enabled`; `useServerLogs(enabled)`; header row: title **Server log**, muted *last 200 lines · 200 KB cap, replaced when full · refreshes every 5 s*, a **Refresh** button, and a **Debug logging** `Switch` bound to `view.logging.debug` → `useSetDebugLogging().mutate(checked)`; while `view.logging.source === "process env"` the switch is replaced by the sentence *Set by the environment (`SUBSHELL_DEBUG_LOGGING`).* Under the header: *Debug logging writes every request to the log file.* A `<pre>` capped at `max-h-96 overflow-auto` in mono 12px, one line per entry `HH:MM:SS level message` (+ ` data` JSON when present) with `text-destructive` for `error`/`fatal`, `text-warning` for `warn`, muted for `debug`/`trace`; sticks to the bottom only if it was at the bottom before the refetch (the console's rule). Footer: `view.paths.serverLog` mono with a copy button.

**`routes/settings_.service.tsx`** — copy `settings_.status.tsx`'s shape: `createFileRoute("/settings/service")`, `usePublicSettings` gate, `useServerDeployment(viewerIsAdmin === true)`, `useServerRestart()`, Refresh inside the admin branch, error banner, then `<ServiceCard/> <AddressesCard/> <LocationsCard/> <ServerLogCard view={view} enabled={viewerIsAdmin === true}/>`, and the snapshot stamp. Page title **Service**, subtitle *Where this server listens, who supervises it, where it writes, and what it logged.*

**Sidebar** — in `NAV_ENTRIES` children, after Plugins and before Status: `{ to: "/settings/service", label: "Service", icon: Power, short: "Svc" }` (import `Power` from lucide-react). Update `app-sidebar.test.ts` / `sidebar-nav.test.ts` counts and lists.

- [ ] **Step 4: Run the web tests and type-check**

Run: `cd apps/server/web && bun test && cd ../../.. && bun run verify-types && bun run lint:check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/web/src/components/service apps/server/web/src/routes/settings_.service.tsx apps/server/web/src/components/app-sidebar.tsx apps/server/web/src/components/__tests__
git commit -m "feat(web): Server Settings → Service — addresses, supervision, locations, log, restart"
```

---

### Task 17: About dialog for everyone

**Files:**
- Create: `apps/server/web/src/components/about-dialog.tsx`
- Modify: `apps/server/web/src/components/user-menu.tsx:84-102` (add **About Subshell** item + `onAbout` prop)
- Modify: `apps/server/web/src/components/app-sidebar.tsx:578-585` (hold dialog state, pass `onAbout`)
- Test: `apps/server/web/src/components/__tests__/about-dialog.test.tsx`

**Interfaces:**
- Consumes: `COPYRIGHT_LINE`, `LICENSE_SUMMARY`, `LICENSE_URL`, `PRODUCT_URL`, `COMPANY_URL`, `COPYRIGHT_HOLDER`, `PRODUCT_NAME` from `@internal/subshell-protocol` (`legal.ts`); `usePublicSettings` (`instanceName`, `serverVersion`); `desktopShell()`.
- Produces: `AboutDialog({ open, onOpenChange })`; `UserMenuProps.onAbout: () => void`.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/server/web/src/components/__tests__/about-dialog.test.tsx
import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { AboutDialog } from "@/components/about-dialog";
import { resetDesktopShellForTests } from "@/lib/desktop";

function renderAbout(ua: string) {
  Object.defineProperty(globalThis.navigator, "userAgent", { value: ua, configurable: true });
  resetDesktopShellForTests();
  const qc = new QueryClient();
  qc.setQueryData(["settings-public"], { allowRegistrations: false, emergencyLoginActive: false, instanceName: "Prod plane", appBaseUrl: "http://localhost:3080", viewerIsAdmin: false, serverVersion: "0.2.0", nodeArtifactTargets: [], nodeArtifactsAutoFetch: true });
  render(<QueryClientProvider client={qc}><AboutDialog open onOpenChange={() => {}} /></QueryClientProvider>);
}
afterEach(() => {
  cleanup();
  resetDesktopShellForTests();
});

describe("AboutDialog", () => {
  it("names the instance and the server version, with the licence and links, in a browser", () => {
    renderAbout("Mozilla/5.0");
    expect(screen.getByText("Prod plane")).toBeTruthy();
    expect(screen.getByText(/Server 0\.2\.0/)).toBeTruthy();
    expect(screen.queryByText(/Subshell Server 0\./)).toBeNull();
    expect(screen.getByRole("link", { name: "Licence" })).toBeTruthy();
  });
  it("adds the desktop shell's version under the marker", () => {
    renderAbout("Mozilla/5.0 SubshellDesktop/0.2.0 (macos; p=1)");
    expect(screen.getByText(/Subshell Server 0\.2\.0/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/server/web && bun test src/components/__tests__/about-dialog.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`about-dialog.tsx`: a `Dialog` with the brand mark (the wordmark asset the sidebar already renders), `instanceName` as the heading, lines *Server {serverVersion}* and, when `desktopShell()` is non-null, *Subshell Server {shell.version}*; `LICENSE_SUMMARY`; a link row **Website** (`PRODUCT_URL`), **Licence** (`LICENSE_URL`), `COPYRIGHT_HOLDER` (`COMPANY_URL`), all `target="_blank" rel="noreferrer"`; `COPYRIGHT_LINE` muted. No admin gate.

`user-menu.tsx`: add prop `onAbout: () => void` and, after **Account settings**, `<DropdownMenuItem onSelect={onAbout}><Info className="h-4 w-4" /> About Subshell</DropdownMenuItem>`.

`app-sidebar.tsx`: `const [aboutOpen, setAboutOpen] = useState(false);` pass `onAbout={() => setAboutOpen(true)}`; render `<AboutDialog open={aboutOpen} onOpenChange={setAboutOpen} />` beside `UserMenu`. Update any `UserMenu` test to pass `onAbout`.

- [ ] **Step 4: Run tests**

Run: `cd apps/server/web && bun test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/web/src/components/about-dialog.tsx apps/server/web/src/components/user-menu.tsx apps/server/web/src/components/app-sidebar.tsx apps/server/web/src/components/__tests__/about-dialog.test.tsx
git commit -m "feat(web): About Subshell, for everyone, from the user menu"
```

---

### Task 18: Desktop affordances in the SPA — `b=` in the marker, the pill, the reset card, the Update card

**Files:**
- Modify: `apps/server/web/src/lib/desktop.ts:26-64` (`DesktopShell.bundledServer?`, MARKER, `parseDesktopUA`)
- Modify: `apps/server/web/src/components/desktop/desktop-server-pill.tsx`
- Modify: `apps/server/web/src/components/settings/reset-card.tsx:42`
- Create: `apps/server/web/src/components/service/update-card.tsx`
- Modify: `apps/server/web/src/routes/settings_.service.tsx` (mount `UpdateCard` first when it applies)
- Test: `apps/server/web/src/lib/__tests__/desktop.test.ts` (append), `apps/server/web/src/components/__tests__/update-card.test.tsx`

**Interfaces:**
- Consumes: `semverLt` from `@internal/subshell-protocol` (the version helper the protocol package exports; `crates/desktop-core/src/version.rs` mirrors it).
- Produces: `DesktopShell.bundledServer?: string`; `updateAvailable(shell, serverVersion): string | null`; the invoke name `desktop_open_assistant` everywhere the SPA used `desktop_open_console`.

- [ ] **Step 1: Write the failing tests**

Append to `desktop.test.ts`:
```ts
it("reads the optional bundled-server group and tolerates its absence", () => {
  expect(parseDesktopUA("X SubshellDesktop/0.2.0 (macos; p=1; b=0.3.0)")).toEqual({ version: "0.2.0", platform: "macos", protocol: 1, bundledServer: "0.3.0" });
  expect(parseDesktopUA("X SubshellDesktop/0.2.0 (linux; p=1)")).toEqual({ version: "0.2.0", platform: "linux", protocol: 1 });
});
```

```tsx
// apps/server/web/src/components/__tests__/update-card.test.tsx
import { describe, expect, it } from "bun:test";
import { updateAvailable } from "@/components/service/update-card";

describe("updateAvailable", () => {
  it("names the bundled version only when it is newer than the running server", () => {
    expect(updateAvailable({ version: "0.2.0", platform: "macos", protocol: 1, bundledServer: "0.3.0" }, "0.2.0")).toBe("0.3.0");
    expect(updateAvailable({ version: "0.2.0", platform: "macos", protocol: 1, bundledServer: "0.2.0" }, "0.2.0")).toBeNull();
    expect(updateAvailable({ version: "0.2.0", platform: "macos", protocol: 1 }, "0.2.0")).toBeNull();
    expect(updateAvailable(null, "0.2.0")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/server/web && bun test src/lib/__tests__/desktop.test.ts src/components/__tests__/update-card.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

`desktop.ts`:
```ts
const MARKER = /\bSubshellDesktop\/(\S+)\s+\((macos|linux);\s*p=(\d+)(?:;\s*b=([0-9A-Za-z.+-]+))?\)/;
export interface DesktopShell { version: string; platform: DesktopPlatform; protocol: number; /** The server version the shell bundles (spec 2026-09-12 § 5.4); absent from older shells. */ bundledServer?: string }
// in parseDesktopUA:
return { version: m[1] as string, platform: m[2] as DesktopPlatform, protocol, ...(m[4] ? { bundledServer: m[4] } : {}) };
```

`update-card.tsx`:
```tsx
import { semverLt } from "@internal/subshell-protocol";
import { Button } from "@/components/ui/button";
import { type DesktopShell, desktopInvoke, desktopShell } from "@/lib/desktop";

/** The bundled version when it is newer than the running server, else null. Pure, for the test. */
export function updateAvailable(shell: DesktopShell | null, serverVersion: string | undefined): string | null {
  if (!shell?.bundledServer || !serverVersion) return null;
  return semverLt(serverVersion, shell.bundledServer) ? shell.bundledServer : null;
}

/** Desktop only: the shell bundles a newer server. The press names a SCREEN; the update itself is a press inside the bundled page. */
export function UpdateCard({ serverVersion }: { serverVersion: string | undefined }) {
  const next = updateAvailable(desktopShell(), serverVersion);
  if (!next) return null;
  return (
    <div className="rounded-lg border p-4">
      <p className="text-sm">Subshell Server includes server {next}; this instance is running {serverVersion}.</p>
      <Button className="mt-3" onClick={() => void desktopInvoke("desktop_open_assistant", { screen: "update" })}>Update…</Button>
    </div>
  );
}
```
Mount `<UpdateCard serverVersion={publicSettings?.serverVersion} />` at the top of the Service page's admin branch.

`reset-card.tsx:42`: `desktopInvoke("desktop_open_assistant", { screen: "reset" })`.

`desktop-server-pill.tsx`: take `viewerIsAdmin` from `usePublicSettings()`; `onClick`: when `offline` → `void desktopInvoke("desktop_open_assistant")`; else when admin → `navigate({ to: "/settings/service" })`; else no-op (render as a non-button `div` in that case). Titles: *Server running: open Service settings* / *Server unreachable: open the recovery assistant*.

- [ ] **Step 4: Run tests and lint**

Run: `cd apps/server/web && bun test && cd ../../.. && bun run verify-types && bun run lint:check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/web/src/lib/desktop.ts apps/server/web/src/lib/__tests__/desktop.test.ts apps/server/web/src/components/desktop/desktop-server-pill.tsx apps/server/web/src/components/settings/reset-card.tsx apps/server/web/src/components/service/update-card.tsx apps/server/web/src/components/__tests__/update-card.test.tsx apps/server/web/src/routes/settings_.service.tsx
git commit -m "feat(web): desktop deep links name the assistant; the shell advertises its bundled server"
```

---

## Phase D — Subshell Server, the app: dashboard-first boot, the assistant, no console

Order matters here: the Rust side changes first (so the app still builds with the old pages), then the assistant's TypeScript, then the console is deleted and the ACL pinned.

### Task 19: Rust — `boot_window` picks the dashboard when ready; `open_home`; `desktop_open_assistant`

**Files:**
- Modify: `apps/server/desktop/src-tauri/src/control.rs:342-357` (`WindowChoice`, `boot_window`), `:1295-1302` (`desktop_open_console` → `desktop_open_assistant`), `:1005-1024` (`open_main_now` unchanged), tests `:1733-1749`
- Modify: `apps/server/desktop/src-tauri/src/windows.rs:183-202` (`open_manage_window` → `open_assistant`)
- Modify: `apps/server/desktop/src-tauri/src/lib.rs:53-61`, `:96-118`, `:155-166`, `:188-197`
- Modify: `apps/server/desktop/src-tauri/src/reset.rs:117-140`, `:318-337`
- Modify: `apps/server/desktop/src-tauri/src/tray.rs:145-186`, `menu.rs:136-150`

**Interfaces:**
- Produces (Rust):
  ```rust
  pub enum WindowChoice { Wizard, Main }
  pub fn boot_window(p: &Probe) -> WindowChoice           // Ready → Main, else Wizard
  pub fn open_home(app: &AppHandle) -> Result<(), String>  // fresh probe: ready → open_main_now, else open_assistant(None)
  pub fn desktop_open_assistant(app: AppHandle, screen: Option<String>) -> Result<(), String>
  // windows.rs
  pub fn open_assistant(app: &AppHandle) -> Result<WebviewWindow, String>  // = open_wizard, renamed; closes nothing
  ```
  `open_manage_window`, `open_console`, `tuck_console` are deleted. `reset::arm_and_raise(app, screen)` targets the `wizard` window and emits `desktop-screen` on it.

- [ ] **Step 1: Rewrite the boot test to its stronger claim**

Replace `boot_window_picks_console_on_a_ready_probe_even_before_marking` (control.rs:1733-1749) with:

```rust
    #[test]
    fn boot_window_opens_the_dashboard_on_a_ready_probe_and_the_assistant_otherwise() {
        // Spec 2026-09-12 § 5.2: a machine set up entirely from the CLI opens
        // the DASHBOARD on its first app launch, because the first probe
        // answers ready. `onboarded` no longer decides the window at all — it
        // decides which family of assistant screens a not-ready machine sees.
        let ready = Probe { next: ProbeStep::Ready, onboarded: true, ..Probe::default() };
        assert_eq!(boot_window(&ready), WindowChoice::Main);
        let stopped = Probe { next: ProbeStep::Start, onboarded: true, ..Probe::default() };
        assert_eq!(boot_window(&stopped), WindowChoice::Wizard);
        let virgin = Probe { next: ProbeStep::Setup, onboarded: false, ..Probe::default() };
        assert_eq!(boot_window(&virgin), WindowChoice::Wizard);
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/server/desktop/src-tauri && cargo test boot_window 2>&1 | tail -20` (a real sidecar must be staged or `bun run rust:check` used; the latter stages a stub — prefer `bun run rust:check` from the repo root if `cargo test` dies in the build script)
Expected: FAIL — `WindowChoice::Main` does not exist.

- [ ] **Step 3: Implement**

`control.rs`:
```rust
/// Which window boot opens, as a pure decision over the POST-MARK probe.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowChoice {
    Wizard,
    Main,
}

/// Ready → the dashboard; anything else → the assistant, whose page picks
/// first-run or recovery screens by `onboarded` (spec 2026-09-12 § 5.2).
pub fn boot_window(p: &Probe) -> WindowChoice {
    if p.next == ProbeStep::Ready {
        WindowChoice::Main
    } else {
        WindowChoice::Wizard
    }
}

/// THE opener every tray item, Dock reopen, single-instance relaunch, menu
/// fallback and SPA pill goes through: a fresh probe, then the dashboard if
/// the server is ready, else the assistant. One function, so no two openers
/// can disagree about which window this machine gets (spec § 5.5).
pub fn open_home(app: &AppHandle) -> Result<(), String> {
    let settings = app.state::<SettingsState>();
    let p = probe_now(settings.get().binary_path.as_deref());
    crate::tray::set_server_ready(app, p.next == ProbeStep::Ready);
    if p.next == ProbeStep::Ready {
        if !settings.get().onboarded {
            mark_onboarded(p.next, &settings);
        }
        open_main_now(app)
    } else {
        crate::windows::open_assistant(app).map(|_| ())
    }
}

/// Raise the assistant, optionally at a named screen (`reset` | `update`).
/// Called from the SPA's pill (no screen: the recovery screen for whatever
/// the probe says) and from its danger/update cards. The argument names a
/// SCREEN, never a command: raising `update` performs one read-only probe,
/// and the update itself is a press inside the bundled page.
#[tauri::command(async)]
pub fn desktop_open_assistant(app: AppHandle, screen: Option<String>) -> Result<(), String> {
    crate::reset::arm_and_raise(&app, screen)
}
```
Delete `desktop_open_console`.

`desktop_logs` (control.rs `file_tail`/`journal_tail`): read `status.paths.serverLog` from the fresh probe FIRST, on every platform — the server now writes one capped JSON-lines file (spec § 3.4); render each line as `HH:MM:SS level message`. Fall back to the existing launchd-file / journal tail only when `paths.serverLog` is absent (an older server binary) or the file does not exist yet. `source` names which was read.

`windows.rs`: rename `open_wizard` → `open_assistant` (keep the body; title stays "Set Up Subshell Server" only while `!onboarded` — pass the title in: `"Subshell Server"` when onboarded, since the recovery screen is not a setup). Delete `open_manage_window`, `open_console`, `tuck_console`, the `CONSOLE_*` constants, and every `tuck_console(app)` call in `open_main` (lines 225, 297). In `open_main`'s existing-window branch keep `navigate` + `raise`. In `open_main`, after building the window, close the `wizard` if present (this was in `open_main_now`; keep it there — one place).

`reset.rs::arm_and_raise`: parse the screen as today (`Screen::Reset`; add `Screen::Update` to the enum and `parse_screen`); stash the plan only for `Reset`; then `let existed = app.get_webview_window("wizard").is_some(); crate::windows::open_assistant(app)?;` and if `existed`, emit `desktop-screen` on the `wizard` window. Move the `on_page_load` stash delivery from the deleted `open_console` into `open_assistant`'s builder (same closure, `window.emit("desktop-screen", …)`). End of the reset chain (`:318-337`): close `main`; keep the assistant standing (it is the window the chain runs in — do not close it, do not reopen it); the `Err(e)` arm goes away since nothing is opened. Emit `desktop-screen` = `"setup"` on the wizard so its page re-renders onto the first-run screens (the page also re-probes and sees `onboarded: false`).

`lib.rs`: `generate_handler!` — replace `control::desktop_open_console` with `control::desktop_open_assistant`. Setup: `match choice { WindowChoice::Wizard => { windows::open_assistant(&handle)?; } WindowChoice::Main => { if let Err(e) = control::open_main_now(&handle) { eprintln!("subshell: could not open the dashboard: {e}"); windows::open_assistant(&handle)?; } } }`. Single-instance and Dock `Reopen` handlers: drop the `console` fallbacks; when no window exists call `let _ = control::open_home(app);`. The `ExitRequested` guard's `get_webview_window("main").is_some()` stays.

`tray.rs::on_menu` / `show_main` / `open_dashboard` and `menu.rs::on_event`'s fallback: every `open_manage_window` call becomes `crate::control::open_home(app)`; `"console"` item ids are removed (Task 20 rebuilds the menus).

- [ ] **Step 4: Rust check**

Run: `bun run rust:check`
Expected: fmt clean, clippy clean, tests pass (the page still calls `desktop_open_console` at this point — that is a runtime refusal, not a compile error, and Task 21/22 fix the page; do not ship between tasks).

- [ ] **Step 5: Commit**

```bash
git add apps/server/desktop/src-tauri/src
git commit -m "feat(desktop-server): boot opens the dashboard when the server is ready; one opener for every route home"
```

---

### Task 20: Rust — the `watch` thread, the tray check item, the menu

**Files:**
- Create: `apps/server/desktop/src-tauri/src/watch.rs`
- Modify: `apps/server/desktop/src-tauri/src/control.rs` (`ACTION_IN_FLIGHT`, held by `desktop_setup`, `desktop_service`, `desktop_install_server`, `desktop_install_tmux`, `reset::desktop_reset`; delete `desktop_settings`, `desktop_set_close_to_tray`, `desktop_init`, `desktop_open_control_plane`, `DesktopSettings`, `settings_view`)
- Modify: `apps/server/desktop/src-tauri/src/tray.rs` (menu: Open Subshell Server / Keep Running… check / Quit)
- Modify: `apps/server/desktop/src-tauri/src/menu.rs:64` (remove "Manage server…")
- Modify: `apps/server/desktop/src-tauri/src/lib.rs` (spawn the watch after the boot window; register the handler list)
- Modify: `apps/server/desktop/src-tauri/src/windows.rs:32-36` (`user_agent` gains `b=`)

**Interfaces:**
- Produces:
  ```rust
  // watch.rs
  pub fn spawn(app: AppHandle)                                  // 5 s loop
  pub fn origin_changed(current: Option<&str>, probe: &Probe) -> Option<String>  // pure: Some(new origin) when main should navigate
  // control.rs
  pub static ACTION_IN_FLIGHT: AtomicBool;
  pub struct ActionGuard;  // RAII: sets on new(), clears on drop
  // tray.rs
  pub fn set_close_to_tray_checked(app: &AppHandle, on: bool)
  // windows.rs
  pub fn user_agent(app: &AppHandle) -> String  // "SubshellDesktop/{ver} ({platform}; p=1; b={bundled})" when a server is bundled, no `; b=` otherwise
  ```

- [ ] **Step 1: Write the failing tests (pure functions)**

In `watch.rs`'s `#[cfg(test)]`:
```rust
    #[test]
    fn origin_changed_only_when_ready_and_different() {
        let mut p = Probe { next: ProbeStep::Ready, ..Probe::default() };
        p.status = Some(serde_json::json!({
            "listen": { "portValid": true, "port": 3090 },
            "settings": { "APP_BASE_URL": { "value": "http://localhost:3090" } }
        }));
        assert_eq!(origin_changed(Some("http://localhost:3080"), &p), Some("http://localhost:3090".to_string()));
        assert_eq!(origin_changed(Some("http://localhost:3090"), &p), None);
        assert_eq!(origin_changed(None, &p), None); // no window: nothing to re-point
        p.next = ProbeStep::Start;
        assert_eq!(origin_changed(Some("http://localhost:3080"), &p), None); // not ready: leave the window alone
    }
```
In `windows.rs` tests:
```rust
    #[test]
    fn user_agent_carries_the_bundled_server_version_when_there_is_one() {
        assert_eq!(user_agent_for("0.2.0", "macos", Some("0.3.0")), "SubshellDesktop/0.2.0 (macos; p=1; b=0.3.0)");
        assert_eq!(user_agent_for("0.2.0", "linux", None), "SubshellDesktop/0.2.0 (linux; p=1)");
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `bun run rust:check`
Expected: FAIL to compile (missing items).

- [ ] **Step 3: Implement**

`windows.rs`:
```rust
/// Pure body of `user_agent`, for the test. `b=` is the server this app bundles (spec 2026-09-12 § 5.4).
pub fn user_agent_for(version: &str, platform: &str, bundled: Option<&str>) -> String {
    match bundled {
        Some(b) => format!("SubshellDesktop/{version} ({platform}; p=1; b={b})"),
        None => format!("SubshellDesktop/{version} ({platform}; p=1)"),
    }
}
pub fn user_agent(app: &AppHandle) -> String {
    let version = app.package_info().version.to_string();
    let platform = if cfg!(target_os = "macos") { "macos" } else { "linux" };
    user_agent_for(&version, platform, crate::control::bundled_version().as_deref())
}
```

`control.rs`:
```rust
/// Set while a native action (setup, service verb, install, reset) runs, so
/// the watch thread does not probe mid-chain and report a half state.
pub static ACTION_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

/// RAII holder for `ACTION_IN_FLIGHT`.
pub struct ActionGuard;
impl ActionGuard {
    pub fn new() -> Self {
        ACTION_IN_FLIGHT.store(true, Ordering::SeqCst);
        ActionGuard
    }
}
impl Drop for ActionGuard {
    fn drop(&mut self) {
        ACTION_IN_FLIGHT.store(false, Ordering::SeqCst);
    }
}
```
Add `let _guard = ActionGuard::new();` as the first line of `desktop_setup`, `desktop_service`, `desktop_install_server`, `desktop_install_tmux`, and `reset::desktop_reset`. Delete `desktop_settings`, `desktop_set_close_to_tray`, `DesktopSettings`, `settings_view`, `desktop_init`, `desktop_open_control_plane` (keep `close_to_tray_now`, `effective_close_to_tray` use, and `NO_TRAY` if the tray item's tooltip uses it; else delete `NO_TRAY`).

`watch.rs`:
```rust
//! The poll that used to live in the console page (spec 2026-09-12 § 5.2).
//!
//! Two duties, every five seconds, skipped while a native action runs:
//! keep the tray's "Open Subshell Server" enabled state honest, and re-point
//! `main` when the server's origin moved (a port changed from the SPA and
//! the server restarted). It never raises the assistant: a server that goes
//! away while the dashboard is open shows the SPA's own offline banner, and
//! the person reaches recovery through the pill, the tray or the Dock.
use std::sync::atomic::Ordering;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use crate::control::{ACTION_IN_FLIGHT, Probe, ProbeStep};

const PERIOD: Duration = Duration::from_secs(5);

/// The origin `main` should navigate to, when the probe is ready and it differs from the window's current one.
pub fn origin_changed(current: Option<&str>, probe: &Probe) -> Option<String> {
    let current = current?;
    if probe.next != ProbeStep::Ready {
        return None;
    }
    let next = probe.origin()?;
    let same = tauri::Url::parse(current).ok().map(|u| u.origin()) == tauri::Url::parse(&next).ok().map(|u| u.origin());
    if same { None } else { Some(next) }
}

pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(PERIOD);
        if ACTION_IN_FLIGHT.load(Ordering::SeqCst) {
            continue;
        }
        let settings = app.state::<subshell_desktop_core::settings::SettingsState>();
        let probe = crate::control::probe_now(settings.get().binary_path.as_deref());
        crate::tray::set_server_ready(&app, probe.next == ProbeStep::Ready);
        if let Some(w) = app.get_webview_window("main") {
            let current = w.url().ok().map(|u| u.to_string());
            if let Some(next) = origin_changed(current.as_deref(), &probe) {
                let _ = crate::windows::open_main(&app, &next); // its existing-window branch navigates
            }
        }
    });
}
```
`lib.rs` setup: after the boot window branch, `watch::spawn(handle.clone());`.

`tray.rs`: rebuild the menu:
```rust
    let open = MenuItem::with_id(app, "tray:open", "Open Subshell Server", true, None::<&str>)?;
    let keep_label = if cfg!(target_os = "macos") { "Keep Running in Menu Bar" } else { "Keep Running in Tray" };
    let keep = CheckMenuItem::with_id(app, "tray:keep", keep_label, true, control::close_to_tray_now(&app.state::<SettingsState>()), None::<&str>)?;
    app.manage(KeepItem(keep.clone()));
    let menu = Menu::with_items(app, &[&open, &PredefinedMenuItem::separator(app)?, &keep, &PredefinedMenuItem::separator(app)?, &PredefinedMenuItem::quit(app, None)?])?;
```
`on_menu`: `"tray:open" => { let _ = crate::control::open_home(app); }`, `"tray:keep" => { let on = keep_item(app).is_checked().unwrap_or(false); if on && !tray_support().supported() { let _ = keep_item(app).set_checked(false); return; } let _ = app.state::<SettingsState>().update(|s| s.close_to_tray = on); }`. `DashboardItem` becomes the `open` item (renamed `HomeItem`; `set_server_ready` keeps its name and now toggles nothing — the item is always enabled because `open_home` handles both states; keep the function as a no-op-with-comment or delete it and its callers). Left-click → `open_home`. `show_main`/`open_dashboard` deleted.

`menu.rs:64`: delete the "Manage server…" item and the `"console"` arm in `on_event`; the "no main window" fallback becomes `let _ = crate::control::open_home(app);`.

- [ ] **Step 4: Rust check**

Run: `bun run rust:check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/desktop/src-tauri/src
git commit -m "feat(desktop-server): a Rust watch keeps the tray and the dashboard's origin honest; tray preference lives in the tray"
```

---

### Task 21: The assistant's state — `screensFor(probe, onboarded)`, Recovery, Update, Reset

**Files:**
- Modify: `apps/server/desktop/ui/src/lib/wizard-state.ts:14-56`
- Test: `apps/server/desktop/ui/src/__tests__/wizard-state.test.ts` (append)

**Interfaces:**
- Produces:
  ```ts
  export type ScreenId = "welcome" | "tmux" | "setup" | "recovery" | "update" | "reset";
  export function screensFor(probe: Probe, onboarded: boolean): ScreenId[]   // first-run trio when !onboarded; ["recovery"] when onboarded && next !== "ready"; [] when ready
  export function recoveryTitle(step: ProbeStep, platform: string): string
  export function recoveryAction(step: ProbeStep): { label: string; kind: "choose-binary" | "retry" | "setup" | "install-service" | "start" } | null
  export function dots(probe, current): { total: 6; done: number; current: number }   // recovery/update/reset render NO dots: returns total 6 with done=current=-1 for them
  ```

- [ ] **Step 1: Write the failing tests**

```ts
describe("screensFor with onboarded", () => {
  const p = (next: Probe["next"], tmux: string | null = "/usr/bin/tmux"): Probe => ({ ...baseProbe, next, tmux });
  it("shows the first-run trio while not onboarded, tmux only when missing", () => {
    expect(screensFor(p("setup", null), false)).toEqual(["welcome", "tmux", "setup"]);
    expect(screensFor(p("setup"), false)).toEqual(["welcome", "setup"]);
  });
  it("shows exactly the recovery screen once onboarded and not ready", () => {
    for (const step of ["no-server", "unreachable", "init", "install-service", "start"] as const) {
      expect(screensFor(p(step), true)).toEqual(["recovery"]);
    }
  });
  it("shows nothing when ready (the page opens the dashboard)", () => {
    expect(screensFor(p("ready"), true)).toEqual([]);
    expect(screensFor(p("ready"), false)).toEqual([]);
  });
});

describe("recoveryTitle / recoveryAction", () => {
  it("names the step in the assistant's voice", () => {
    expect(recoveryTitle("no-server", "darwin")).toBe("No Server Found");
    expect(recoveryTitle("unreachable", "darwin")).toBe("Your Server Isn't Responding");
    expect(recoveryTitle("init", "linux")).toBe("Your Server Needs Its Configuration");
    expect(recoveryTitle("install-service", "linux")).toBe("Your Server Isn't Installed as a Service");
    expect(recoveryTitle("start", "darwin")).toBe("Your Server Is Stopped");
  });
  it("offers one primary action per step", () => {
    expect(recoveryAction("start")).toEqual({ label: "Start", kind: "start" });
    expect(recoveryAction("install-service")).toEqual({ label: "Install and Start", kind: "install-service" });
    expect(recoveryAction("init")).toEqual({ label: "Set Up", kind: "setup" });
    expect(recoveryAction("unreachable")).toEqual({ label: "Retry", kind: "retry" });
    expect(recoveryAction("no-server")).toEqual({ label: "Choose subshell-server…", kind: "choose-binary" });
    expect(recoveryAction("ready")).toBeNull();
    expect(recoveryAction("setup")).toEqual({ label: "Set Up", kind: "setup" });
  });
});
```
(`baseProbe` — the fixture the existing tests in this file already build; reuse it.)

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/server/desktop && bun run test`
Expected: FAIL — signature/type errors.

- [ ] **Step 3: Implement**

```ts
export type ScreenId = "welcome" | "tmux" | "setup" | "recovery" | "update" | "reset";
const FIRST_RUN: readonly ScreenId[] = ["welcome", "tmux", "setup"];

/**
 * The screens this machine will see (spec 2026-09-12 § 5.3). Before setup
 * has ever completed: the first-run trio (tmux only when missing). After:
 * the one recovery screen while the server is not ready, and nothing at all
 * when it is — the page opens the dashboard and this window closes. `update`
 * and `reset` are never in the list: they are entered by request
 * (`desktop-screen`) or from the recovery footer, over whatever is showing.
 */
export function screensFor(probe: Probe, onboarded: boolean): ScreenId[] {
  if (probe.next === "ready") return [];
  if (!onboarded) return FIRST_RUN.filter((s) => s !== "tmux" || probe.tmux === null);
  return ["recovery"];
}

export function recoveryTitle(step: ProbeStep, platform: string): string {
  const here = platform === "darwin" ? "this Mac" : "this machine";
  switch (step) {
    case "no-server":
      return "No Server Found";
    case "unreachable":
      return "Your Server Isn't Responding";
    case "init":
      return "Your Server Needs Its Configuration";
    case "install-service":
      return "Your Server Isn't Installed as a Service";
    case "start":
      return "Your Server Is Stopped";
    case "setup":
      return `Set Up Subshell on ${here}`;
    case "ready":
      return "Opening Your Dashboard…";
  }
}

export type RecoveryActionKind = "choose-binary" | "retry" | "setup" | "install-service" | "start";
export function recoveryAction(step: ProbeStep): { label: string; kind: RecoveryActionKind } | null {
  switch (step) {
    case "no-server":
      return { label: "Choose subshell-server…", kind: "choose-binary" };
    case "unreachable":
      return { label: "Retry", kind: "retry" };
    case "init":
    case "setup":
      return { label: "Set Up", kind: "setup" };
    case "install-service":
      return { label: "Install and Start", kind: "install-service" };
    case "start":
      return { label: "Start", kind: "start" };
    case "ready":
      return null;
  }
}
```
`dots`: for `recovery`/`update`/`reset` return `{ total: 6, done: -1, current: -1 }` and have the renderer hide the row when `current < 0`. Update the `ALL_SCREENS` constant used by `dots` to `FIRST_RUN`. Update every existing `screensFor(probe)` call in the tests to pass `false`.

- [ ] **Step 4: Run the desktop UI tests**

Run: `cd apps/server/desktop && bun run test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/desktop/ui/src/lib/wizard-state.ts apps/server/desktop/ui/src/__tests__/wizard-state.test.ts
git commit -m "feat(desktop-server): the assistant knows recovery, update and reset screens"
```

---

### Task 22: The assistant page — render Recovery, Update and Reset; move the console's reusable modules

**Files:**
- Create: `apps/server/desktop/ui/src/assistant/` — move `ui/src/console/{config-form-view,logs,tmux-warning,reset-view,result-strip}.ts` here (`git mv`), adapt their imports; they take an `AssistantHost` (`render`, `refresh`, `guard`, `fail`) instead of `ConsoleHost`.
- Modify: `apps/server/desktop/ui/src/wizard.ts` (screens + `desktop-screen` listener + the ready path)
- Modify: `apps/server/desktop/ui/wizard.html` (add `#details` disclosure markup and the reset takeover container if the reset view needs fixed markup)
- Modify: `apps/server/desktop/ui/src/lib/ipc.ts` (remove `init`, `settings`, `setCloseToTray`, `openConsole`, `openControlPlane`; add `openAssistant(screen?)`… actually the page never opens itself — remove `openConsole` entirely; keep `service`, `installServer`, `logs`, `openPath`, `armReset`, `reset`)
- Test: `apps/server/desktop/ui/src/__tests__/wizard-state.test.ts` already covers the decisions; add `ui/src/__tests__/recovery-render.test.ts` if the page exposes a pure `recoveryModel(probe, lastResult)` (recommended: extract the strings/rows the screen shows into `lib/recovery-model.ts` so it is testable without a DOM).

**Interfaces:**
- Consumes: Task 21 functions; `ipc.service(verb, force)`, `ipc.setup()`, `ipc.setServerBin(path)`, `ipc.logs()`, `ipc.installServer()`, `ipc.armReset()`, `ipc.reset(typed)`, `ipc.openMain()`, `ipc.probe()`.
- Produces: the page listens to `desktop-screen` events (`"reset" | "update" | "setup"`) via `@tauri-apps/api/event` `listen` (or `window.__TAURI__.event.listen`, whichever the page already uses for `desktop-screen` in `main.ts`) and switches screens.

- [ ] **Step 1: Move the modules**

```bash
cd apps/server/desktop/ui/src && mkdir -p assistant && git mv console/config-form-view.ts console/logs.ts console/tmux-warning.ts console/reset-view.ts console/result-strip.ts assistant/
```
Fix imports (`../console/state` → an `assistant/host.ts` that declares `AssistantHost` with the same four members the modules use: `render`, `refresh`, `guard(label, run)`, `fail(message)`; `goTo` is dropped — the assistant has no sidebar). `logs.ts` loses its two-tab shell: export `renderTail(container: HTMLElement, tail: LogTail)` and `renderOutput(container, result: ActionResult | null)`.

- [ ] **Step 2: Render the screens in `wizard.ts`**

Beside `renderWelcome`/`renderTmux`/`renderSetup`, add:

```ts
function renderRecovery(p: Probe): void {
  const action = recoveryAction(p.next);
  setTitle(recoveryTitle(p.next, p.platform), subtitleFor(p));
  const content = el("#content");
  content.replaceChildren();
  if (p.error) content.append(paragraph(p.error, "problem"));
  if (action) {
    const btn = primaryButton(action.label, () => runRecovery(action.kind, p));
    if (action.kind !== "retry" && action.kind !== "choose-binary") btn.dataset.tmux = "1";
    content.append(btn);
  }
  if (p.serverChoice === "upgrade-available") content.append(ghostButton(`Update Server to ${p.bundledVersion}…`, () => show("update")));
  content.append(tmuxWarning.render(p));
  content.append(detailsDisclosure(p, lastResult, lastTail));
  setBar({ left: ghostButton(`Reset ${here(p)}…`, () => show("reset")), right: null });
  hideDots();
}

function subtitleFor(p: Probe): string {
  switch (p.next) {
    case "no-server": return "No subshell-server was found, and this build does not ship one.";
    case "unreachable": return "A subshell-server was found, but it did not answer. Nothing has been changed.";
    case "init": return "The server has no config.env yet.";
    case "install-service": return "Configured, but not installed as a background service.";
    case "start": return "The service is installed but not running.";
    default: return "";
  }
}

async function runRecovery(kind: RecoveryActionKind, p: Probe): Promise<void> {
  switch (kind) {
    case "retry": return refresh();
    case "choose-binary": return chooseServerBinary();          // the existing dialog + ipc.setServerBin path
    case "setup": return runSetupChain(p);                       // the existing Set Up press (renderProgress)
    case "install-service": return guard("Install and Start", () => ipc.service("install", false));
    case "start": return guard("Start", () => ipc.service("start", false));
  }
}
```

`detailsDisclosure` renders a `<details>` with summary **Show Details**, holding the pre-boot facts (binary + rung, config.env path, service definition, manager state + detail, log location — the strings `console/facts.ts` produced; port that logic into `lib/recovery-model.ts` as `recoveryFacts(p): { label: string; value: string; tone?: "bad" }[]`), then `renderTail` of the last `ipc.logs()` (refreshed on each poll while the disclosure is open), then `renderOutput(lastResult)`.

```ts
function renderUpdate(p: Probe): void {
  setTitle("Update Your Server", `Subshell Server includes ${p.bundledVersion}; ${here(p)} is running ${p.server?.version ?? "an unknown version"}.`);
  const content = el("#content");
  content.replaceChildren();
  if (paneRisk(p)) content.append(paragraph("The installed service definition does not spare live panes, so this restart closes every subshell running here.", "warn"));
  content.append(primaryButton("Update and Restart", () => guard("Update", async () => {
    const installed = await ipc.installServer();
    if (!installed.ok) return installed;
    return ipc.service("restart", paneRisk(p));
  }).then(() => openWhenReady())));
  setBar({ left: ghostButton("Not Now", () => (app.getWebviewWindow ? void ipc.openMain() : show(defaultScreen()))), right: null });
  hideDots();
}
```
(`Not Now`: call `ipc.openMain()` — `open_main_now` closes the wizard; if the server is not ready that fails and the page falls back to `show(defaultScreen())`.)

`renderReset`: mount the moved `reset-view.ts` into `#content` (its `open()`/`cameFrom` returning to `defaultScreen()`).

`desktop-screen` listener (copy the `main.ts` wiring): `"reset"` → `resetView.open()` then `show("reset")`; `"update"` → `show("update")`; `"setup"` → `screen = null; render()`.

`render()`: `const list = screensFor(probe, probe.onboarded); if (list.length === 0) { openWhenReady(); return; }` and `screen ??= list[0]`; the `update`/`reset` screens render regardless of `list`. `openWhenReady()` stays as written (once).

The poll (`wizard.ts:455-490`) keeps its 1500 ms cadence and its "skip while an input is focused" rule; while the recovery screen's details disclosure is open it also refreshes `lastTail = await ipc.logs()`.

`ipc.ts`: delete `init`, `settings`, `setCloseToTray`, `openConsole`, `openControlPlane`, `InitPayload` if only `init` used it (keep it if `setup(payload)` does), `DesktopSettings`.

- [ ] **Step 3: Run the UI tests and type-check**

Run: `cd apps/server/desktop && bun run test && bun run build` (the UI's Vite build)
Expected: PASS; the build now fails on `index.html`/`main.ts` references only if they still import deleted ipc names — Task 23 removes them.

- [ ] **Step 4: Commit**

```bash
git add -A apps/server/desktop/ui
git commit -m "feat(desktop-server): the assistant renders recovery, update and reset screens"
```

---

### Task 23: Delete the console; pin the new ACL

**Files:**
- Delete: `apps/server/desktop/ui/index.html`, `apps/server/desktop/ui/src/main.ts`, `apps/server/desktop/ui/src/console/` (what remains: `state.ts`, `hero.ts`, `steps.ts`, `facts.ts`, `addresses.ts`, `settings.ts`, `about.ts`), `apps/server/desktop/ui/src/lib/console-nav.ts`, `apps/server/desktop/ui/src/__tests__/console-nav.test.ts`, `apps/server/desktop/src-tauri/capabilities/console.json`
- Modify: `apps/server/desktop/ui/vite.config.ts` (one rollup input: `wizard.html`; consider renaming to `index.html` — if you do, update `windows.rs::open_assistant`'s `WebviewUrl::App("wizard.html")` accordingly)
- Modify: `apps/server/desktop/src-tauri/permissions/desktop.toml` (delete `allow-desktop-init`, `allow-desktop-open-control-plane`, `allow-desktop-settings`, `allow-desktop-set-close-to-tray`, `allow-desktop-open-console`; add `allow-desktop-open-assistant`)
- Modify: `apps/server/desktop/src-tauri/capabilities/wizard.json` (permissions per spec § 5.6), `main.json` (`allow-desktop-open-assistant` replaces `allow-desktop-open-console`)
- Modify: `apps/server/desktop/ui/src/__tests__/ipc-acl.test.ts`
- Modify: `apps/server/desktop/ui/src/__tests__/tauri-config.test.ts` if it lists windows/capabilities

**Interfaces:**
- Produces the § 5.6 table exactly:
  - `wizard.json` permissions: `core:default`, `dialog:allow-open`, `dialog:allow-ask`, `opener:allow-reveal-item-in-dir`, `allow-desktop-probe`, `allow-desktop-setup`, `allow-desktop-install-tmux`, `allow-desktop-set-server-bin`, `allow-desktop-service`, `allow-desktop-install-server`, `allow-desktop-logs`, `allow-desktop-open-path`, `allow-desktop-arm-reset`, `allow-desktop-reset`, `allow-desktop-open-main`, `allow-desktop-open-tmux-docs`, `allow-desktop-about`, `allow-desktop-open-web`.
  - `main.json` permissions: `core:window:allow-start-dragging`, `allow-desktop-open-assistant`, `allow-desktop-shell-ready`, `allow-desktop-notify`.

- [ ] **Step 1: Update `ipc-acl.test.ts` first**

- The console page section goes away; the wizard page is `wizard.ts` + every module under `assistant/` + `lib/*` it imports.
- Assert `wizard.json`'s `allow-desktop-*` set equals the commands those files invoke.
- Assert `main.json` holds exactly three app commands: `desktop_open_assistant`, `desktop_shell_ready`, `desktop_notify`.
- Assert no file under `ui/src` mentions `desktop_open_console`, `desktop_init`, `desktop_settings`, `desktop_set_close_to_tray`, `desktop_open_control_plane`.
- Assert `capabilities/` contains exactly `wizard.json` and `main.json`.

Run: `cd apps/server/desktop && bun run test`
Expected: FAIL until the deletions below.

- [ ] **Step 2: Delete and rewire**

```bash
cd apps/server/desktop && git rm -r ui/index.html ui/src/main.ts ui/src/console ui/src/lib/console-nav.ts ui/src/__tests__/console-nav.test.ts src-tauri/capabilities/console.json
```
Edit `desktop.toml`, `wizard.json`, `main.json`, `vite.config.ts` per the table. In `desktop.toml` add:
```toml
[[permission]]
identifier = "allow-desktop-open-assistant"
description = "Raise the assistant window, optionally at the reset or update screen. Executes nothing: the update is a press inside the bundled page, and the reset needs the hostname typed there."
commands.allow = ["desktop_open_assistant"]
```
Remove `config-form.test.ts` only if `lib/config-form.ts` was deleted; it is still used by the first-run "Customize…" link, so it stays.

- [ ] **Step 3: Full verification including Rust and the app**

Run: `bun run rust:check && cd apps/server/desktop && bun run test && bun run build && cd ../../.. && bun run verify-types && bun run lint:check && bun run test`
Expected: PASS.

Then run the app once: `bun run dev:desktop-server`. On a machine with a running service it must open the dashboard directly; stop the service (`subshell-server service stop`) and click the sidebar pill: the assistant opens on *Your Server Is Stopped*; press Start; the assistant fades to *Opening your dashboard…* and the dashboard appears. Record the outcome in the commit body.

- [ ] **Step 4: Commit**

```bash
git add -A apps/server/desktop
git commit -m "feat(desktop-server): the console is gone; two windows, one assistant, the ACL pinned"
```

---

## Phase E — Subshell Client: the node window becomes an assistant

### Task 24: `node-assistant-state.ts` — which screen this machine sees

**Files:**
- Create: `apps/client/desktop/ui/src/lib/node-assistant-state.ts`
- Test: `apps/client/desktop/ui/src/__tests__/node-assistant-state.test.ts`

**Interfaces:**
- Consumes: `Probe`, `ProbeStep`, `NodeSettings` (`lib/ipc.ts`).
- Produces:
  ```ts
  export type NodeScreenId = "connect" | "install-agent" | "enroll" | "service" | "connected" | "reset";
  export function screenFor(probe: Probe | undefined, settings: NodeSettings | undefined, override: "enroll" | "reset" | null): NodeScreenId | null
  export function screenTitle(screen: NodeScreenId, probe: Probe | undefined, platform: string): string
  export function serviceAction(step: ProbeStep): { label: string; verb: "install" | "start" | "restart" } | null
  ```

- [ ] **Step 1: Write the failing test**

```ts
// apps/client/desktop/ui/src/__tests__/node-assistant-state.test.ts
import { describe, expect, it } from "bun:test";
import type { NodeSettings, Probe } from "@/lib/ipc";
import { screenFor, screenTitle, serviceAction } from "@/lib/node-assistant-state";

const settings = (planeUrl: string | null): NodeSettings => ({ planeUrl, agentBinPath: null, closeToTray: true, traySupported: true, trayStatus: "supported" }) as NodeSettings;
const probe = (step: Probe["step"]): Probe => ({ step, platform: "darwin" }) as unknown as Probe;

describe("screenFor", () => {
  it("asks for a server first, whatever the machine's state", () => {
    expect(screenFor(probe("online"), settings(null), null)).toBe("connect");
  });
  it("maps every probe step to one screen once a plane is known", () => {
    expect(screenFor(probe("no-agent"), settings("https://p"), null)).toBe("install-agent");
    expect(screenFor(probe("not-enrolled"), settings("https://p"), null)).toBe("enroll");
    for (const s of ["no-service", "stopped", "offline"] as const) expect(screenFor(probe(s), settings("https://p"), null)).toBe("service");
    expect(screenFor(probe("online"), settings("https://p"), null)).toBe("connected");
  });
  it("honours a user-chosen screen over the machine's", () => {
    expect(screenFor(probe("online"), settings("https://p"), "enroll")).toBe("enroll");
    expect(screenFor(probe("online"), settings("https://p"), "reset")).toBe("reset");
  });
  it("is null while nothing has been read yet", () => {
    expect(screenFor(undefined, undefined, null)).toBeNull();
  });
});

describe("serviceAction", () => {
  it("offers the one verb the step needs", () => {
    expect(serviceAction("no-service")).toEqual({ label: "Install and Start", verb: "install" });
    expect(serviceAction("stopped")).toEqual({ label: "Start", verb: "start" });
    expect(serviceAction("offline")).toEqual({ label: "Restart", verb: "restart" });
    expect(serviceAction("online")).toBeNull();
  });
});

describe("screenTitle", () => {
  it("speaks the assistant's voice", () => {
    expect(screenTitle("connect", undefined, "darwin")).toBe("Connect to a Server");
    expect(screenTitle("enroll", undefined, "darwin")).toBe("Enroll This Mac");
    expect(screenTitle("enroll", undefined, "linux")).toBe("Enroll This Machine");
    expect(screenTitle("service", probe("offline"), "darwin")).toBe("The Node Service Isn't Responding");
    expect(screenTitle("connected", undefined, "darwin")).toBe("This Mac Is a Node");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/client/desktop && bun run test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/client/desktop/ui/src/lib/node-assistant-state.ts
import type { NodeSettings, Probe, ProbeStep } from "@/lib/ipc";

/** The assistant's screens (spec 2026-09-12 § 6.4). One decision each. */
export type NodeScreenId = "connect" | "install-agent" | "enroll" | "service" | "connected" | "reset";

/**
 * Which screen this machine sees. A plane address comes first: without one
 * the app has nothing to show in its other window. Then the probe's own step,
 * unless the person asked for a screen the machine does not imply (re-enroll,
 * reset). Null while nothing has been read.
 */
export function screenFor(probe: Probe | undefined, settings: NodeSettings | undefined, override: "enroll" | "reset" | null): NodeScreenId | null {
  if (!settings) return null;
  if (!settings.planeUrl) return "connect";
  if (override) return override;
  if (!probe) return null;
  switch (probe.step) {
    case "no-agent":
      return "install-agent";
    case "not-enrolled":
      return "enroll";
    case "no-service":
    case "stopped":
    case "offline":
      return "service";
    case "online":
      return "connected";
  }
}

const here = (platform: string) => (platform === "darwin" ? "This Mac" : "This Machine");

export function screenTitle(screen: NodeScreenId, probe: Probe | undefined, platform: string): string {
  switch (screen) {
    case "connect":
      return "Connect to a Server";
    case "install-agent":
      return "Install the Agent";
    case "enroll":
      return `Enroll ${here(platform)}`;
    case "service":
      return probe?.step === "offline" ? "The Node Service Isn't Responding" : probe?.step === "stopped" ? "The Node Service Is Stopped" : "Start the Node Service";
    case "connected":
      return `${here(platform)} Is a Node`;
    case "reset":
      return `Reset ${here(platform)}`;
  }
}

export function serviceAction(step: ProbeStep): { label: string; verb: "install" | "start" | "restart" } | null {
  switch (step) {
    case "no-service":
      return { label: "Install and Start", verb: "install" };
    case "stopped":
      return { label: "Start", verb: "start" };
    case "offline":
      return { label: "Restart", verb: "restart" };
    default:
      return null;
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `cd apps/client/desktop && bun run test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/client/desktop/ui/src/lib/node-assistant-state.ts apps/client/desktop/ui/src/__tests__/node-assistant-state.test.ts
git commit -m "feat(desktop-client): the node window's screens, decided purely"
```

---

### Task 25: The assistant frame and the six screens replace the card page

**Files:**
- Create: `apps/client/desktop/ui/src/components/assistant/frame.tsx` (title, subtitle, 560px column, bottom bar; Tailwind, frame constants from Global Constraints), `connect-screen.tsx`, `install-agent-screen.tsx`, `enroll-screen.tsx`, `service-screen.tsx`, `connected-screen.tsx`, `details-disclosure.tsx`
- Modify: `apps/client/desktop/ui/src/app.tsx` (the frame host: `useNodeState`, `useNodeCommands`, `screenFor`, render one screen)
- Delete: `components/plane-card.tsx`, `node-plane-card.tsx`, `status-card.tsx`, `step-card.tsx`, `step-screens.ts`, `prefs-card.tsx`, `output-block.tsx` (its rendering moves into `details-disclosure.tsx`); `hooks/use-node-commands.ts` loses `setCloseToTray`; `lib/ipc.ts` loses `nodeSettings`' tray fields and `nodeSetCloseToTray` (keep `planeUrl`/`agentBinPath` in `NodeSettings`).
- Modify: `apps/client/desktop/src-tauri/src/windows.rs:72-101` (node window 1024×720, `resizable(false)`, `.center()`; title "Subshell Client")
- Tests: update `ui/src/__tests__/app.test.tsx`, `repoint.test.tsx`, `probe-facts.test.ts` (facts now render inside the details disclosure — keep the module and its test), `about-footer.test.tsx` (the footer line renders in the frame).

**Interfaces:**
- Consumes: Task 24; `useNodeCommands` (`refresh`, `installAgent`, `updateAgent`, `service`, `restart`, `enroll`, `repoint`, `openPath`, `pickBinary`, `clearBinary`, `openPlane`, `openPlaneUrl`); `useEnrollForm`; `useActionRunner`; `probe-facts.ts`; `plane-coherence.ts`.
- Produces: `App` renders `<Frame title subtitle bar>{screen}</Frame>`.

- [ ] **Step 1: Sketch the frame test**

Extend `app.test.tsx` (it already renders `App` under `harness.tsx` with a stubbed IPC): assert that with `planeUrl: null` the page shows heading **Connect to a Server**; with a plane and `step: "online"` it shows **This Mac Is a Node** (harness platform darwin), a button **Open Subshell Client**, and a disclosure **More…** containing **Re-enroll…**; with `step: "stopped"` it shows **The Node Service Is Stopped** and a **Start** button.

Run: `cd apps/client/desktop && bun run test`
Expected: FAIL.

- [ ] **Step 2: Build the screens**

Each screen is a function component taking `{ probe, settings, commands, form, runner }` as needed:

- **ConnectScreen** — subtitle *Enter the address of the Subshell server this app should show.*; one `Input` (label **Server URL**, placeholder `https://subshell.example.com`), bar: **Open** (primary; `commands.openPlane(url)`), ghost **Open in browser instead** (`commands.openPlaneUrl` after saving the URL — call `openPlane` first, which persists it, then `openPlaneUrl`). Validation via the existing URL rules in `plane-card.tsx` (move them).
- **InstallAgentScreen** — subtitle from `step-screens.ts`'s `no-agent` copy; primary **Install** when bundled and nothing answered, ghost **Choose an existing agent…** (`commands.pickBinary`), **Forget the chosen binary** when one is set, **Retry**. Details disclosure below.
- **EnrollScreen** — the existing `enroll-fields.tsx` (Server URL prefilled from `settings.planeUrl`, Setup key, Node name) in a 360px form; the two-phase confirm through `confirm-panel.tsx` as today; **Enroll** primary (tmux-gated with the amber note from `copy.ts`), **Cancel** when reached via override. On success the connected screen shows the name from `onEnrolled`.
- **ServiceScreen** — subtitle: the step's copy from `step-screens.ts`; primary = `serviceAction(step)` → `commands.service(verb, { settle: true })` or `commands.restart()` for `restart`; ghost **Reveal configuration** (`openPath("config-dir")`); details disclosure (facts from `probe-facts.ts`, the last output); footer link **Reset this Mac…** → override `reset`.
- **ConnectedScreen** — subtitle *Enrolled as **{name}** and reporting to {serverUrl}.* (name only when this session enrolled; else *Enrolled and reporting to …*); primary **Open Subshell Client** (`commands.openPlane(null)`); a `<details>` **More…** holding: *This app opens {planeUrl}* with **Change server…** (inline field → `openPlane(url)`), the divergence notice + **Use {planeUrl} for this node** from `plane-coherence.ts`, **Repoint this node…**, **Re-enroll…** (override `enroll`), **Update the agent to {bundledVersion}** when `agentChoice === "upgrade-available"` (`commands.updateAgent`), **Reset this Mac…** (override `reset`). Details disclosure with the facts. No dots on any screen (there is no cross-process handoff here).
- **DetailsDisclosure** — `<details><summary>Show Details</summary>` with the `probe-facts.ts` list rendered as a `<dl>` and the last `runner.output` as `<pre>` (the old `OutputBlock`), plus `runner.failure` as the problem line.
- **Frame** — per the constants: `main` 1024×720, centered column `max-w-[560px]`, `h1` 30px/600, subtitle 15px muted, content 36px below, bottom bar 72px with a hairline top, primary right, ghost left. Footer line under the bar: the `AboutFooter` content condensed to one line (*Subshell Client 0.1.3 · Agent 0.2.0 · Licence*).

`app.tsx`:
```tsx
export function App() {
  const runner = useActionRunner();
  const { probe, settings, firstProbePending, readError } = useNodeState(runner.busy);
  const form = useEnrollForm();
  const [override, setOverride] = useState<"enroll" | "reset" | null>(null);
  const [enrolledNode, setEnrolledNode] = useState<EnrolledNodeBody | null>(null);
  const commands = useNodeCommands({ runner, probe, form, onEnrolled: (n) => { setEnrolledNode(n); setOverride(null); } });
  const screen = screenFor(probe, settings, override);
  const platform = probe?.platform ?? "darwin";
  const problem = runner.failure || readError || probe?.error || "";
  if (!screen) return <Frame title="Checking this machine…" subtitle="" />;
  return (
    <Frame title={screenTitle(screen, probe, platform)} subtitle={subtitleFor(screen, probe, settings)} problem={problem} footer={<AboutFooter probe={probe} compact />}>
      {screen === "connect" && <ConnectScreen … />}
      {screen === "install-agent" && <InstallAgentScreen … />}
      {screen === "enroll" && <EnrollScreen … onCancel={override ? () => setOverride(null) : undefined} />}
      {screen === "service" && <ServiceScreen … onReset={() => setOverride("reset")} />}
      {screen === "connected" && <ConnectedScreen … onReenroll={() => { form.seedServer(probe?.status?.serverUrl ?? settings?.planeUrl ?? ""); setOverride("enroll"); }} onReset={() => setOverride("reset")} />}
      {screen === "reset" && <ResetScreen … onCancel={() => setOverride(null)} />}
    </Frame>
  );
}
```
`ResetScreen` is Task 26's; until then render a placeholder that only offers **Cancel** (and say so in the commit).

`windows.rs::open_node`: `.title("Subshell Client")`, `.inner_size(1024.0, 720.0)`, `.resizable(false)`, `.center()`; delete `NODE_MIN_*`.

- [ ] **Step 3: Run the UI tests, lint, and the app**

Run: `cd apps/client/desktop && bun run test && bun run build && cd ../../.. && bun run rust:check && bun run verify-types && bun run lint:check`
Expected: PASS. Then `bun run dev:desktop-client`, open **This Machine…** from the tray, and walk: no plane → Connect; plane set, agent online → This Mac Is a Node with Open Subshell Client; stop the agent service from a terminal (`subshell service stop`) and Refresh → The Node Service Is Stopped → Start → back to connected.

- [ ] **Step 4: Commit**

```bash
git add -A apps/client/desktop
git commit -m "feat(desktop-client): the node window is an assistant, one decision per screen"
```

---

### Task 26: Tray check item, deleted settings commands, and the client reset in the assistant

**Files:**
- Modify: `apps/client/desktop/src-tauri/src/tray.rs` (add the **Keep Running…** `CheckMenuItem`, mirroring Task 20)
- Modify: `apps/client/desktop/src-tauri/src/control.rs` (delete `node_settings`' tray fields → keep a slim `node_settings` returning `{ planeUrl, agentBinPath }`; delete `node_set_close_to_tray`), `lib.rs` handler list, `permissions/desktop.toml`, `capabilities/node.json`
- Execute: `docs/superpowers/plans/2026-09-11-native-reset-both-desktop-apps.md` **Task 1** (guards to `crates/desktop-core`), **Task 2** (the node CLI reports its paths), **Task 4** (Subshell Client's reset chain — `node_arm_reset`, `node_reset`) exactly as written there; its **Task 5** (the reset UI) is built as `components/assistant/reset-screen.tsx` in the frame (title *Reset This Mac*, the five deletion rows, the disclosures paragraph, the hostname field, **Reset Everything** destructive / **Cancel** ghost) instead of into the card page; its **Task 3** (the server console's entry) is superseded — the server's reset screen is Task 22 of this plan.
- Modify: `ui/src/__tests__/ipc-acl.test.ts` (the node page's command set is the union of `app.tsx`, `components/assistant/**`, `hooks/**`; `node_settings`/`node_set_close_to_tray` gone; `node_arm_reset`/`node_reset` added; nothing names `main`).

**Interfaces:**
- Produces: tray `CheckMenuItem` `tray:keep` bound to `Settings.close_to_tray` with the tray-support clamp; `node_settings(): { planeUrl: string | null; agentBinPath: string | null }`; `node_arm_reset`, `node_reset` per the reset plan.

- [ ] **Step 1: Update `ipc-acl.test.ts` to the target set** (fails first).

- [ ] **Step 2: Tray and commands**

`tray.rs`: add `CheckMenuItem` `tray:keep` (label per platform) after **This Machine…**, checked from `control::close_to_tray_now`, handler identical to Task 20's. `control.rs`: `node_settings` returns only `planeUrl`/`agentBinPath`; delete `node_set_close_to_tray`, `NodeSettings`'s tray fields, `TRAY_NOT_DETECTED` copy in `ui/src/lib/copy.ts`. Remove `allow-node-set-close-to-tray` from `desktop.toml` and `node.json`.

- [ ] **Step 3: The reset**

Follow the reset plan's Tasks 1, 2 and 4 step by step (they carry their own tests). Build `reset-screen.tsx` against `nodeArmReset()`/`nodeReset({ typed })` from `lib/ipc.ts`, rendering the plan the arm returns; `runner.run` for the press; on success the screen shows the chain's log and the app's `screenFor` lands on Connect/Enroll on the next probe (`planeUrl` is kept, per that spec's decision; check § 2 of that spec and follow it).

- [ ] **Step 4: Verify**

Run: `bun run rust:check && cd apps/client/desktop && bun run test && bun run build && cd ../../.. && bun run verify-types && bun run lint:check && bun run test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A apps/client/desktop crates/desktop-core apps/node/agent
git commit -m "feat(desktop-client): tray preference in the tray; reset lands in the assistant"
```

---

## Phase F — Docs, security accounting, changesets, and the by-hand checks

### Task 27: Documentation and security accounting

**Files:**
- Modify: `apps/server/desktop/AGENTS.md` — "The three windows, and why they are three" → "Two windows"; delete "The console is five sections behind a sidebar"; rewrite "Boot looks before it leaps" for `boot_window` → Main/Wizard and `open_home`; add "The watch" (Task 20) and "The assistant's screens" (Tasks 21–22); update the IPC table to spec § 5.6; drop `tuck_console` from "Windows, and getting them in front".
- Modify: `apps/client/desktop/AGENTS.md` — the node window is an assistant: the six screens, `screenFor`, the deleted commands, the tray check item, the reset.
- Modify: `apps/server/api/AGENTS.md` — a section "The server manages itself on an admin's request": the four `/api/admin/server` routes; `applyConfig` is the one config.env writer; `configEnvAppliedKeys` and why source attribution needs it; the capped log file, the level policy (stdout at info, file at the effective level, HTTP lines at debug) and the debug toggle; `isSupervised` from the manager's pid, not a marker; `performRestart` and the 1012 close code; `POST /api/nodes/:id/restart` and its 409 codes.
- Modify: `apps/node/agent/AGENTS.md` — `ready.runtime` (collected once at start; `DaemonDeps.runtime` seam), the `restart` command and `requestRestart`, `AGENT_LOG_HINT`.
- Modify: `.claude/rules/security-context.md` — after "Agent CLI installs are an admin act…", add:
  > **The server manages itself on an admin's request** (spec 2026-09-12): `PATCH /api/admin/server/config` rewrites config.env through the CLI's own validated writer and `POST /api/admin/server/restart` exits for the service manager to respawn — both cookie-admin only, both audited (`server.config.update`, `server.restart`), and the restart is refused unless the manager's pid is this process (so a hand-run server cannot be exited into nothing). The server writes its own log to `<dataDir>/logs/server.log` (0600, capped at 200 KB and replaced when full, nothing kept in memory); `GET /api/admin/server/logs` serves its tail and `PUT /api/admin/server/logging` turns debug logging on, which is the only way HTTP request lines are written (an `/install.sh?key=` line carries a setup key): a new READER of that text, admin-only, and no widening — an admin mints setup keys anyway. `POST /api/nodes/:id/restart` is a plane→node lifecycle command; no new trust, the plane already runs arbitrary launches there.
- Modify: `docs/security.md` — the same paragraph in the threat-model prose, in the section that holds the admin routes; add `<dataDir>/logs/server.log` (0600, 200 KB cap, replaced when full; request paths in debug mode) to the "what the app writes" inventory.
- Modify: root `AGENTS.md` — "What each app is" table: the `apps/server/desktop` row reads "Subshell Server — installs/runs/repairs a local control plane; management is the dashboard's"; remove any mention of the console.
- Modify: `docs/superpowers/specs/2026-09-11-server-console-sidebar-design.md` — add a one-line "Status: superseded by 2026-09-12-management-in-the-dashboard-design.md (the console is removed)" under its title.

- [ ] **Step 1: Make the edits above.** Each AGENTS.md change describes what the code now does and why; no history narration beyond one dated sentence per change.

- [ ] **Step 2: Lint the docs the repo lints**

Run: `bun run lint:check`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/server/desktop/AGENTS.md apps/client/desktop/AGENTS.md apps/server/api/AGENTS.md apps/node/agent/AGENTS.md .claude/rules/security-context.md docs/security.md AGENTS.md docs/superpowers/specs/2026-09-11-server-console-sidebar-design.md
git commit -m "docs: management lives in the dashboard; the desktop apps keep only what a served page cannot do"
```

---

### Task 28: Changesets

**Files:**
- Create: `.changeset/management-in-the-dashboard-server.md`, `-desktop-server.md`, `-node.md`, `-desktop-client.md`

- [ ] **Step 1: Write the four changesets** (never `@internal/server-web`):

```md
---
"@internal/server": minor
---

Server Settings → Service: addresses (port, bind address, public base URL, trusted origins) are edited in the dashboard and written through the CLI's own validator; the server can restart itself when its service manager will respawn it; its deployment view, data locations and log are readable by an admin from any browser; the server keeps one 200 KB log file (replaced when full) and a debug-logging switch, off by default, turns on debug and HTTP request lines. Node detail shows how an enrolled node's agent runs and can restart it. New admin routes: `GET /api/admin/server`, `PATCH /api/admin/server/config`, `POST /api/admin/server/restart`, `GET /api/admin/server/logs`; new node route `POST /api/nodes/:id/restart`. An About dialog for every user.
```

```md
---
"@internal/desktop-server": minor
---

Launching the app opens the dashboard when the server is running. The management console is gone: everything it showed lives in the dashboard's Server Settings → Service, and the app keeps one native assistant for what a page the server serves cannot do — first run, a server that is not running, updating the bundled server, and reset. The tray preference is a check item in the tray menu.
```

```md
---
"@internal/node": minor
---

The agent reports how it runs (supervision, service state, paths, tmux) when it connects, and accepts a `restart` command from its control plane, exiting for the service manager to respawn it.
```

```md
---
"@internal/desktop-client": minor
---

The node window is a setup-assistant-style flow: connect to a server, install the agent, enroll this machine, start the node service, and a connected screen that opens the control plane. Facts about how the agent runs moved to the control plane's Nodes page. Reset from the native app. The tray preference is a check item in the tray menu.
```

- [ ] **Step 2: Validate**

Run: `bunx changeset status`
Expected: the four packages listed, no ignored package named.

- [ ] **Step 3: Commit**

```bash
git add .changeset
git commit -m "chore: changesets for management in the dashboard"
```

---

### Task 29: The by-hand checks the spec names (§ 8)

No files. Record each outcome in `docs/superpowers/plans/2026-09-12-management-in-the-dashboard.md` under this task as a checked box with a one-line result and the date.

- [ ] **Step 1: Port change from the desktop window.** `bun run dev:desktop-server` on a machine with the service installed. Server Settings → Service → Addresses: change Port to a free port, Save (the strip says *Saved. Restart the server to apply.*), Restart. Expected: the offline banner shows briefly; within ~10 s the dashboard is back and the window's URL bar (DevTools → `location.origin`) shows the new port without any click — the Rust watch re-pointed it. Change it back.

- [ ] **Step 2: Port change from a browser tab.** Same page in Chrome at the old port. Expected: the Restarting strip shows *The server will come back at http://…:<new>* with a link; the old tab never recovers on its own (it cannot), and the link lands on a signed-in dashboard (same host, so the cookie holds).

- [ ] **Step 3: Unsupervised restart is refused.** Stop the service, run `subshell-server` in a terminal, open the dashboard. Expected: Service card says *Running, not supervised*, Restart disabled with the reason, `POST /api/admin/server/restart` from curl with the admin cookie answers 409 `RESTART_UNAVAILABLE`.

- [ ] **Step 4: Recovery.** `subshell-server service stop`; click the sidebar pill. Expected: the assistant at *Your Server Is Stopped*, Show Details lists the definition path and the log location and the last log lines; Start → *Opening your dashboard…* → dashboard.

- [ ] **Step 5: Headless node restart.** On a Linux node enrolled under systemd, open its detail page from a browser. Expected: Runtime card says *systemd (pid N) · starts at login*, the journal hint is shown; Restart agent → *Restarting…* → the node goes offline then online → *Back.*; `journalctl --user -u subshell.service` shows the exit and respawn; running subshells on that node are still alive.

- [ ] **Step 6: Subshell Client walk.** Task 25's walk plus: tray **Keep Running in Menu Bar** toggles and persists across a relaunch; Reset from the connected screen's **More…** requires the hostname and lands the assistant on Enroll.

- [ ] **Step 7: Commit the recorded outcomes**

```bash
git add docs/superpowers/plans/2026-09-12-management-in-the-dashboard.md
git commit -m "docs(plan): by-hand check outcomes for management in the dashboard"
```

---

## Self-review notes (written with the plan)

- **Spec coverage.** § 3.1–3.4 → Tasks 4–9 (the log file, the level policy and the debug toggle are Task 5 and Task 9); § 3.5 has no task by design. § 4.1–4.4 → Tasks 15–16; § 4.5 → Task 17; § 4.6 → Task 18. § 5.1–5.6 → Tasks 19–23 (§ 5.4 `b=` split across Task 18 and Task 20). § 6.1 → Task 11; § 6.2–6.3 → Tasks 13–14; § 6.4 → Tasks 24–25; § 6.5 → Task 26; § 6.6 is a non-goal. § 8 → each task's tests plus Task 29. § 9 → Tasks 27–28.
- **Names used across tasks.** `applyConfig`/`ApplyConfigInput`/`ApplyConfigResult` (2 → 8); `configEnvAppliedKeys` (1 → 4, 8); `collectDeployment`/`isSupervised`/`settingSource`/`DeploymentView` (4 → 7, 8, 9, 15); `performRestart`/`WS_CLOSE_SERVICE_RESTART` (6 → 9); `serverLogFile`/`readServerLogTail`/`serverLogPath`/`SERVER_LOG_CAP_BYTES`/`applyDebugLogging`/`debugLoggingState`/`currentDebugLogging`/`setDebugLogging` (5 → 4, 9, 16); `NodeRuntimeReport`/`parseNodeRuntimeReport`/`NODE_RESULT_*` (10 → 11, 12, 13); `collectRuntime` (11 → 12 via daemon); `CommandContext.runtime`/`requestRestart` (12); `restartSeams` (9); `useServerRestart`/`useServerDeployment`/`useUpdateServerConfig`/`useServerLogs` (15 → 16, 18); `desktop_open_assistant` (18 ↔ 19, 23); `open_home`/`open_assistant`/`boot_window`/`WindowChoice::Main` (19 → 20, 23); `ACTION_IN_FLIGHT`/`ActionGuard`/`origin_changed`/`user_agent_for` (20); `screensFor(probe, onboarded)`/`recoveryTitle`/`recoveryAction` (21 → 22); `screenFor`/`screenTitle`/`serviceAction` (24 → 25).
- **Known soft spots an implementer should verify rather than assume:** the `LogLayerTransportParams` field names (`logLevel`, `messages`, `data`, `hasData`) against `@loglayer/transport@3.3.0`'s `.d.ts`; whether `LoggerlessTransport.level` is consulted per call so flipping it live works (else re-create the transport with `removeTransport`/`addTransport`); whether `getSimplePrettyTerminal` accepts a `level`; the spike's verdict on the rotation transport under Bun; `NodeRpcError` exposing the agent's error text (Task 13's `codeFor`); `AuditRepository`'s newest-first read method name; the `Dialog` primitive's prop names in `components/ui/dialog.tsx`; how `daemon.ts` names the live socket for `requestRestart`.
