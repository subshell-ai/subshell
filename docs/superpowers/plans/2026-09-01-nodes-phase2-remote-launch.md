# Nodes Phase 2 — Remote Launcher, Full Parity: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-08-31-nodes-design.md` (cite "spec 2026-08-31 §N"). Phase outline: `docs/superpowers/plans/2026-08-31-nodes.md` (Phase 2 tracks 2A/2B/2C — this plan executes them task-sequentially; 2B-first because the frozen wire answers are the backend's test fixtures). Where Phase 1 diverged from plan, the spec's **"Errata (implementation, 2026-08-31)"** section records it; this plan adds entries there when it diverges.

**Goal:** A session created with `nodeId` = an enrolled agent node really runs there: launch, prompt delivery, live terminal (attach/replay/input/resize), preview, logs, uploads, restart/terminate/delete, reconcile and exit observation — full parity with `local`, delivered through the frozen `NodeLauncher` seam. A real Linux/macOS box enrolled in phase 1 becomes a first-class launch target; the phase-2 exit is the parity checklist on such a box.

**Architecture:** Three moves. (1) **The agent grows executors** (`apps/agent/src/commands/`): every `NodeCommandBody` the daemon answered `unsupported` in phase 1 now runs against local tmux/fs through `@internal/harnesses` — the same plugin code the backend runs, so launch assembly, resume probes, and inventory are byte-identical behaviors on both sides. (2) **The backend grows `RemoteLauncher`** — a `NodeLauncher` whose every method is a `sendCommand` over the live node socket — plus a per-row launcher resolution in `SessionManagerService` and `ws/session-ws.ts` (`row.nodeId → launcher`), so the orchestrator never branches on local-vs-remote outside one seam. (3) **The result contract gets written down**: phase 1 froze command/event *frames* but not the `result{data}` *shapes*; a new `node-results.ts` in `@internal/session-protocol` pins them (types + hand-rolled validators), so backend and agent integrate against one contract instead of folklore. Live-agent facts that phase 2 needs (`dataDir`, `capabilities`) ride the `ready` event onto the registry's `NodeConnection` — deliberately NOT the DB (no migration; online ⇒ `ready` arrived on *this* socket, so the facts cannot be stale).

**Tech Stack:** Elysia `.ws`, `@internal/session-protocol` (JWS envelopes), `@internal/harnesses` (`TmuxRunner`, `buildLaunchCommand`, `scanHarnesses`), Kysely, React 19 + TanStack Query, Bun native `WebSocket`, `bun test`, `bun build --compile` (agent), `@modelcontextprotocol/server` 2.0.0 + `zod` 4.4.3 (the MCP port).

## Global Constraints

- Verification after **every** task: `bun run verify-types && bun run lint:check && bun run test` (root), all green before committing. Backend route/schema changes → `turbo build` so `@internal/backend-client` re-infers (`build.md`).
- **Gate rule from phase 0:** never gate on isolated runs of `session-manager.service.test.ts` / `session-manager-mcp.test.ts` (pre-existing order-flake); gate on full suites.
- **No migration in this phase.** `0017` is frozen (booted on real DBs); if a schema change proves unavoidable it is a new `0018-*.ts` registered in `db/migrate.ts` — but the design needs none: node facts that must survive a socket stay where they already live (`nodes` columns from 0017), and facts that are only usable while online (`dataDir`, `capabilities`) live on `NodeConnection`.
- **Frozen-file discipline** (master plan §Global Constraints): `node-frames.ts` payloads, migration 0017, `NodeLauncher` signatures, the REST table in spec §9. All wire additions in this plan are **additive with a version note** (new module `node-results.ts`, two new exported close-code constants); `NodeLauncher` gains NO methods — `RemoteLauncher` implements the frozen interface exactly.
- **Frame ceiling discipline:** every frame both directions ≤ `NODE_MAX_FRAME_BYTES` (1 MiB), enforced by byte check in handlers. `write_file` chunks are **512 KiB raw** (base64 ≈ 700 KiB + JSON envelope overhead stays safely under 1 MiB). The spec's "768 KiB raw" base64-encodes to exactly 1 MiB and would overflow — recorded as a spec erratum in Task 1, do not "fix" it back.
- **`node-rpc` invariants (binding, from `node-launcher.ts` header):** per-node dispatch stays serialized in call order (`sendChain`); callers MUST NOT overlap per-session pumps (capture loop + tail, two attaches) on one session. `RemoteLauncher` adds no parallelism; `session-ws` relay code must keep one pump per attach.
- **Offline semantics (spec §5.6):** launch onto an offline node → `409 NODE_OFFLINE`; `reconcileRows` SKIPS agent rows whose node is offline (absence of socket ≠ absence of process); session views carry `nodeOffline` so the UI says "node unreachable", never "crashed". Restart/auto-restart onto an offline node → same 409 / skipped.
- **Local path is untouchable behavior:** `LocalLauncher` stays verbatim; the existing session-manager/ws suites passing unchanged is the regression net. Branch points take `local` through the identical code path they run today.
- **Session-access invariants survive:** node launch eligibility = **any node share** (`nodeCanLaunch`); sessions on a node stay invisible to the node owner unless the *session* is shared; node keys NEVER act on REST (spec §5.5, unchanged); machine bearers keep admin-boost/shares OFF (`loadNodeAccess(…, { allowAdminAndShares: false })` on the create path).
- `apps/agent`: **static imports only** (`bun build --compile`), no CLI framework, no ws dep, pinned deps (syncpack: `zod` `4.4.3`, `@modelcontextprotocol/server` `2.0.0` — same as backend). Agent tests NEVER touch `~/.config` (preload sets `MOTE_AGENT_HOME` to a temp dir); tmux-touching tests skip on `which tmux` (repo precedent).
- Elysia `t`: every property a `description`; every endpoint `operationId` + tags; errors `"ApiErrorResponse"`. JSDoc on public API + interface props. No dynamic imports anywhere.
- Frontend: plain `apiFetch` + hand-typed mirrors (house style), plain string literals (no i18n), no toasts — inline error text; e2e ids `picker-node` / `node` are load-bearing, keep them. The browser `/ws` terminal contract is **byte-identical** for remote sessions (spec §6.5) — frontend/mobile change nothing for terminals.
- Carried phase-1 backlog items are folded into the tasks that own their files (each is called out inline with "P1 carry"); the standalone leftovers land in Task 17 (polish).

## File Structure (phase-2 delta)

```
packages/session-protocol/src/
├── node-results.ts        # NEW: per-command result{data} contracts + validators (Task 1)
├── node-frames.ts         # + NODE_CLOSE_* constants (additive)  (Task 1)
└── index.ts               # re-exports

apps/agent/src/
├── path-policy.ts         # NEW: realpath allowlist for write_file/remove_paths  (Task 2)
├── session-meta.ts        # NEW: per-session meta store (<dataDir>/sessions/<id>.json)  (Task 2)
├── commands/              # NEW dir, one executor per command family
│   ├── index.ts           #   dispatch(cmd, ctx) → CachedResult  (Task 3)
│   ├── basics.ts          #   ping/terminate/kill/input/resize/capture/stat_dir/probe/probe_resume/remove_paths/inventory  (Task 3)
│   ├── launch.ts          #   launch (+exit watcher start)  (Task 4)
│   ├── report.ts          #   sessions_report scan + exit watcher  (Task 4)
│   ├── prompt.ts          #   prompt_deliver settle loop  (Task 5)
│   ├── tail.ts            #   log_read/tail_start/tail_stop  (Task 5)
│   └── write-file.ts      #   write_file chunk receiver  (Task 6)
├── mcp/                   # NEW dir: ported MCP stdio server (Task 13)
├── daemon.ts              # dispatch → commands/index; ready capabilities; connect-time sessions_report
└── cli.ts                 # + `mcp` subcommand

apps/backend/src/services/nodes/
├── node-events.ts         # NEW: per-connection tail-subscriber bus + agent-facts store  (Task 7)
├── node-registry.ts       # + conn.agent facts, conn.tails  (Task 7)
├── node-ws-handler.ts     # output/exit/sessions_report dispatch; per-socket serialized dispatch (P1-T10 carry)  (Task 7)
├── remote-launcher.ts     # NEW: NodeLauncher over node-rpc  (Task 8)
├── launcher-registry.ts   # NEW: nodeId → LocalLauncher | RemoteLauncher resolution  (Task 8)
├── preview-cache.ts       # NEW: capture cache for agent rows (≤ 60 s)  (Task 10)
└── local-launcher.ts      # untouched (regression net)

apps/backend/src/services/session-manager.service.ts   # per-row launcher resolution, node resolution §6.6, probe batching, nodeOffline  (Tasks 9–10)
apps/backend/src/ws/session-ws.ts                      # remote relay branch  (Task 11)
apps/backend/src/api/sessions/create-session.route.ts  # drop NODE_LAUNCH_NOT_READY gate  (Task 9)
apps/backend/src/api/uploads/…                         # write_file relay  (Task 12)
apps/frontend/src/…                                    # pill/copy/picker unlock  (Task 15)
apps/mobile/src/…                                      # node mirror + picker  (Task 16)
```

---

### Task 1: Result-contract module + close-code hoist + spec erratum

**Files:**
- Create: `packages/session-protocol/src/node-results.ts`
- Create: `packages/session-protocol/src/__tests__/node-results.test.ts`
- Modify: `packages/session-protocol/src/node-frames.ts` (append two exported constants; no payload changes)
- Modify: `packages/session-protocol/src/index.ts` (re-exports)
- Modify: `apps/backend/src/services/nodes/node-ws-handler.ts` (import the hoisted codes; keep `NODE_CLOSE_UNAUTHENTICATED`/`NODE_CLOSE_TOO_BIG` local — they are handler-local, the hoisted two are shared with the agent)
- Modify: `apps/backend/src/services/nodes/node-registry.ts` (replace local `REPLACE_CLOSE_CODE = 4409` with `NODE_CLOSE_SUPERSEDED`; keep a re-export alias so existing test imports don't churn)
- Modify: `apps/agent/src/daemon.ts` (delete local `NODE_CLOSE_SUPERSEDED`/`NODE_CLOSE_UPDATE_REQUIRED` consts, import from protocol; `apps/agent/src/index.ts` re-export path unchanged)
- Modify: `docs/superpowers/specs/2026-08-31-nodes-design.md` (Errata section append, see Step 5)

**Interfaces:**
- Consumes: `NodeCommandBody` (frozen), `JsonValue`.
- Produces (the contract every 2A/2B task codes against — **exact names**):
  - `type NodeCloseCode` union is NOT needed; just the constants `NODE_CLOSE_UPDATE_REQUIRED = 4406` and `NODE_CLOSE_SUPERSEDED = 4409` exported from `node-frames.ts`.
  - `NodeProbeEntry = { sessionId: string; alive: boolean; exitCode: number | null; title?: string; command?: string; capture?: string }` and `parseNodeProbeEntries(data: unknown): NodeProbeEntry[] | null` — the `probe` command's result.
  - `NodeStatDirResult = { path: string; isDirectory: boolean }` and `parseNodeStatDirResult` — `stat_dir` answers only on success (missing/not-a-dir → `result{ok:false}`), so `exists` is implied.
  - `NodeLogReadResult = { bytes_b64: string; next: number; size: number }` and `parseNodeLogReadResult` — `size` is the whole file, letting a relay compute a tail window in one round-trip (Task 11).
  - `NodePromptDeliverResult = { promptDelivered: boolean }` and `parseNodePromptDeliver`.
  - `NodeProbeResumeResult = { canResume: boolean }` and `parseNodeProbeResume`.
  - `NodeWriteFileResult = { path: string; received: number }` and `parseNodeWriteFileResult` — returned on every `write_file` chunk; `received` is the running byte total.
  - `parseNodeCaptureResult(data: unknown): string | null` — `capture` answers with the raw string.
  - `launch` / `terminate` / `kill` / `input` / `resize` / `tail_start` / `tail_stop` / `remove_paths` / `inventory` / `ping` return **no data** (`{ ok: true }`).
- Validators are hand-rolled in the `parseNodeEvent` style (this package stays schema-lib-free); a NON-null return is safe to cast.
- **Two additive frame fields** (each: absent ⇒ today's behavior; protocol stays v1):
  1. `launch` gains `bestEffortLog?: boolean` — the wire twin of `LaunchPlan.bestEffortLog`: when true, the agent downgrades a log-attach failure (sessions-dir mkdir + pipe-pane) to a logged note and still answers `{ok:true}`; the pane is live. `parseNodeCommandBody`'s launch case adds `!("bestEffortLog" in value) || isBool(value.bestEffortLog)`. RemoteLauncher passes it through (Task 8), the launch executor honors it exactly like `LocalLauncher.#ensureLogDir`+`pipePane` best-effort wrapping (Task 4). Without this, remote revive is strictly worse than local revive — a parity hole the phase cannot ship with.
  2. `ready` gains `executablePath?: string` (the agent's `process.execPath`). `node-frames.ts`: extend the `NodeEvent` ready interface (JSDoc: "absolute path of the running mote-agent binary on the node; the control plane composes the MCP launch spec against it. Absent from pre-phase-2 agents.") and in `parseNodeEvent`'s `ready` case add `!("executablePath" in value) || isStr(value.executablePath)`. Old agents omit it, old backends ignore it — protocol stays v1 (recorded as an errata bullet in Step 5). The agent (Task 4) is the source of truth for the MCP dialect regardless: it re-runs the plugin's `mcpRegistration` locally, so a stale control-side guess can never poison a pane.

- [ ] **Step 1: Failing test** — `node-results.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import {
  NODE_CLOSE_SUPERSEDED,
  NODE_CLOSE_UPDATE_REQUIRED,
  parseNodeCaptureResult,
  parseNodeLogReadResult,
  parseNodeProbeEntries,
  parseNodeProbeResume,
  parseNodePromptDeliver,
  parseNodeStatDirResult,
  parseNodeWriteFileResult,
} from "../index.js";

describe("node result contracts (spec §3.3, phase-2 wire note)", () => {
  it("hoists the two shared close codes", () => {
    expect(NODE_CLOSE_UPDATE_REQUIRED).toBe(4406);
    expect(NODE_CLOSE_SUPERSEDED).toBe(4409);
  });

  it("probe entries: accept well-formed (incl. optional fields), reject junk", () => {
    expect(
      parseNodeProbeEntries([
        { sessionId: "a", alive: true, exitCode: null },
        { sessionId: "b", alive: false, exitCode: 1, title: "t", command: "c", capture: "screen" },
      ]),
    ).toHaveLength(2);
    expect(parseNodeProbeEntries(null)).toBeNull();
    expect(parseNodeProbeEntries([{ sessionId: "a" }])).toBeNull(); // alive missing
    expect(parseNodeProbeEntries([{ sessionId: "a", alive: true, exitCode: 1.5 }])).toBeNull();
    expect(parseNodeProbeEntries([{ sessionId: "a", alive: true, exitCode: null, title: 7 }])).toBeNull();
  });

  it("log_read requires a strict-base64 payload and monotonic offsets", () => {
    expect(parseNodeLogReadResult({ bytes_b64: "aGk=", next: 2, size: 2 })).not.toBeNull();
    expect(parseNodeLogReadResult({ bytes_b64: "!!", next: 0, size: 1 })).toBeNull();
    expect(parseNodeLogReadResult({ bytes_b64: "", next: 5, size: 3 })).toBeNull(); // next past size with no bytes read at 5? size 3 < from… reject via next<=size OR bytes
    expect(parseNodeLogReadResult({ bytes_b64: "", next: 3, size: 3 })).not.toBeNull(); // empty tail read is legal
    expect(parseNodeLogReadResult({ bytes_b64: "aGk=", next: -1, size: 2 })).toBeNull();
  });

  it("the scalar results validate narrowly", () => {
    expect(parseNodeCaptureResult("screen")).toBe("screen");
    expect(parseNodeCaptureResult(42)).toBeNull();
    expect(parseNodeStatDirResult({ path: "/x", isDirectory: true })).not.toBeNull();
    expect(parseNodeStatDirResult({ path: "/x", isDirectory: "yes" })).toBeNull();
    expect(parseNodePromptDeliver({ promptDelivered: false })).not.toBeNull();
    expect(parseNodePromptDeliver({})).toBeNull();
    expect(parseNodeProbeResume({ canResume: true })).not.toBeNull();
    expect(parseNodeProbeResume({ canResume: null })).toBeNull();
    expect(parseNodeWriteFileResult({ path: "/x", received: 12 })).not.toBeNull();
    expect(parseNodeWriteFileResult({ path: "", received: 0 })).toBeNull();
  });
});
```

> The `next: 5, size: 3` case above pins the validator rule, not folklore: accept a result only when `0 <= next <= size` OR (`bytes_b64` non-empty AND `next === size`)… **simplify**: the honest invariant is `next >= 0 && size >= 0 && (bytes_b64 === "" ? next <= size : true)`. Implement exactly that and drop the comment; the test line asserting `next:5,size:3` rejects, `next:3,size:3` empty accepts, covers both branches.

- [ ] **Step 2: RED** — `cd packages/session-protocol && bun test src/__tests__/node-results.test.ts` (unresolved imports).

- [ ] **Step 3: Implement `node-results.ts`.** Skeleton with the shared helpers inlined (the package has no shared-guard module; mirror the local-helper style of `node-frames.ts`):

```ts
import type { JsonValue } from "./json.js";

/**
 * Per-command `result{data}` contracts for the node link (spec 2026-08-31 §3.2/§3.3).
 * Phase 0 froze the FRAME shapes; this file freezes what each command's `data`
 * member carries. The agent is the sole producer, the backend's RemoteLauncher
 * the sole consumer — but both sides validate, and this package is the shared
 * source of truth so the two tracks cannot drift. Additive contract file
 * (phase-2): NODE_PROTOCOL_VERSION stays 1 because no frozen frame changed.
 */

/** One row of a `probe` batch result (spec §6.3 reconcile: has-session + exit + title + optional capture). */
export interface NodeProbeEntry { … }
// + the interfaces and parse* functions exactly as listed in Interfaces, each
// with JSDoc; `parseNodeLogReadResult` enforces: bytes_b64 strict-base64
// (same BASE64_RE discipline as node-frames — inline a local copy),
// next/size integers >= 0, and (bytes_b64 === "" ? next <= size : true).
```

(Implementers: the interfaces are fully specified in **Interfaces** above — write them out, with a JSDoc block per interface property, per house style.)

- [ ] **Step 4: Hoist close codes.** In `node-frames.ts` append (additive block, own comment): the two constants with a note that 4401/1009 stay handler-local in `node-ws-handler.ts` because only the backend emits them. Re-export from `index.ts`. Update `node-registry.ts` (`REPLACE_CLOSE_CODE` → import + `export const REPLACE_CLOSE_CODE = NODE_CLOSE_SUPERSEDED;` deprecated alias), `node-ws-handler.ts` (`NODE_CLOSE_PROTOCOL = NODE_CLOSE_UPDATE_REQUIRED` alias pattern), and `daemon.ts` (import; delete locals). Run each package's existing tests — the alias keeps every existing import/test green.

- [ ] **Step 5: Spec erratum.** Append to the spec's `## Errata (implementation, 2026-08-31)` section:

```markdown
- **§3.4 write_file chunk size: 512 KiB raw, not 768 KiB** (phase-2 plan). 768 KiB
  base64-encodes to exactly 1 MiB, so any JSON envelope overhead pushes the frame
  past `NODE_MAX_FRAME_BYTES` and the receiving byte-guard drops it — the chunk
  would never land. 512 KiB raw (~700 KiB base64) keeps the frame under the cap
  with room for the path + index fields.
- **§3.2/§3.3 `result{data}` shapes are contractized** in
  `packages/session-protocol/src/node-results.ts` (phase-2): probe entries,
  log_read (with whole-file `size` so a relay computes a tail window in one
  round-trip), stat_dir (success-only — missing/not-a-dir answers `ok:false`),
  prompt_deliver, probe_resume, write_file (running `received` total), capture
  (bare string). Additive contract; protocol stays v1.
- **§3.2 two additive frame fields (phase-2):** `launch.bestEffortLog?: boolean`
  (revive parity — a remote revive must survive a lost log pipe exactly like
  `LocalLauncher`'s `LaunchPlan.bestEffortLog`) and `ready.executablePath?:
  string` (the agent's `process.execPath`, so the control plane composes MCP
  registrations against the real target; the agent's local `mcpRegistration`
  re-run remains the source of truth).
```

- [ ] **Step 6: GREEN** — protocol tests, then root trio + `turbo build` (dependents re-infer).
- [ ] **Step 7: Commit** `feat(protocol): node command-result contracts + hoisted close codes (phase-2 wire note, spec errata)`

---

### Task 2: Agent path policy + session-meta store

**Files:**
- Create: `apps/agent/src/path-policy.ts`
- Create: `apps/agent/src/session-meta.ts`
- Create: `apps/agent/src/__tests__/path-policy.test.ts`
- Create: `apps/agent/src/__tests__/session-meta.test.ts`

**Interfaces:**
- Consumes: nothing new (node builtins).
- Produces (HARDENED in Task 2's review wave — the original snippet's `resolve()`-based rule admitted two bypasses; this text is the shipped contract):
  - `async function pathAllowed(rawPath: string, roots: string[]): Promise<boolean>` — the spec §7 gate, explicit root list (caller composes `<dataDir>` + tracked session cwds). Rules: **raw `..` segments are refused outright BEFORE resolving** (resolve() collapses them symlink-blind); the LEAF is rejected when `lstat` shows a symlink (existing-target links are already caught by realpath's first iteration — the dangling-leaf case is why the lstat is needed); otherwise absolute-resolve, `realpath` the deepest EXISTING ancestor (targets may be new), reject when the resolved candidate escapes every root. Roots realpath'd via exported `realpathRoots`. Never throws for policy denies — returns false.
  - `export function isSessionId(id: string): boolean` (session-meta.ts) — uuid-ish format guard (`/^[0-9a-fA-F-]{1,64}$/`) at the untrusted boundary; `metaPath`/`logPath`/`mcpPath` THROW on a bad id. Load-bearing, not belt-and-braces: Task 4's pipe-pane passes `logPath(sessionId)` to tmux `cat >>` WITHOUT a policy gate, so the id guard is the only check on that path.
  - `interface SessionMeta { sessionId: string; cwd: string; socket: string; harnessId: string; name: string; startedAt: string }`
  - `class SessionMetaStore` over `<dataDir>/sessions/<id>.meta.json` (0600, dir 0700): `record(meta): Promise<void>`, `get(id): Promise<SessionMeta | undefined>` (junk JSON ⇒ undefined + one log line), `list(): Promise<SessionMeta[]>` (dir scan, `.meta.json` only, junk skipped), `forget(id): Promise<void>` (swallows ENOENT), `logPath(id): string` → `<dataDir>/sessions/<id>.log`, `mcpPath(id): string` → `<dataDir>/mcp/<id>.json` — **the agent-side twin of the backend's `sessionLogPath`/`sessionMcpConfigPath`** (one definition each side, pinned equal by the launch command echoing them back, Task 4/8).
  - `cwdOf(id): Promise<string | undefined>` on the store (the policy's per-session root).

- [ ] **Step 1: Failing `path-policy.test.ts`** (temp dirs via `mkdtemp(join(tmpdir(), …))`; no MOTE_AGENT_HOME needed — pure fs):

```ts
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathAllowed, realpathRoots } from "../path-policy.js";

const base = realpathSync(mkdtempSync(join(tmpdir(), "mote-policy-")));
const dataDir = join(base, "data");
const tracked = join(base, "work", "proj");
const outside = join(base, "elsewhere");
beforeAll(() => { mkdirSync(dataDir, { recursive: true }); mkdirSync(tracked, { recursive: true }); mkdirSync(outside, { recursive: true }); });
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("path policy (spec §7)", () => {
  const roots = async () => realpathRoots([dataDir, tracked]);
  it("allows files under a root, present or yet-to-be-created", async () => {
    expect(await pathAllowed(join(dataDir, "mcp/x.json"), await roots())).toBe(true);
    expect(await pathAllowed(join(tracked, "uploads/new.png"), await roots())).toBe(true); // parent absent
    expect(await pathAllowed(dataDir, await roots())).toBe(true); // a root itself
  });
  it("rejects escapes by .., by prefix-sibling, and by unknown roots", async () => {
    expect(await pathAllowed(join(dataDir, "..", "escape"), await roots())).toBe(false);
    expect(await pathAllowed(`${dataDir}-sibling/file`, await roots())).toBe(false); // /data vs /data-sibling
    expect(await pathAllowed(join(outside, "x"), await roots())).toBe(false);
  });
  it("rejects a symlinked ancestor that lands outside every root", async () => {
    const link = join(tracked, "out");
    symlinkSync(outside, link);
    expect(await pathAllowed(join(link, "x"), await roots())).toBe(false);
    expect(await pathAllowed(join(link, "x"), [tracked])).toBe(false); // un-normalized roots realpath'd inside
  });
});
```

- [ ] **Step 2: RED** — `cd apps/agent && bun test src/__tests__/path-policy.test.ts`.

- [ ] **Step 3: Implement `path-policy.ts`:**

```ts
import { realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";

/**
 * The agent-side path allowlist (spec 2026-08-31 §7): `write_file` and
 * `remove_paths` are accepted only under <dataDir> or a tracked session's
 * launch cwd. Defense-in-depth against a compromised control plane — the
 * commands are signed, but signing proves WHO, not WHETHER.
 */

/** Realpath each root (symlinked roots must not smuggle an escape through the prefix test). */
export async function realpathRoots(roots: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const root of roots) {
    try {
      out.push(await realpath(root));
    } catch {
      // A vanished root cannot authorize anything; drop it (tracked cwd deleted under a dead session).
    }
  }
  return out;
}

/** Deepest existing ancestor of `p`, realpath'd — a new file's parents may embed a symlink. */
async function realpathExisting(p: string): Promise<string | null> {
  let cur = p;
  for (;;) {
    try {
      return await realpath(cur);
    } catch {
      const parent = cur.lastIndexOf(sep);
      if (parent <= 0) return null;
      cur = cur.slice(0, parent);
    }
  }
}

/**
 * True when `rawPath` (existing or not) resolves inside one of the
 * `realpathRoots`-normalized `roots`. `..` segments are collapsed by
 * `resolve`; symlinked ancestors are caught via the ancestor walk.
 */
export async function pathAllowed(rawPath: string, roots: string[]): Promise<boolean> {
  const abs = resolve(rawPath);
  const resolved = await realpathExisting(abs);
  if (resolved === null) return false;
  const normalized = await realpathRoots(roots);
  return normalized.some((root) => resolved === root || resolved.startsWith(root + sep));
}
```

(Perf note for implementers: `realpathRoots` runs per call; executors may cache roots per command — fine at these rates.)

- [ ] **Step 4: Failing `session-meta.test.ts`** — record → get round-trip; file mode 0600 (stat & 0o077 === 0); junk JSON → `get` undefined and skipped by `list`; `list` ignores `not-meta.log` / unrelated files; `forget` idempotent (missing is not an error); `logPath`/`mcpPath` shapes:

```ts
it("log/mcp paths mirror the spec §7 layout", () => {
  const store = new SessionMetaStore("/d");
  expect(store.logPath("s1")).toBe("/d/sessions/s1.log");
  expect(store.mcpPath("s1")).toBe("/d/mcp/s1.json");
});
```

- [ ] **Step 5: Implement `session-meta.ts`** — class over `dataDir`, methods exactly as in Interfaces; `record` writes `{ ...meta }\n` with `mkdir(dir, {recursive:true, mode:0o700})` + `writeFile(file, json, {mode:0o600})` + the `enforceMode` re-tightening pattern from `config.ts` (reuse its style; do not import the private helper). All read paths swallow ENOENT/corrupt with ONE `log(...)` line (import `log` from `daemon.ts`? No — daemon imports commands, so to avoid a cycle move `log()` into a new `src/log.ts` in this task and re-export from `daemon.ts` for its current importers).
- [ ] **Step 6: GREEN + trio** — [ ] **Step 7: Commit** `feat(agent): path allowlist + per-session meta store (spec §7)`

---

### Task 3: Agent command modules — dispatch + basic executors

**Files:**
- Create: `apps/agent/src/commands/context.ts` (`CommandContext`)
- Create: `apps/agent/src/commands/basics.ts`
- Create: `apps/agent/src/commands/index.ts` (`dispatchCommand`)
- Modify: `apps/agent/src/daemon.ts` (dispatch → `dispatchCommand`; outbound 1 MiB byte guard in `send`; add `@internal/backend-errors` dep for `stripAnsi` used from Task 5 on — declare it now)
- Create: `apps/agent/src/__tests__/commands-basics.test.ts`

**Interfaces:**
- Consumes: `TmuxRunner`/`getHarness` from `@internal/harnesses`; result validators from `@internal/session-protocol` (Task 1); `SessionMetaStore` + policy (Task 2).
- Produces:
  - `interface CommandContext { config: AgentConfig; tmux: TmuxRunner; meta: SessionMetaStore; nowMs: () => number; ws: { send(ev: NodeEvent): void; readonly bufferedAmount?: number }; watchers: Map<string, ReturnType<typeof setInterval>>; tails: Map<string, TailHandle> /* TailHandle defined in Task 5's tail.ts — declare the interface in context.ts now: { stop(): void } */; }`
  - `type CommandResult = { ok: true; data?: JsonValue } | { ok: false; error: string }` (move the daemon's `CachedResult` alias here).
  - `async function dispatchCommand(ctx: CommandContext, cmd: NodeCommandBody): Promise<CommandResult>` — the switch. This task wires: `ping` (pong), `inventory` (event-then-result, moved verbatim from daemon `dispatch`), `terminate`, `kill`, `input`, `resize`, `capture`, `stat_dir`, `probe`, `probe_resume`, `remove_paths`. Unhandled types (launch/prompt_deliver/log_read/tail_*/write_file) keep `{ ok:false, error:"unsupported" }` until their tasks flip them.
- Result data: `capture` → bare string; `probe` → `NodeProbeEntry[]` (capture INCLUDED for alive sessions — see guard below); `stat_dir` → `{ path: <realpath>, isDirectory: true }`, `ok:false error:"ENOENT: <path>"` / `"ENOTDIR: <path>"` otherwise; `probe_resume` → `{ canResume }`; `remove_paths` → `{ removed }`; the rest `{ ok:true }`.

- [ ] **Step 1: Failing `commands-basics.test.ts`** — a fake `CommandContext` with a scripted fake tmux (plain object satisfying the used `TmuxRunner` methods; type it `as unknown as TmuxRunner`) and a fake `ws` collecting events; a real `SessionMetaStore` under the preload temp home. Cases (one `it` each):
  - `terminate` runs `kill-session` strict (fake records `["-L", sock, "kill-session", "-t", id]`-equivalent call), `kill` swallows (fake throws "no server running" ⇒ still `{ok:true}`), `terminate` surfaces the throw as `{ok:false, error: …}`.
  - `input`/`resize` delegate to `sendInput`/`resizeWindow`.
  - `capture` resolves `{ok:true, data:"screen"}` from the fake.
  - `probe ["a","b"]`: alive entry gets `alive:true, exitCode:null, title/command` from fake `paneTitle`, and `capture` present; dead entry `alive:false, exitCode:3` (fake `paneExitCode`), no `capture`.
  - `probe` capture-stuffing guard: when the serialized result exceeds `NODE_MAX_FRAME_BYTES - 64 * 1024`, the executor RE-BUILDS the entries without `capture` fields (test: 200 sessions with 8 KiB captures ⇒ re-parsed via `parseNodeProbeEntries`, entries present, `capture === undefined`).
  - `stat_dir` on a real temp dir ⇒ `{ok:true,data:{path:realpathSync(dir),isDirectory:true}}`; missing ⇒ `ok:false` with `ENOENT:`; a FILE path ⇒ `ok:false` with `ENOTDIR:`.
  - `probe_resume` unknown harness ⇒ `{ok:false, error:"unknown harness"}`; a harness without `resume` ⇒ `{canResume:false}` (no fake needed — `getHarness("pi")` per the current catalog: implement against a harness id that has no resume; if all have one, use unknown id for false + a `probe`-style stub only for the true path is NOT needed).
  - `remove_paths`: two files under the temp dataDir + one under a RECORDED meta cwd ⇒ `{removed:2}` (one path absent counts not); one path OUTSIDE every root ⇒ the file still exists after AND response `ok:false` with `error:"path refused: …"` (atomicity: policy-checked for ALL paths BEFORE deleting any).
  - unknown-command path: `dispatchCommand(ctx, {type:"write_file", …} as NodeCommandBody)` ⇒ `{ok:false,error:"unsupported"}` (until Task 6 flips it — write the assertion for a still-unimplemented type like `tail_start` so the test survives later tasks… pin `launch` here; delete the case when Task 4 lands).

- [ ] **Step 2: RED** — `cd apps/agent && bun test src/__tests__/commands-basics.test.ts`.

- [ ] **Step 3: Implement** the three modules. `dispatchCommand` switch (each case calls a named function `execTerminate(ctx, cmd)` etc. in `basics.ts`, every one with a JSDoc citing the spec §). Executor bodies (representative, full set in Interfaces):

```ts
export async function execProbe(ctx: CommandContext, cmd: Extract<NodeCommandBody, { type: "probe" }>): Promise<CommandResult> {
  const entries: NodeProbeEntry[] = [];
  for (const sessionId of cmd.sessionIds) {
    const socket = tmuxSocketFor(sessionId); // same derivation the launcher uses — no stored state needed
    if (!ctx.tmux.hasSession(socket, sessionId)) {
      entries.push({ sessionId, alive: false, exitCode: ctx.tmux.paneExitCode(socket, sessionId) });
      continue;
    }
    const pane = ctx.tmux.paneTitle(socket, sessionId);
    const entry: NodeProbeEntry = { sessionId, alive: true, exitCode: null };
    if (pane) { entry.title = pane.title; entry.command = pane.command; }
    try { entry.capture = ctx.tmux.capturePane(socket, sessionId); } catch { /* raced death */ }
    entries.push(entry);
  }
  // Cap guard: captures are opportunistic (preview cache), never let them blow the frame.
  let data: NodeProbeEntry[] = entries;
  if (Buffer.byteLength(JSON.stringify(data)) > PROBE_RESULT_BUDGET_BYTES) {
    data = entries.map(({ capture: _drop, ...rest }) => rest);
  }
  return { ok: true, data };
}
export const PROBE_RESULT_BUDGET_BYTES = NODE_MAX_FRAME_BYTES - 64 * 1024;
```

(`terminate`/`kill`/`input`/`resize` use `ctx.meta.get(cmd.sessionId)?.socket ?? tmuxSocketFor(cmd.sessionId)` — the recorded socket wins; the derivation is the fallback for orphans. `stat_dir` = `realpath`→`stat`; `remove_paths` per the test above. Every catch ⇒ `{ ok:false, error: <message> }`, never a throw escaping `dispatchCommand` — wrap the switch body once.)

- [ ] **Step 4: Daemon rewiring — incl. the SERIAL executor (spec §3.4).** `dispatch` in `daemon.ts` becomes `dispatchCommand(ctx, cmd)` with the `CommandContext` built once per `runDaemon` (tmux = `new TmuxRunner()`, meta store = `new SessionMetaStore(config.dataDir)`); `send()` gains the outbound guard: `const size = new Blob([payload]).size; if (size > NODE_MAX_FRAME_BYTES) { log(\`oversize ${ev.type} event suppressed (${size}B)\`); return; }` (events, not closes — mirrors the inbound ignore). Pass `ws` wrapper exposing `bufferedAmount` (Bun's `WebSocket` client does not surface it — type it optional and read `(ws as unknown as {bufferedAmount?: number}).bufferedAmount`; daemon tests fake it).
  **Serial execution (new, was implicit in phase 1 and becomes load-bearing now):** `onFrame` currently runs `void onFrame(...)` per message — two frames can interleave `execute` (a slow `launch` behind a `write_file`). Fix: a process-scope promise chain in `runDaemon` — `execChain = execChain.then(() => execute(ws, claims)).catch(err => log(...))` — so verified commands run **serially in arrival order** across the whole daemon life (survives reconnects; the jti LRU + idempotence map keep a cross-reconnect replay safe, per the P1-T13 "in-flight verify across `seqTracker.reset`" note — a command verified pre-reset executing post-reset is harmless because effects key by jti). Test: two commands whose fake handlers record start/end order; the second starts only after the first's promise resolves.
- [ ] **Step 5: GREEN + trio** (`bun add @internal/backend-errors` in apps/agent if absent — workspace dep, pinned by workspaces) — [ ] **Step 6: Commit** `feat(agent): phase-2 command dispatch + basic executors (spec §7)`

---

### Task 4: Agent `launch` executor + exit watcher + `sessions_report`

**Files:**
- Create: `apps/agent/src/commands/launch.ts`
- Create: `apps/agent/src/commands/report.ts`
- Modify: `apps/agent/src/commands/index.ts` (wire `launch`; keep `unsupported` for the rest)
- Modify: `apps/agent/src/daemon.ts` (capabilities now `["uploads"]` — the upload receiver lands in Task 6, MCP joins in Task 13; connect-time `sessions_report` send after `ready`; `readyEvent` gains `executablePath: process.execPath` (Task 1's additive field))
- Create: `apps/agent/src/__tests__/commands-launch.test.ts`
- Modify: `apps/agent/src/__tests__/commands-basics.test.ts` (delete the pinned `launch` ⇒ unsupported case)

**Interfaces:**
- Consumes: `buildLaunchCommand`/`curatedEnv`/`getHarness`/`TmuxRunner` from `@internal/harnesses` (exact signatures per phase-0 freeze — confirm against `packages/harnesses/src/index.ts` exports when writing the code); `NodeProbeEntry`? no; result = `{ok:true}`.
- Produces:
  - `execLaunch(ctx, cmd)`: (1) `harness = getHarness(cmd.harnessId)` else `ok:false "unknown harness"`; (2) `binary = await harness.findBinary()` else `ok:false "harness binary missing: <id>"` — this exact message class is what the backend maps to inventory-refresh-on-failure (spec §6.2); (3) `cmd.mcp` present ⇒ policy-check `cmd.mcp.path` under dataDir (`pathAllowed`, else `ok:false "mcp path refused"`), `mkdir <dataDir>/mcp` + write 0600 (reuse the Task-2 enforce-mode pattern); (4) meta recorded FIRST (`ctx.meta.record`) so path policy + socket lookup see the cwd even if tmux throws; (5) pane command assembled per §6.4 — see Step 3; (6) `tmux.newSession(cmd.socket, cmd.sessionId, cmd.cwd, paneCmd)`; on throw ⇒ `meta.forget` rollback, `ok:false`; (7) `mkdir <dataDir>/sessions` + `tmux.pipePane(cmd.socket, cmd.sessionId, ctx.meta.logPath(cmd.sessionId))` — STRICT by default (createSession parity), but when `cmd.bestEffortLog === true` the mkdir+pipePane pair is wrapped together in try/catch with one warn line and the launch still answers `{ok:true}` (the revive parity case — mirror of `LocalLauncher.launch`'s guarded region; keep the wrap around BOTH steps, a throwing mkdir is as fatal as a throwing pipe-pane); (8) `cmd.cols/rows` ⇒ `resizeWindow` best-effort (log-and-continue); (9) `startExitWatcher(ctx, cmd.sessionId)`; (10) `{ok:true}`.
  - `startExitWatcher(ctx, sessionId)`: 2 s `setInterval` (`.unref?.()`): pane gone ⇒ send `{type:"exit", sessionId, exitCode: paneExitCode(…) ?? null, at: iso(nowMs())}`, clear interval, `meta.forget`, drop any tail handles for the id. Register in `ctx.watchers`; `execTerminate`/`execKill` (Task 3, via a new `stopWatcher(ctx, id)` export from report.ts) clear it so deliberate kills don't double-report… spec says exit events + sweep are idempotent both ways — the backend `applyRemoteExit` is idempotent, so keep firing on natural death only (a watcher already stopped on deliberate kill is the cheap rule; a raced event is harmless).
  - `buildSessionsReport(ctx): Promise<Extract<NodeEvent, {type:"sessions_report"}>>` — for each `meta.list()` entry: `{sessionId, alive: hasSession(socket,id), exitCode: alive ? null : (paneExitCode(…) ?? null)}` (spec §3.3: "panes surviving agent restart").

- [ ] **Step 1: Failing tests** — fake tmux records the ordered calls. Cases: happy launch asserts call ORDER `newSession → pipePane(logPath)` + resize, meta persisted (read back), `{ok:true}`; `findBinary` null ⇒ `ok:false /binary missing/` and NO tmux calls; newSession throws ⇒ `ok:false` + meta forgotten; mcp path outside dataDir (`/etc/passwd`) ⇒ `ok:false /refused/` + no spawn; mcp happy ⇒ file exists mode 600 with exact content; watcher: fake tmux flips `hasSession` false after first tick with `paneExitCode ⇒ 7`, fake `ws` collects the `exit` event (use injected `nowMs` + short `setInterval` real timers with `waitFor` polling helper à la daemon tests); `buildSessionsReport` over two recorded metas (one alive, one dead exit 2).

- [ ] **Step 2: RED** — [ ] **Step 3: Implement** `launch.ts`.

> **MCP dialect on the node (resolved design, cite in code):** the frozen `launch` cmd carries only `mcp:{path,fileContent}` — but the plugin dialect's **argv** (`--mcp-config <path>` for claude) and **env** (opencode's `OPENCODE_CONFIG`) come from `McpRegistration.args/.env`, which never ride the wire. Fix: the AGENT re-runs the plugin locally — `harness.mcpRegistration?.({ command: process.execPath, args: ["mcp"] }, cmd.mcp.path)` — same function the control plane runs host-side (`services/mcp-launch.ts:91`), producing the byte-identical dialect for the machine the pane lives on. The registration's `fileContent` is written from the WIRE value when present (the control plane computed it against `ready.executablePath`, Task 1), else from the locally-regenerated `reg.fileContent`; `reg` (args+env) is always the agent's own. `executablePath` absent on an old-but-capable agent? Impossible in practice (capabilities+field land together), and the agent-local `reg` self-heals content anyway — a mismatch between wire content and local content logs one warning and the LOCAL content wins.

The assembly step, full (the §6.4 byte-parity rule — the SAME function local launches run, `buildHarnessCommand` composes `curatedEnv() ⊕ moteEnv ⊕ profile.env ⊕ mcp.env` internally):

```ts
import { buildHarnessCommand, getHarness, type McpRegistration, type ProfileDefinition, tmuxSocketFor } from "@internal/harnesses";

// cmd.profile is the structural wire mirror — same field names, validator already ran.
const profile = cmd.profile as unknown as ProfileDefinition;
const harness = getHarness(cmd.harnessId);
if (!harness) return { ok: false, error: `unknown harness: ${cmd.harnessId}` };
const reg: McpRegistration | undefined = cmd.mcp
  ? harness.mcpRegistration?.({ command: process.execPath, args: ["mcp"] }, cmd.mcp.path)
  : undefined;
// ... write the mcp file (0600) per the note above, then:
const paneCmd = buildHarnessCommand(
  harness, binary, cmd.cwd, profile, cmd.sessionName, cmd.moteEnv, reg, cmd.harnessSession,
);
```

Task 8's RemoteLauncher mirrors this decision: it composes the control-side registration with `{command: conn.agent?.executablePath ?? "mote-agent", args: ["mcp"]}` so the wire content is honest, while knowing the agent's local regeneration governs.

- [ ] **Step 4: Implement** `report.ts` + daemon hook: after the `ready` send in the `open` handler, `send(ctx.ws, await buildSessionsReport(ctx))` (fire-and-forget with catch-log). Capabilities: `["uploads"]` now (write_file receiver lands Task 6; the capability advertises the phase-2 command set, `mcp` joins in Task 13 only when the subcommand ships — gate on a `HAS_MCP` compile-time-ish const that Task 13 sets).
- [ ] **Step 5: Manual tmux smoke (gated `which tmux`, else skip)**: launch the pi-stub harness? No pi in agent tests — use `claude`? NO. Real-tmux case: script a `TmuxRunner` against socket `mote-test-<uuid>` running `/bin/sh -c 'echo hi; sleep 30'` through a FAKE harness object satisfying the `HarnessPlugin` fields the executor reads (`buildCommand`→["/bin/sh","-c",…], `findBinary` async ⇒ "/bin/sh"). Assert pane alive via `hasSession`, then kill it and poll for the `exit` event. Always `.finally(killSession)` + clean socket.
- [ ] **Step 6: GREEN + trio** — [ ] **Step 7: Commit** `feat(agent): launch executor (local launch assembly, §6.4 byte-parity) + exit watcher + sessions_report`

---

### Task 5: Agent `prompt_deliver` + log-read/tail executors

**Files:**
- Create: `apps/agent/src/commands/prompt.ts`
- Create: `apps/agent/src/commands/tail.ts`
- Modify: `apps/agent/src/commands/index.ts`
- Create: `apps/agent/src/__tests__/commands-prompt-tail.test.ts`

**Interfaces:**
- Consumes: `stripAnsi` from `@internal/backend-errors`; result contracts `NodePromptDeliverResult`/`NodeLogReadResult` (Task 1); `NodeEvent` `output` shape (frozen).
- Produces:
  - `execPromptDeliver(ctx, cmd)`: verbatim port of `LocalLauncher.deliverPrompt` (settle: `stripAnsi(capture).trim()` poll until `settleTimeoutMs`, `pollMs` cadence; then `sendInput` + `pressEnter`; throws swallowed) ⇒ `{promptDelivered}`. Never rejects.
  - `execLogRead(ctx, cmd)`: `const file = Bun.file(meta.logPath(id))`; missing ⇒ `{bytes_b64:"", next:cmd.fromByte, size:0}`; `fromByte >= size` ⇒ same with real `size`; else slice `[fromByte, min(size, fromByte+maxBytes))` ⇒ `{bytes_b64: Buffer.from(bytes).toString("base64"), next: fromByte + n, size}`.
  - `execTailStart(ctx, cmd)`: register a `TailHandle` in `ctx.tails` keyed by `subId` (replace-with-stop on dup subId — defensive); pump = port of `LocalLauncher.tailStart` (watch + `TAIL_BACKSTOP_MS`-style 1000 ms backstop + `pumping/again` serialization), seeded by an immediate catch-up read; each read slice is further chunked to **≤ 192 KiB raw** per `output` event (spec §3.1), base64 in `data_b64`, offsets `{fromByte, toByte}`; before each event: `while ((ctx.ws.bufferedAmount ?? 0) > TAIL_BACKPRESSURE_BYTES) await sleep(50)` with `TAIL_BACKPRESSURE_BYTES = 512 * 1024` (agent-side mirror of the spec's backpressure; bounded only by stop/shutdown).
  - `execTailStop(ctx, cmd)`: stop + delete handle; `{ok:true}`. `stopAllTails(ctx)` exported (daemon close path calls it — on socket drop, tails would push into a dead ws otherwise; wire into the `close`/`finish` path).

- [ ] **Step 1: Failing tests** — prompt: fake tmux returns "" for 2 polls then "ready", `nowMs`/timers via short `settleTimeoutMs=200, pollMs=20` (fake tmux counts captures; asserts input+enter ran) and a never-settles case ⇒ `{promptDelivered:false}` with NO input. tail: real temp log file under temp home (logPath), write "abc" BEFORE `tail_start` ⇒ one `output` event (subId/fromByte 0/toByte 3/data_b64 "abc"); append "de" later ⇒ second event `{fromByte:3,toByte:5}`; `tail_stop` then append ⇒ nothing; chunking: write 300 KiB in one go ⇒ ≥2 events each ≤ 192 KiB raw (decode-length assert); `log_read` cases per Interfaces incl. missing file and mid-file slice. Use fake ws with a settable `bufferedAmount` (one case: high backpressure delays the second chunk — assert eventual delivery, not timing).
- [ ] **Step 2: RED** — [ ] **Step 3: Implement** per Interfaces (bodies are near-verbatim ports; every comment citing "pre-seam" becomes "port of LocalLauncher.tailStart / deliverPrompt, spec §3.4/§6.5").
- [ ] **Step 4: GREEN + trio** — [ ] **Step 5: Commit** `feat(agent): prompt settle loop + log read/tail executors (ports of the launcher seams, spec §3.4)`

---

### Task 6: Agent `write_file` chunk receiver

**Files:**
- Create: `apps/agent/src/commands/write-file.ts`
- Modify: `apps/agent/src/commands/index.ts`
- Create: `apps/agent/src/__tests__/commands-write-file.test.ts`

**Interfaces:**
- Consumes: `pathAllowed`/`realpathRoots` + meta store (Task 2); `NodeWriteFileResult` (Task 1).
- Produces: module-scope-free state INSIDE the context: extend `CommandContext` with `uploads: Map<string, UploadState>` (`UploadState = { tmpPath: string; received: number }` — declare in `context.ts` now). Semantics:
  - key = the FINAL `cmd.path` (resolved); `chunk` must equal `state.receivedChunks` order index (track `expectedChunk` too).
  - First chunk (index 0) for a path (fresh or RESTARTED — chunk 0 on an existing state replaces the temp, the mid-stream-failure recovery rule): policy-check happens on `pathAllowed(finalPath, dataDir+trackedCwds)` up front; tmp = `<dataDir>/tmp/upload-<sha1(path)>.part`, `mkdir <dataDir>/tmp {mode:0o700}`.
  - Chunk N>0 with no/short state ⇒ `ok:false "write_file chunk <N> has no open stream"`.
  - Append decoded bytes, bump `received`; every chunk answers `{ path, received }`.
  - `eof:true` ⇒ policy RE-CHECK (ancestors may have symlinked since), `mkdir -p dirname(final)`, `rename(tmp, final)` (same fs — tmp under dataDir, final may not be… **cross-device rename risk**: final lives under the session cwd, tmp under dataDir — a different mount ⇒ EXDEV. Fix: put the tmp NEXT TO the final: `<dirname(final)>/.<basename>.part-<jti-ish>` after policy pass. Update UploadState accordingly; dataDir/tmp only as fallback when the dir is not yet policy-passable — it never is pre-first-chunk, so: FIRST chunk policy-checks + creates parent dir, tmp lives beside final. Non-eof failure ⇒ delete tmp + drop state on the NEXT chunk-0 overwrite; also `cleanupStaleUploads(ctx)` (tmp files older than 1 h, called once at daemon start).
- [ ] **Step 1: Failing tests** — happy 2-chunk + eof into a recorded-cwd `uploads/` dir: file content exact, mode 600, no `.part` left; out-of-order chunk rejected; path outside roots rejected with no temp created; chunk-0-restart after "failure" overwrites cleanly; wrong-size scenario is impossible by construction (agent sums what it got; the FINAL verify the spec mentions is backend-side: the route re-issues a `stat`? no — `received` total is echoed per chunk; backend asserts `received === file.size` on the eof result, Task 12); mid-stream `eof` on path that escaped via symlink created after chunk 0 ⇒ re-check catches it (build the symlink mid-test).
- [ ] **Step 2: RED** — [ ] **Step 3: Implement.** — [ ] **Step 4: GREEN + trio** — [ ] **Step 5: Commit** `feat(agent): chunked write_file receiver with path-policy gates (spec §3.4)`

---

### Task 7: Backend event plane — agent facts, output bus, lifecycle hooks, serialized dispatch

**Files:**
- Create: `apps/backend/src/services/nodes/node-events.ts`
- Create: `apps/backend/src/services/nodes/__tests__/node-events.test.ts`
- Modify: `apps/backend/src/services/nodes/node-registry.ts` (`NodeConnection.agent?: NodeAgentFacts`; `disconnectNode` fails that connection's pendings BEFORE detaching — **P1-T9 carry**: "any eviction without real socket close must failConnPendings itself")
- Modify: `apps/backend/src/services/nodes/node-ws-handler.ts` (`ready` → stash facts on the conn; `output`/`exit`/`sessions_report` cases replace the phase-1 "ignored" debug; add `handleNodeMessageQueued`)
- Modify: `apps/backend/src/ws/ws.plugin.ts` (message hook calls `handleNodeMessageQueued` — **P1-T10 carry**: fire-and-forget dispatch deserialized event-vs-result ordering)
- Modify: `apps/backend/src/services/nodes/node-rpc.ts` (DELETE `failAllFor` + its two test cases — dead since phase 1, **P1 backlog**; the eviction path now owns failing pendings)
- Modify: `apps/backend/src/api/nodes/recheck-route` (JSDoc only: with serialized dispatch, `{ok:true}` now truthfully attests "inventory stored" — **P1-T10 carry**)

**Interfaces:**
- Consumes: `NodeEvent` (frozen), registry records.
- Produces (exact names; Tasks 8/10/11 build on these):
  - `interface NodeAgentFacts { /** agent-side <dataDir> — composes log/mcp paths (spec §6.4) */ dataDir: string; /** capability strings from ready ("uploads", "mcp") */ capabilities: string[]; hostname: string; agentVersion: string; /** agent process.execPath (Task 1 additive field) — MCP launch spec target */ executablePath?: string }` — declared in **node-registry.ts**, added to `NodeConnection` as `agent?: NodeAgentFacts`.
  - `subscribeOutput(subId: string, handler: (ev: Extract<NodeEvent, { type: "output" }>) => void): () => void` — module-scope map, disposer removes; `dispatchOutput(ev): boolean` returns false for unknown subId.
  - `interface NodeLifecycleHooks { onExit(nodeId: string, sessionId: string, exitCode: number | null, at: string): Promise<void> | void; onSessionsReport(nodeId: string, report: Extract<NodeEvent, { type: "sessions_report" }>["sessions"]): Promise<void> | void }` + `setNodeLifecycleHooks(hooks: NodeLifecycleHooks | undefined): void` (Task 10 registers; unregistered ⇒ one warn line per event, nothing else).

- [ ] **Step 1: Failing tests** — subscribe/dispose/dispatch round-trip; unknown subId ⇒ false; `ready` frame through `handleNodeMessage` with a fake repo sets `ws.data.nodeConn.agent` exactly (`dataDir/capabilities/hostname/agentVersion/executablePath`); an `exit` frame reaches a registered hook with the conn's nodeId (NOT a caller-supplied one); `handleNodeMessageQueued` ordering: injected deps whose `nodes.touch` (heartbeat) blocks on a deferred promise ⇒ a following `inventory` frame's `applyInventory` runs only after the touch resolves (fake-socket script: heartbeat then inventory).
- [ ] **Step 2: RED** — `cd apps/backend && bun test src/services/nodes/__tests__`.
- [ ] **Step 3: Implement** — `node-events.ts` is two module Maps + the hooks slot (JSDoc each; `resetNodeEventsForTests()` @internal). Handler wiring in `node-ws-handler.ts`:

```ts
case "ready": { …existing applyReady + protocol floor…;
  const conn = ws.data.nodeConn ?? getLive(nodeId);
  if (conn) conn.agent = { dataDir: event.dataDir, capabilities: event.capabilities, hostname: event.hostname, agentVersion: event.agentVersion, ...(event.executablePath ? { executablePath: event.executablePath } : {}) };
  deps.requestInventory(nodeId); return; }
case "output": if (!dispatchOutput(event)) logger.debug(`node ws: output for unknown subId ${event.subId} dropped`); return;
case "exit": if (hooks) await hooks.onExit(nodeId, event.sessionId, event.exitCode, event.at); else logger.warn(`node ws: exit for ${event.sessionId} with no lifecycle hook`); return;
case "sessions_report": if (hooks) await hooks.onSessionsReport(nodeId, event.sessions); return;
```

  `disconnectNode` gains `failConnPendings(conn, "offline", "node evicted (rotate/delete)")` before `detachConnection` (import — both live in `services/nodes/`, no cycle: registry imports rpc types only today; verify import direction, and if node-rpc imports registry (it does), keep the call INSIDE registry and import `failConnPendings` lazily… **it would cycle**. Resolution: move the fail call to the CALLERS of `disconnectNode` (rotate/revoke/delete routes already import both modules) — do it there, keep registry dependency-free, update its JSDoc pointer.)
- [ ] **Step 4: GREEN + trio** — [ ] **Step 5: Commit** `feat(nodes): agent-facts on connections, output bus + lifecycle hooks, serialized frame dispatch (spec §3.3, P1 carries)`

---

### Task 8: `RemoteLauncher` + launcher resolution

**Files:**
- Create: `apps/backend/src/services/nodes/remote-launcher.ts`
- Create: `apps/backend/src/services/nodes/launcher-registry.ts`
- Modify: `apps/backend/src/services/nodes/node-launcher.ts` (additive optional `LaunchPlan.mcpConfigPath?: string` + JSDoc: "absolute path ON THE TARGET machine where RemoteLauncher ships `mcp.fileContent` — composed by the caller from the node's `ready.dataDir` (spec §6.4); LocalLauncher ignores it, its file was already written by `registerSessionMcp`")
- Create: `apps/backend/src/services/nodes/__tests__/remote-launcher.test.ts`

**Interfaces:**
- Consumes: `sendCommand`/`NodeRpcError` (node-rpc), `subscribeOutput` (Task 7), `readAgentInventory` (`services/nodes/inventory.ts`), `NodesRepository.findById`, `parseNode*` result validators (Task 1), `LOG_TAIL_BYTES`/`LOG_TAIL_LINES` + the Task-11 helpers (`replayOffsetFromWindow`, `tailLinesFromWindowText` — CREATE them here in `services/nodes/log-tail.ts` as pure functions, refactoring the existing two readers to call them WITHOUT behavior change — existing log-tail tests pin that).
- Produces:
  - `class RemoteLauncher implements NodeLauncher` — `constructor(nodeId: string, deps: RemoteLauncherDeps = {})` with seams `{ send?: typeof sendCommand; nodes?: Pick<NodesRepository, "findById">; facts?: (nodeId: string) => NodeAgentFacts | undefined }` (defaults: real `sendCommand`, requestless-ctx repo, `getLive(nodeId)?.agent`).
  - `launcherFor(nodeId: string): NodeLauncher` — `LOCAL_NODE_ID → defaultLocalLauncher`, else a module-cached `RemoteLauncher` per id (stateless besides nodeId — all live state is on the connection). `resetLauncherRegistryForTests()` @internal.
- Command mapping (every method one `sendCommand` unless noted; timeouts in parentheses):

| Launcher method | Wire command → result handling |
|---|---|
| `validateWorkingDir(raw)` | `stat_dir {path}` (5 s) → `parseNodeStatDirResult(data).path` (the AGENT's realpath — parity with the local return). `NodeRpcError("failed")` → rethrow `new Error(message)` so callers see the same throw SHAPE as `LocalLauncher` ("Path does not exist: …"). |
| `resolveBinary(harness)` | NO network: repo row → `readAgentInventory(node).entries.get(harness.id)?.binaryPath ?? null`; when `inv.stale`, fire-and-forget `sendCommand(nodeId, {type:"inventory"})` (refresh-on-demand, spec §6.2) — never awaited, errors debug-logged. |
| `launch(plan)` | `launch {sessionId, socket, cwd, harnessId: plan.harness.id, profile: plan.profile, moteEnv: plan.moteEnv, mcp: plan.mcp ? { path: plan.mcpConfigPath!, fileContent: plan.mcp.fileContent } : undefined, harnessSession: plan.harnessSession, sessionName: plan.sessionName, bestEffortLog: plan.bestEffortLog}` (60 s; the flag rides the wire — Task 1 field 1). **`LaunchPlan` gains `mcpConfigPath?: string`** — an additive OPTIONAL field on the phase-0 interface (interface signatures unchanged — allowed "additive with version note"; local path ignores it). On `NodeRpcError("failed")` with message matching `/binary missing/i`: fire-and-forget inventory refresh then rethrow (spec §6.2). |
| `terminate` / `killSession` | `terminate` (throws on `ok:false`) / `kill` — but `killSession` must SWALLOW "already gone": agent answers `ok:false "no session"` for a dead pane; map that specific error to a no-op (`/no session|can't find session/i`). |
| `hasSession` / `paneExitCode` / `paneTitle` | ONE-entry `probe` (5 s): `[entry] = parseNodeProbeEntries(data)`; alive / `entry.exitCode` / `entry.alive && entry.title != null ? {title, command: entry.command ?? ""} : null`. |
| `capture` | `capture` (10 s) → `parseNodeCaptureResult`. |
| `resize` / `sendInput` | `resize` / `input` verbatim. |
| `deliverPrompt` | `prompt_deliver {sessionId, text, settleTimeoutMs, pollMs}` (timeout = `settleTimeoutMs + 30_000`) → `parseNodePromptDeliver(data).promptDelivered`; any rpc error ⇒ `false` (mirrors "never throws"). |
| `logPath(id)` | `${facts().dataDir}/sessions/${id}.log`; throws `new Error(\`node "${nodeId}" has no live connection\`)` when facts absent. |
| `readLog(id, fromByte, maxBytes)` | `log_read` (10 s) → `{bytes: decodeB64(r.bytes_b64), next: r.next}`. |
| `readLogTail(id)` | `log_read(0, 1)` for `size` → `log_read(max(0, size - LOG_TAIL_BYTES), LOG_TAIL_BYTES)` → `tailLinesFromWindowText(text, start>0)` (pure helper) → `{lines: stripAnsi-sliced, truncated}` identical to local. |
| `tailStart(id, subId, fromByte, onChunk)` | see Step 3 sketch — event bus + gap resume. |
| `canResume(harness, storedId, cwd)` | `probe_resume {harnessId: harness.id, harnessSessionId: storedId, cwd}` → `parseNodeProbeResume(data).canResume`; rpc error ⇒ `false` (a dead/unreachable node can't resume — the caller falls back to a fresh id, which is exactly the local "transcript gone" behavior). |
| `writeArtifact(id, _kind, content)` | single `write_file {path: \`${facts().dataDir}/mcp/${id}.json\`, chunk_b64, chunk: 0, eof: true}` (30 s) → returns the path (agent's path policy passes: under dataDir). |
| `removeArtifacts(paths)` | `remove_paths {paths}` (10 s), errors swallowed per-path semantics already agent-side; catch ALL rpc errors (best-effort like local's per-path try). |

- [ ] **Step 1: Failing tests** — with `send` seam recording `(cmd, timeoutMs)` and returning scripted results: the mapping table asserted per method (exact cmd objects via `toEqual`, including `mcp.path` from `mcpConfigPath`, prompt timeout math, `killSession` swallowing `/no session/`); `validateWorkingDir` rethrow shape; `resolveBinary` cache + stale-refresh (asserts refresh NOT awaited but fired); `tailStart`: `subscribeOutput` + manual `dispatchOutput` sequences — in-order chunks monotonic, GAP (event fromByte > cursor) triggers a scripted `log_read` backfill emitted to onChunk BEFORE the gap event's bytes, DUP (fromByte < cursor) clamped, disposer unsubscribes + fires `tail_stop`; offline: every facts-dependent method throws/rejects without calling `send`.
- [ ] **Step 2: RED** — **Step 3: Implement** (class with a private `#send(cmd, ms)` wrapper = `this.#deps.send(this.#nodeId, cmd, ms)`). The `tailStart` core (order-preserving via an internal promise chain):

```ts
async tailStart(id, subId, fromByte, onChunk): Promise<() => void> {
  let cursor = fromByte;
  let queue: Promise<void> = Promise.resolve();
  const unsubscribe = subscribeOutput((ev) => {
    if (ev.sessionId !== id) return;
    queue = queue.then(async () => {
      if (ev.fromByte > cursor) {
        const backfill = await this.readLog(id, cursor, ev.fromByte - cursor).catch(() => ({ bytes: new Uint8Array(0), next: cursor }));
        if (backfill.bytes.byteLength) { cursor = backfill.next; onChunk(backfill.bytes, cursor); }
      }
      let bytes = Buffer.from(ev.data_b64, "base64");
      if (ev.fromByte < cursor) bytes = bytes.subarray(Math.max(0, cursor - ev.fromByte)); // already-delivered prefix
      if (bytes.byteLength === 0) return;
      cursor = ev.toByte;
      onChunk(bytes, cursor);
    }).catch((err: unknown) => logger.withError(err).warn(`remote tail relay failed for ${id}`));
  });
  await this.#send({ type: "tail_start", sessionId: id, subId, fromByte }, 10_000);
  return () => {
    unsubscribe();
    void this.#send({ type: "tail_stop", subId }, 5_000).catch(() => undefined);
  };
}
```

- [ ] **Step 4: log-tail pure-helper refactor** (same commit or split — reviewer's call): extract from `logReplayStartOffset` → `replayOffsetFromWindow(windowStart: number, text: string, lines: number): number` and from `readLogTailFrom` → `tailLinesFromWindowText(text: string, startWasZero: boolean): { lines: string[]; truncated: boolean }`; the async readers become thin wrappers. Existing tests must pass UNEDITED — that is the refactor's proof.
- [ ] **Step 5: GREEN + trio** — [ ] **Step 6: Commit** `feat(nodes): RemoteLauncher — NodeLauncher over signed RPC (spec §6.3) + launcher resolution`

---

### Task 9: Node resolution at creation — `POST /api/sessions` goes real

**Files:**
- Modify: `apps/backend/src/api/sessions/create-session.route.ts` (DELETE lines ~36–44 `NODE_LAUNCH_NOT_READY` gate; forward `nodeId` + `machineActor: actor !== "cookie"`)
- Modify: `apps/backend/src/api/sessions/sessions.service.ts` (`createSession` gains `nodeId?: string, machineActor: boolean`; new `resolveLaunchNode`; `harnessUsable(profile.harnessId, resolvedNodeId)`)
- Modify: `apps/backend/src/services/session-manager.service.ts` (`createSession` param `nodeId?: string` → `this.#launcherFor(nodeId ?? LOCAL_NODE_ID)` replaces `#launcher` INSIDE createSession + `#reviveRow` (row-based); row write gains `nodeId`; MCP compose branch — Step 4; constructor's injected `launcher` stays as a TEST OVERRVERRIDE that wins for every node)
- Modify: `apps/backend/src/services/mcp-launch.ts` (add `planRemoteSessionMcp(harness, sessionId, facts): McpRegistration | undefined` — same dialect computation as `registerSessionMcp` but with `launch = { command: facts.executablePath ?? "mote-agent", args: ["mcp"] }` and `configPath = ${facts.dataDir}/mcp/${sessionId}.json`, and NO local file write)
- Modify: `apps/backend/src/services/session-manager.service.ts` `toSessionView` (+ `nodeOffline: boolean` LAST param, default false; `toViews`/`listSessions`/`getSession` compute `row.nodeId !== LOCAL_NODE_ID && !getLive(row.nodeId)`); every other `toSessionView` call site (grep — the sharing service) keeps the default EXCEPT its viewer paths, which pass the same computed value
- Modify: `apps/backend/src/api/models.ts` (`SessionSchema` + `nodeOffline: t.Boolean({ description: "…agent node has no live connection — the session may still be running there (spec §5.6)" })`)
- Modify: `packages/backend-errors/src/error-codes.ts` (+ `NODE_REQUIRED` — 400 "No launch-eligible node — pick one")
- Modify: `apps/backend/src/api/nodes/*` node-view shape: expose `protocolVersion: number | null` (column exists; whitelist map in nodes.service) — Task 15's "agent too old" chip reads it
- Tests: `sessions.service` resolution matrix + create-route (404/403/409/200) + manager create-with-remote-fake-launcher + nodeOffline view tests
- `turbo build` (view schema change → treaty re-infer)

**Interfaces:**
- Consumes: `loadNodeAccess`/`nodeCanLaunch` (`lib/node-access.ts` — `nodeCanLaunch` gets its FIRST production caller here), `getLive` (registry), `NodesRepository.findAccessible/listByOwner`, `launcherFor` (Task 8), `planRemoteSessionMcp`, `usableHarnessIds` (note the REAL name — the master plan's `usableHarnessIdsFor` does not exist).
- Produces: `resolveLaunchNode({ userId, isAdmin, machineActor, requestedNodeId, profile }, repos…): Promise<{ nodeId: string }>` semantics (spec §6.6, exact precedence):
  1. `requestedNodeId` given → `loadNodeAccess(deps, userId, requested, { allowAdminAndShares: !machineActor })`: row absent **or** `access === "none"` → `NotFoundError` (404 — spec §2/§6.6: invisible is 404-not-403; any share grants launch, so `none` ⇔ invisible and 403 is unreachable on this path today); agent && `getLive` absent → `throwApiError({ code: NODE_OFFLINE, statusCode-409 class, doNotLog: true })`.
  2. Else `profile.nodeId` pinned → same gate as 1 (a pin that can't launch ERRORS — never silently relocate; message "Profile is pinned to node X, which can't launch right now").
  3. Else `local` when its access (same loader, `allowAdminAndShares: !machineActor`) grants launch → `"local"` — this preserves today's behavior AND the disable-switch.
  4. Else candidates = (`machineActor ? listByOwner : findAccessible`) filtered `kind === "agent" && getLive(n.id)` → exactly 1 → use it; 0 → `throwApiError({ code: NODE_REQUIRED, … 400 … })`; **>1 → still `NODE_REQUIRED` 400** ("multiple online nodes — pick one explicitly" — the spec's "single online node" auto-pick read literally).
- Manager: `#launcherFor(nodeId)` = `this.#testLauncher ?? launcherFor(nodeId)`; ALL existing `#launcher` uses in create/revive become `#launcherFor(<the row's or resolved nodeId>)` (terminate/delete/restart read `row.nodeId`). `isAlive` keeps its LocalLauncher-only sync contract (audit its callers; an agent row reaching it throws — never in the sweep after Task 10).

- [ ] **Step 1: Failing service/route tests** — resolution matrix (request×share×online×machine), pin errors, `NODE_REQUIRED` both flavors, local-disable switch (Everyone row deleted + machineActor=false + non-admin → NODE_REQUIRED even with no agents), `harnessUsable` called WITH nodeId (spy), row persisted `nodeId`, response shape unchanged + views carry `nodeOffline` (attach a fake conn via `attachConnection` then `detachConnection` in the same test).
- [ ] **Step 2: RED** — **Step 3: Implement resolution + route + view fields.**
- [ ] **Step 4: Manager create/revive per-node** — in `createSession`: after row-intent insert and token issue, `const launcher = this.#launcherFor(nodeId)`; MCP: `nodeId === LOCAL_NODE_ID ? registerSessionMcp(harness, id) : (facts.capabilities.includes("mcp") ? planRemoteSessionMcp(harness, id, facts) : (logger.debug(…capability note…), undefined))`; `moteEnv` for agent rows overrides `MOTE_DATA_DIR: facts.dataDir` (sessionMcpEnv bakes the BACKEND path — meaningless on the node); launch plan carries `mcpConfigPath`. `#reviveRow`: launcher from `row.nodeId`, facts may be ABSENT (node offline) → throw `NodeRpcError("offline")`-flavored error so restart maps 409 and auto-restart defers (Task 10 skip covers sweep).
- [ ] **Step 5: Restart-onto-offline ⇒ 409 (spec §5.6)** — `restartSession`'s `#reviveRow` throw (Task 9 Step 4's offline-flavored error) currently escapes to the global handler as a 500. Map it in the manager's restart boundary (or the restart route's, whichever owns the error contract today — check how `restartSession`'s Errors surface now): a `NodeRpcError("offline")`/facts-absent throw ⇒ structured 409 `NODE_OFFLINE`, any OTHER revive throw keeps today's mapping. Test: manual restart on an agent row with no live conn ⇒ 409 body code `NODE_OFFLINE`, row back to its parked shape (existing rollback), token retired.
- [ ] **Step 6: GREEN + trio + `turbo build`** — [ ] **Step 7: Commit** `feat(nodes): session creation on a chosen node — §6.6 resolution, per-row launcher, nodeOffline views, offline-restart 409`

---

### Task 10: Reconcile batching, preview cache, exit/report application

**Files:**
- Create: `apps/backend/src/services/nodes/preview-cache.ts` + `__tests__/preview-cache.test.ts`
- Modify: `apps/backend/src/services/session-manager.service.ts` (`reconcileRows` agent branch, `applyRemoteExit`, `applySessionsReport`, `#preview` cache read, `maybeAutoRestart` node-awareness)
- Modify: `apps/backend/src/index.ts` (after the sweep's `manager` construction: `setNodeLifecycleHooks({ onExit: (…) => manager.applyRemoteExit(…), onSessionsReport: (…) => manager.applySessionsReport(…) })`)
- Tests in `session-manager.service.test.ts` (new describe blocks — full-suite gate rule applies)

**Interfaces:**
- Consumes: `sendCommand` + `parseNodeProbeEntries` (Task 1), `getLive`, `LOCAL_NODE_ID`, `screenTail` (module function, reuse).
- Produces:
  - `preview-cache.ts`: `PREVIEW_CACHE_TTL_MS = 60_000`; `previewCachePut(id, lines: string[])`, `previewCacheGet(id): string[] | undefined` (expiry-on-read), `previewCacheDrop(id)`, `resetPreviewCacheForTests()`.
  - `SessionManagerService.applyRemoteExit(nodeId, sessionId, exitCode, at): Promise<void>` and `.applySessionsReport(nodeId, report): Promise<void>` — idempotent against the sweep and each other: every mutation guarded by a FRESH `findById` + `restartInFlight` + `row.nodeId === nodeId` (the connection's identity scopes authority — a node cannot report for rows it doesn't own) + the same `status === "running"` re-checks the local branch uses.
- reconcileRows restructure: partition rows first — `local` rows run the CURRENT loop body verbatim (regression net); agent rows: skip when `restartInFlight.has` or `!getLive(row.nodeId)` (**spec §5.6: offline ⇒ skip, absence of socket ≠ absence of process**; debug-line the count); group survivors by `row.nodeId`; per node, `chunks(rows, PROBE_BATCH_MAX = 24)`; `sendCommand(nodeId, { type: "probe", sessionIds }, 30_000)` — errors per-chunk warn-and-continue (never abort the sweep). Apply entries: `!alive` → the local crash block (TOCTOU re-check, `alive:0 + exitCode + endedAt + waitingSince:null`, `#notifyDeath`, `maybeAutoRestart`, terminal-revoke rule) + `previewCacheDrop`; `alive` → liveness patch + title-name (same guards) + `entry.capture` ⇒ `previewCachePut(id, screenTail(entry.capture))`; `lastOutputAt` mtime probe runs ONLY for local rows (no node-side file here — relay `persistOutput` + report keep it fresh).
- `maybeAutoRestart`: `harnessUsable(fresh.harnessId, fresh.nodeId)`; early `return false` when agent row && `!getLive(fresh.nodeId)` (defer, keep backoff schedule).

- [ ] **Step 1: Failing tests** — offline-skip (row stays `running` untouched with no conn); batch ≤ 24 (30 rows ⇒ two `send` calls) + probe-error continuation; dead-entry (exit=3 ⇒ alive:0/exit/notify once/maybeAutoRestart fired); alive-entry (name from title with the existing reject-rules, backoff reset, cache filled from capture); `applyRemoteExit` idempotence (call twice ⇒ ONE notify; after sweep already marked dead ⇒ none; foreign nodeId ⇒ none; restartInFlight ⇒ none); `applySessionsReport` revive row (alive:0, reported alive ⇒ alive:1, endedAt null) and death; cache TTL expiry (injected clock).
- [ ] **Step 2: RED** — **Step 3: Implement** — **Step 4: GREEN + full trio** (never isolate the session-manager files — phase-0 gate rule) — **Step 5: Commit** `feat(nodes): reconciler speaks tmux remotely — batched probe, preview cache, exit/report application (spec §6.3)`

---

### Task 11: Live-terminal relay + remote log-tail routes

**Files:**
- Create: `apps/backend/src/ws/remote-session-ws.ts` + `__tests__/remote-session-ws.test.ts`
- Modify: `apps/backend/src/ws/session-ws.ts` (`handleSessionWs`: `const launcher = launcherFor(row.nodeId)`; when `row.nodeId !== LOCAL_NODE_ID` → `void attachRemoteSessionWs(ws, row, launcher, access)`; local code path byte-for-byte untouched)
- Modify: `apps/backend/src/services/session-manager.service.ts` (`readSessionLogTail(sessionId, nodeId = LOCAL_NODE_ID)` → `launcherFor(nodeId).readLogTail(sessionId)`; callers pass `row.nodeId` — grep `readSessionLogTail(` for the get-session-log/preview routes)
- Tests reuse the phase-1 pattern: direct calls with fake `WsSocket` + real registry `attachConnection` (fake NodeSocket scripting rpc answers like Task 8's seam — but here through the REAL `sendCommand` over the fake socket + `resolveResult`, proving the full loop)

**Interfaces:**
- Consumes: launcher (Task 8), `replayOffsetFromWindow` (Task 8 helper), `stripSyncMarkers` (exported, session-ws), `TERMINAL_REPLAY_LINES` clamp (same clamp math as local attach, applied to the REMOTE window read).
- Produces:
  - `RemoteLauncher` gains a PUBLIC non-interface member (Task 8 file, same commit if it lands first — otherwise this task adds it): `readLogSized(id, fromByte, maxBytes): Promise<{ bytes: Uint8Array; next: number; size: number }>` — the raw `log_read` triple (`readLog` stays the frozen interface's narrowed wrapper dropping `size`; nothing may widen the interface, a class-local method is the sanctioned shape).
  - `async function attachRemoteSessionWs(ws: WsSocket, row: {id, nodeId, tmuxSocket, terminalReplayLines}, launcher: RemoteLauncher, access: Access): Promise<void>` — flow: `!getLive(row.nodeId)` → `ws.close(4004, "node offline")`; `hasSession` false → `ws.close(4004, "session not running")`; `capture` → `ws.send({type:"replay", data: stripSyncMarkers(capture)})` (a capture throw → 4004, the pane raced away); replay window: `const first = await launcher.readLogSized(row.id, 0, 1)` ⇒ `size`; `windowStart = Math.max(0, size - LOG_TAIL_BYTES)`; `const win = await launcher.readLogSized(row.id, windowStart, LOG_TAIL_BYTES)`; `offset = replayOffsetFromWindow(windowStart, decode(win.bytes), cap)` (cap = the identical clamp the local attach applies); `subId = crypto.randomUUID()`; `data.cleanup = await launcher.tailStart(row.id, subId, offset, onChunk)` where `onChunk` runs: `const lag = (ws.raw as { getBufferedAmount?: () => number }).getBufferedAmount?.() ?? 0; if (lag > 4 * 1024 * 1024) { ws.close(1011, "client too slow"); return; }` (spec §3.4 — a lagging browser reconnects and replays) then `ws.send({type:"output", data: stripSyncMarkers(decode(bytes))})` + `persistOutput`. Client input/resize/cleanup ride the EXISTING `handleSessionMessage`/`cleanupSessionWs` (they already go through `data.launcher`).
- [ ] **Step 1: Failing tests** — frame contract (replay THEN outputs, sync markers stripped, byte-exact `{type:"replay"|"output"}` JSON — the browser contract, spec §6.5); offline 4004; dead pane 4004; window offset honored (fake log_read returns a 3-line window, cap 2 ⇒ first tail event starts at the computed offset); input frame → `input` cmd on the wire for `edit`, dropped for `view`; close → `tail_stop` frame; readSessionLogTail remote branch via fake conn.
- [ ] **Step 2: RED** — **Step 3: Implement.** — **Step 4: GREEN + trio** — **Step 5: Commit** `feat(ws): remote session relay — replay/tail/input over the node socket (spec §6.5, byte-identical browser contract)`

---

### Task 12: Uploads relay (`write_file` chunking from the route)

**Files:**
- Modify: `apps/backend/src/services/uploads/uploads.service.ts` (extract `export async function sniffedUpload(file: File, now?: Date): Promise<{ bytes: Uint8Array; name: string; contentType: string }>` = the sniff + `safeUploadName` prefix of `writeUpload`; `writeUpload` re-uses it — local behavior identical)
- Modify: `apps/backend/src/api/uploads/uploads.route.ts` (branch after the ownership + local-fs checks block: remote ⇒ node-online gate + `writeUploadRemote`)
- Create: `apps/backend/src/api/uploads/__tests__/uploads-remote.route.test.ts`

**Interfaces:**
- Consumes: `sendCommand`, `launcherFor`? NO — the route calls `sendCommand` directly (uploads are not a launcher concern); `uploadsDirFor`/`safeUploadName` composition against `row.workingDir` (strings only — never local fs), `parseNodeWriteFileResult` (Task 1).
- Produces: `async function writeUploadRemote(nodeId: string, workingRealPath: string, file: File): Promise<UploadResult>` in `uploads.service.ts` — chunk loop: `UPLOAD_CHUNK_BYTES = 512 * 1024` (Global Constraints; NEVER 768 KiB — spec erratum), `for (let i = 0, off = 0; off < bytes.length; i++, off += UPLOAD_CHUNK_BYTES)` send `write_file { path, chunk_b64: Buffer.from(bytes.subarray(off, off + UPLOAD_CHUNK_BYTES)).toString("base64"), chunk: i, eof: off + UPLOAD_CHUNK_BYTES >= bytes.length }` per piece (30 s each, AWAITED in order — the per-node `sendChain` serializes anyway, and chunk order is contractual); final result's `received === bytes.byteLength` else `UploadError("node received N of M bytes")`; rpc failure ⇒ wrap as `UploadError` with the NodeRpcError message (route maps to 502 `NODE_UNREACHABLE`, offline pre-gate to 409 `NODE_OFFLINE`); response `{ path, name, size, contentType }` shape-stable with local. `ensureGitExcluded` skipped for remote (debug line: node-side git exclude stays operator-controlled).
- [ ] **Step 1: Failing tests** — fake node conn capturing frames: a 1,048,576-byte file ⇒ exactly 2 frames (512 KiB + 512 KiB); a 1,048,577-byte file ⇒ 3 frames (final chunk 1 byte); assert `chunk` indices 0..N−1, `eof` false…true, base64 re-decodes to the original bytes, final frame path === `${workingDir}/.mote/uploads/2026…-name.ext` (the real `safeUploadName` shape); mid-stream `ok:false` ⇒ 502 body code `NODE_UNREACHABLE`, and NO frames captured after the failing one (route stops the loop — no eof is sent); offline pre-gate ⇒ 409 without a single frame; `received` mismatch on the eof result ⇒ 502 (agent tmp self-heals per Task 6's chunk-0-restart rule — note in JSDoc); MAX_UPLOAD_BYTES schema rejection unchanged (existing test).
- [ ] **Step 2: RED** — **Step 3: Implement** — **Step 4: GREEN + trio** — **Step 5: Commit** `feat(uploads): relay files to agent nodes via chunked write_file (spec §3.4, 512 KiB chunks)`

---

### Task 13: `mote-agent mcp` — MCP server port + `mcp` capability

**Files (all create under `apps/agent/src/mcp/` unless noted):**
- Port: `api-client.ts`, `crypto.ts`, `identity-store.ts`, `pin-store.ts`, `server.ts`, `tools.ts` from `apps/backend/src/mcp/` (same file names; keep every JSDoc/spec citation)
- Create: `apps/agent/src/mcp/main.ts` (`runAgentMcp(): Promise<void>` — the `mote mcp` entry minus backend-service imports)
- Modify: `apps/agent/src/cli.ts` (COMMANDS += `mcp`; no flags; missing `MOTE_*` env ⇒ exit 2 with the actionable line), `apps/agent/src/index.ts` (export), `apps/agent/src/daemon.ts` (`HAS_MCP = true`, `readyEvent` capabilities → `["uploads", "mcp"]`)
- Modify: `apps/agent/package.json` (add `"@modelcontextprotocol/server": "2.0.0"`, `"zod": "4.4.3"` — EXACT backend pins, then `bun install` + `bun run syncpack:lint`)
- Tests: `apps/agent/src/mcp/__tests__/{identity-store,pin-store,tools}.test.ts` (preload temp home), `apps/agent/src/__tests__/cli-mcp.test.ts`

**Interfaces:**
- Port contract (the ONLY sanctioned substitutions — everything else copies; deviations get a comment + this list reference):
  - Backend imports (`@/constants.js`, `@/services/*`, `@/utils/logger.js`) → pane env: `MOTE_API_KEY`, `MOTE_BASE_URL`, `MOTE_SESSION_ID`, `MOTE_SESSION_NAME`, `MOTE_DATA_DIR` (set by `sessionMcpEnv`; on nodes Task 9 overrides `MOTE_DATA_DIR` to the agent dataDir — so identity/pins land at `${MOTE_DATA_DIR}/mcp/identity-${MOTE_SESSION_ID}.json` mirroring the local layout).
  - `logger.*` → the agent's one-line `log()`.
  - Session-identity semantics UNCHANGED (same ECDH keypair format; the backend registered the `sess` principal at session creation — a node's agent reading `identity-<id>.json` under its own dataDir is exactly local behavior relocated; the file is delivered when… it is NOT: on nodes the identity keypair must be created fresh. Verify during port: if `identity-store.ts` creates-on-miss (it does — generated 0600 like `agent/src/identity.ts`), the node session simply gets its OWN keypair, registers via the existing channel join REST path, and E2EE works. If creation is control-side only, STOP and report — that would reshape the launch payload.)
  - `mcpRegistration` in claude/opencode plugins references the launch spec's command STRING — already correct for `executablePath`; no plugin change.
- Backend capability gate (Task 9) needs no change; add a route-level test asserting `planRemoteSessionMcp` is SKIPPED (env-only + log note) when facts.capabilities lack `"mcp"` — belongs to this task's commit so gate+provider land together.
- [ ] **Step 1: Spike commit first** — read all seven backend files; produce the substitution table as a code comment block at the top of `mcp/main.ts` listing every import you had to rehome (this IS the deliverable the master plan called "unknown surface"; expected ≤ 10 substitutions — if more, report before porting).
- [ ] **Step 2: Failing tests** — identity/pin stores under `MOTE_DATA_DIR` temp: fail-closed on corrupt (throw, never regenerate silently — parity with backend tests); `runAgentMcp` with missing `MOTE_API_KEY` refuses cleanly; one tools.ts handler with `fetch` stubbed asserts the REST call the backend twin makes (clone its assertion).
- [ ] **Step 3: RED → port → GREEN**, then trio + `bun run compile` (apps/agent) — run the compiled binary `MOTE_API_KEY= … ./dist/mote-agent mcp` expecting a clean startup line + EOF-exit (stdio server with no client).
- [ ] **Step 4: Commit** `feat(agent): mote-agent mcp — MCP port to the compiled binary + mcp capability (spec §6.4)`

---

### Task 14: Cross-stack integration suite (scripted real-protocol node)

**Files:**
- Create: `apps/backend/src/test-helpers/scripted-node.ts` — attach a REAL registry connection whose socket decodes the sent JWS (base64url payload split — no verify needed, tests trust themselves), and answers from a `Record<cmdType, (cmd) => unknown | Error>` map via `resolveResult`; exposes captured commands
- Create: `apps/backend/src/api/sessions/__tests__/sessions-remote.integration.test.ts` (+ sibling ws integration cases appended in `apps/backend/src/ws/__tests__/`)
- No production-code changes EXCEPT genuine bugs this suite surfaces (each gets its own fix commit with a failing-first test)

**Interfaces:** consumes everything prior — it is the phase's lock-step proof (spec: phase-1 `unsupported` skeleton let tracks integrate blind; this is where they meet).

- [ ] **Step 1** — happy full lifecycle over REAL routes (`authedRequest` cookie helper): setup enroll-less fixture (direct repo node row + node key, `attachConnection` scripted node) → `POST /api/sessions {nodeId}` asserts the `launch` cmd (cwd/mcp.path under fake dataDir/moteEnv `MOTE_DATA_DIR` = agent dir/cols passthrough) → `promptDelivered:true` via `prompt_deliver` → views show `nodeId`, `nodeOffline:false`; detach ⇒ `nodeOffline:true`; reconcile sweep with the node offline ⇒ zero probe calls; re-attach ⇒ probe batch arrives.
- [ ] **Step 2** — terminate ⇒ `kill` + row dead; restart-in-place ⇒ rotate + `launch` again carrying `bestEffortLog: true` on the wire (assert the captured frame) and `probe_resume` fired first when the harness supports resume; delete ⇒ `remove_paths` on log+mcp paths; upload relay frame sequence (Task 12 fixture reused); attach relay frame contract end-to-end (Task 11 fixtures through the real rpc loop).
- [ ] **Step 3** — full gates + `turbo build` + `bun run test:e2e` ONCE (must stay 22 pass/1 skip — proves the local path is untouched in a real browser too). — [ ] **Step 4: Commit(s)** `test(nodes): cross-stack integration — scripted node drives the full remote lifecycle through real routes`

---

### Task 15: Frontend — remote launch unlocked (pill, honest copy, real `nodeId`)

**Files:**
- Modify: `apps/frontend/src/types/session.ts` (mirror `nodeOffline`)
- Modify: `apps/frontend/src/hooks/use-create-session.ts` (`toSessionCreateBody` stops flattening `nodeId`)
- Modify: `apps/frontend/src/components/session-picker/new-session-form.tsx` (drop the phase-1 notice; selectable-node rule)
- Modify: `apps/frontend/src/components/session-card.tsx` + `apps/frontend/src/routes/sessions_.$id.tsx` (node pill; "node unreachable" copy)
- Modify: `apps/frontend/src/routes/new.tsx` + `apps/frontend/src/components/session-picker/add-session-dialog.tsx` (code-specific 409 copy)
- Modify: `apps/frontend/src/components/session-picker/existing-session-list.tsx` + dialog wiring (`nodeId` filter)
- Modify: `apps/frontend/src/hooks/use-nodes.ts` (rename + rotate-key mutations), `apps/frontend/src/routes/nodes_.$id.tsx` (rename UI, plaintext-once rotate UI, "agent too old" copy), `apps/frontend/src/routes/setup.tsx` ("…or register a Node" copy) — the four §10/§8 items the phase-1 errata narrowed INTO phase 2
- Tests: component-level where a test file already exists (`toSessionCreateBody` unit, session-card pill, dialog error copy); keep snapshots honest.

**Interfaces:**
- Consumes: backend session view `nodeOffline: boolean` (Task 9/10), `nodeId` (already), `NodeView` fields incl. persisted `protocolVersion` (already on the wire via `ready`; if the client `Node` mirror lacks it, add `agentVersion`-sibling `protocolVersion: number | null` and re-check `api/nodes` view mapping in Task 9).
- Produces: nothing consumed by other tasks (terminal code unchanged — the browser `/ws` contract is byte-identical, spec §6.5).

- [ ] **Step 1: `toSessionCreateBody`** — replace `nodeId: nodeId ? "local" : undefined` with `nodeId: nodeId && nodeId !== "local" ? nodeId : undefined` (omitted = server resolves; explicit `local` stays legal). Update its unit test: a remote pick posts the real id; `local` and absent both omit.
- [ ] **Step 2: new-session-form** — delete the "Remote launch arrives in phase 2…" notice block; `isSelectable(n)` becomes `n.kind === "local" || n.status === "online"` UNCHANGED (offline agents are unselectable; the 409 path covers races) — assert the notice is gone in the existing snapshot/test file if one covers that region.
- [ ] **Step 3: node pill + copy** —
  - `session-card.tsx`: `accessoryFor` keeps precedence; a NEW corner detail (subtitle line): when `session.nodeId && session.nodeId !== "local"`, render `<Badge variant="muted">{nodeLabel}</Badge>` where `nodeLabel` comes from a `useNodes()` lookup (names only — one query, already cached): known node → its `name`; unknown id → `"deleted node"`; known+`session.nodeOffline` → Badge variant warning, text `"node unreachable"`. When `nodeOffline` is true, the existing `exited` copy ("no screen — session has exited") must NOT render — `accessoryFor` returns the unreachable badge INSTEAD of `exited` and the waiting chip (node offline supersedes both).
  - `sessions_.$id.tsx`: same rule in the header Badge — `{nodeOffline ? <Badge variant="warning">node unreachable</Badge> : exited ? …}`. Plain literals (no i18n, house style).
- [ ] **Step 4: inline 409 copy** — in `new.tsx` and `add-session-dialog.tsx`, wrap the displayed error: when `err instanceof ApiError && (err.body?.code === BackendErrorCodes.NODE_OFFLINE)` (import from `@internal/backend-errors`; check `lib/api.ts` `ApiError` shape for the parsed body accessor — it keeps `{code, errId}` per its constructor) show `"That node is offline — start its mote-agent or pick another node."` else `errMessage(...)` as today. Same for `NODE_UNREACHABLE` ("The node did not answer — try again shortly.").
- [ ] **Step 5: workspace dialog node filter** — `ExistingSessionList` gains `nodeId?: string` prop (the dialog already holds the create-side form value; the EXISTING half filters `s.nodeId === selected ?? "local"`). Server-side list is unchanged; this is display filtering (house rule: never rely on it for authz — the list is already visibility-filtered).
- [ ] **Step 6: errata-narrowed UI** — nodes detail: inline rename (PATCH), rotate-key button → plaintext-once card reusing the setup-key `CopyCommandRow` pattern (P1-T14 carry: replace the `goDetail` never-cast/href fallback while here), and an `agent too old` chip when `node.status === "offline" && node.protocolVersion != null && node.protocolVersion < NODE_PROTOCOL_VERSION` (import the constant from `@internal/session-protocol` — frontend already bundles it). `setup.tsx`: when local has no usable harnesses, append the "…or register a Node →" link line.
- [ ] **Step 7: tests + trio + `turbo build`** (backend view shape changed in Task 9 — if tasks ran out of order, run turbo build first).
- [ ] **Step 8: Commit** `feat(nodes/ui): remote launch — pill, honest offline copy, real nodeId handoff, errata UI items`

---

### Task 16: Mobile — node picker + `nodeId` hand-off

**Files:**
- Create: `apps/mobile/src/types/node.ts` (mirror of the client `Node` subset: `id,name,kind,status,access,agentVersion,protocolVersion`)
- Modify: `apps/mobile/src/lib/api.ts` (`nodes(): Promise<Node[]>` via `/api/nodes`; `createSession` input gains `nodeId?: string`)
- Modify: `apps/mobile/app/(tabs)/new.tsx` (Node chip row mirroring the profile chips: "Local" + online agent nodes; hidden entirely when `nodes().length <= 1` so single-machine users see no change)
- Modify: `apps/mobile/src/types/session.ts` (mirror `nodeOffline?: boolean`) + wherever crash/exited copy renders — `nodeOffline` ⇒ "node unreachable" instead.
- Test: the api-client body builder (if a test file exists for MoteClient — mirror the nearest existing case); typecheck is most of the gate here.

**Interfaces:**
- Consumes: `GET /api/nodes` (shipped), `POST /api/sessions` `nodeId` (Task 9).
- Produces: nothing.

- [ ] **Step 1: failing api-client test** — `createSession({profileId, workingDir, nodeId:"n1"})` posts a body containing `nodeId: "n1"`; omitted stays omitted.
- [ ] **Step 2: RED → implement steps per Files** — picker state defaults `"local"`; submit passes `nodeId: sel === "local" ? undefined : sel`. Offline agent nodes render disabled with "offline" suffix (mirrors web's selectability rule).
- [ ] **Step 3: GREEN + trio** — [ ] **Step 4: Commit** `feat(mobile): node picker + nodeId create hand-off (phase 2)`

---

### Task 17: Phase-1 backlog polish batch

Six small carried items, each a failing-first test where testable; ONE commit batch (or split per reviewer preference). All references are ledger-cited.

- [ ] **17a — `SETUP_KEY_*` code distinction at enroll** (P1-T6 deliberate simplification, backlog-listed): add `NodeSetupKeysRepository.peekByHash(sha256Hex): Promise<{ usedAt: string | null; expiresAt: string } | undefined>` (single SELECT); `enroll.route.ts` maps BEFORE the pre-validation block: `undefined → SETUP_KEY_INVALID`, `usedAt → SETUP_KEY_CONSUMED`, `expiresAt <= now → SETUP_KEY_EXPIRED` (401, structured body, `doNotLog`), keeping the existing message wording for the invalid case. Tests: three codes pinned + no-churn-on-failure assertion preserved.
- [ ] **17b — dedup `agentGateRule`** (P1-T10 Minor): `api/harness-utils.ts` — the agent-node gate spelled twice (per-id ~:108 and batch ~:151–156): extract `function agentHarnessUsable(plugin, nodeStates: Map<string,boolean> | undefined, inv: AgentInventory): boolean` used by both call sites; behavior tests unchanged must stay green (they pin the two-strictnesses rule).
- [ ] **17c — persist `wsUrl` at enroll; daemon prefers it** (P1-T12 carry): `enroll.ts` stores `nodeWsUrl: resp.wsUrl` — `AgentConfig` gains optional `nodeWsUrl` (loadConfig tolerant: absent ⇒ old config, derived path); `runDaemon` dials `config.nodeWsUrl ?? wsUrlFor(config.serverUrl)` (replaces the derived-URL caveat comment with the resolution note). Tests: config round-trip + daemon dials the persisted URL (fake WS ctor asserts URL).
- [ ] **17d — `daemon.lock` 0600** (P1-T13 Minor 1): `writeLock` passes `{mode: 0o600}` + a stat-based mode test (mirror config.ts's umask re-tightening ONLY if the dir-mode test shows the mode arg alone fails under mask — check, don't assume).
- [ ] **17e — SIGINT test margin** (P1-T13 Minor 3, CI-flake watch): raise the assertion window in the SIGINT-backoff test (750→1500 ms) OR make the test's backoff deterministic via the injected `rand` — prefer determinism; delete the sleep-based assertion if it becomes redundant.
- [ ] **17f — NUL sentinel normalization** (P0 carry): `apps/backend/src/db/repositories/session-shares.repository.ts` — replace the raw NUL byte literal in source with the `"\0"` escape (identical value; source hygiene only). Grep for other raw-NUL occurrences and normalize likewise.
- [ ] **Step Z: GREEN + trio** — [ ] **Commit** `chore(nodes): phase-1 backlog polish — setup-key codes, gate dedup, wsUrl pin, lock mode, test margins (ledger carries)`

---

### Task 18: Real-node parity exit + close-out (controller-executed)

Not an implementer task — the controller runs this with a compiled agent binary (phase-1 Task 16's recipe: scratch backend on `:3188` + temp DB + real tmux), because the phase-2 exit is the parity checklist, and e2e stubs are deliberately Phase 3.

- [ ] **Step 1: Enroll a second identity as a real agent** on THIS box (its own `MOTE_AGENT_HOME` + `--data-dir`, dialing the scratch backend).
- [ ] **Step 2: Walk the master-plan checklist**, capturing evidence per line (command transcript or screenshot): create+prompt · live attach/replay/input/resize · read-only viewer (second user, view share) · terminate · restart in place (token rotated mid-flight — re-use the phase-0 restart guards) · auto-restart w/ backoff (kill the pane; watch `backoffCount` + revival) · exit observation + notification (agent-pushed `exit` beats the sweep — assert the push lands < 20 s) · log tail route (get-session-log on a remote session) · uploads (image → file lands under the session cwd on the node; size verified) · MCP tools from inside the pane (claude profile; `mcp` capability present; `mote_list_channels` round-trip) · session token rotate/extend/revoke incl. revoke-on-terminate (REST as the session key) · name-from-pane-title (probe title path) · node delete refused while sessions run.
- [ ] **Step 3: Kill the agent mid-session** — row stays `running`, view says `nodeOffline`, reconcile skips, relaunch-onto-offline 409s; re-attach ⇒ `sessions_report` re-projection heals rows (a pane that survived shows alive; a dead one stamps its exit).
- [ ] **Step 4: Divergences found ⇒ fix commits with failing-first tests**; spec-level surprises go into the spec's Errata section IN THIS phase (house rule), implementation details into the ledger.
- [ ] **Step 5: Docs close-out:** this plan's Phase-2 heading gets the executed-pointer blockquote (phase-0/1 idiom); master plan `2026-08-31-nodes.md` Phase 2 checkboxes ticked; `apps/backend/AGENTS.md` + `apps/agent`'s docs (exists? create-if-absent skip) micro-deltas: new files map (remote-launcher/node-events/preview-cache), the no-overlap pump invariant pointer, the 512 KiB chunk rule. Root `AGENTS.md` "new app" deltas stay Phase 3 per master plan.
- [ ] **Step 6: Full gates** — trio + `turbo build` + `bun run test:e2e` once. Then **offer the finish menu** (superpowers:finishing-a-development-branch). Remember: `main` is already 57+ commits ahead of `origin/main` unpushed by the user's standing choice — surface that context when asking about merge/push; NO push/merge without explicit word.

---

## Execution notes

- **Branch/worktree:** execution starts on `feat/nodes-phase2` cut from current `main` (per-project convention from phase 0/1: branch, SDD ledger at `.git/sdd/progress.md` section "Nodes Phase 2", merge only on explicit user word). Use superpowers:using-git-worktrees to isolate.
- **Order rationale:** Tasks 1–6 = track 2B first (the frozen wire answers become the backend's fixtures; 2B needs nothing from 2A beyond Task 1). 7–14 = track 2A (7/8 are prerequisites of 9–12; 13 independent after 4; 14 locks the seam). 15/16 = 2C trails both. 17 anywhere after its file owners land; 18 last.
- **Review gates:** every task ends with the trio; Tasks 9, 10, 11, 14 additionally touch the session-manager/ws regression net — reviewers MUST run the FULL suites (phase-0 flake rule) and confirm the local-path tests are unedited (diff inspection).
