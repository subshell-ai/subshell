# Nodes Phase 0 — Contract Freeze Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-08-31-nodes-design.md` — cite "spec 2026-08-31 §N" in new code comments.
**Phase outline:** `docs/superpowers/plans/2026-08-31-nodes.md` (Phase 0 section; this plan replaces its 0.2–0.6 tasks with executable detail).

**Goal:** Land the four frozen contracts of the nodes feature — the node wire format (`node-frames.ts` + `node-signing.ts`), the nodes schema (migration 0017 + repositories), the shared launch primitives (`TmuxRunner`, `buildHarnessCommand`, `validateWorkingDir`, `scanHarnesses` in `@internal/harnesses`), and the `NodeLauncher` seam with a `LocalLauncher` — **with zero user-visible behavior change**: every session still launches on the local host through code paths whose observable behavior is byte-identical, guarded by the existing suites.

**Architecture:** `@internal/session-protocol` gains the signed-command/event vocabulary both the future `mote-agent` and the backend import; `@internal/harnesses` absorbs tmux + launch-assembly so the (future) agent binary ships identical plugin/detection/launch code; `apps/backend/src/services/nodes/` introduces a `NodeLauncher` interface whose `LocalLauncher` implementation is today's `session-manager.service.ts` tmux/fs call sites moved verbatim. Phase 1+ code never touches `SessionManagerService` internals again — it just resolves a launcher per `session.node_id`.

**Tech Stack:** Bun 1.4+, TypeScript, jose 6.2.9, Kysely + bun:sqlite (`CamelCasePlugin`), tsdown, `bun test`, biome.

## Global Constraints

- Verification after **every** task, all green before committing: `bun run verify-types && bun run lint:check && bun run test` (repo root).
- Pinned deps only (exact versions, then `bun install` at root to refresh the lockfile).
- No dynamic imports anywhere (breaks `bun build --compile`).
- New migrations live in `apps/backend/src/db/migrations/` **and** are registered in the static provider map in `apps/backend/src/db/migrate.ts` (file name == map key).
- `@internal/session-protocol` must stay **browser-bundleable**: no `node:fs`/`node:child_process`; `jose` is allowed (pure WebCrypto ESM). No runtime import of `@internal/harnesses` from it (spec §3.2) — the wire profile is the structural mirror `ProfileDefinitionWire`.
- JSDoc on every public function/class and every interface property (`.claude/rules/code-style.md`).
- Elysia untouched this phase; Eden Treaty types change only via the additive `App` (nothing is removed from backend exports except where a task says "move").
- Commits: conventional style, one per task minimum. Branch: `feat/nodes` (already checked out).
- The existing `session-manager.service.test.ts` and `session-manager-mcp.test.ts` suites (real `TmuxRunner` / `MockTmux` injected via the constructor `tmux:` option) are **the regression net**: after the launcher extraction they must pass with only import-path edits, no assertion changes.
- `sessionLogPath`'s format `${SESSION_DATA_DIR}/sessions/<id>.log` is frozen — tests and operators' disks depend on it.

---

### Task 1: Node wire frames (`node-frames.ts`)

**Files:**
- Create: `packages/session-protocol/src/node-frames.ts`
- Create: `packages/session-protocol/src/__tests__/node-frames.test.ts`
- Modify: `packages/session-protocol/src/index.ts` (append re-exports)

**Interfaces:**
- Consumes: nothing (leaf file).
- Produces (frozen — freeze point A): `NODE_PROTOCOL_VERSION: 1`, `NODE_MAX_FRAME_BYTES: 1_048_576`, `ProfileDefinitionWire`, `NodeCommandBody`, `NodeEvent`, `parseNodeCommandBody(value: unknown): NodeCommandBody | null`, `parseNodeEvent(raw: string | object): NodeEvent | null`. Task 2 signs/verifies `NodeCommandBody`; the agent (phase 1B) and backend ws handler (phase 1A) both parse with these.

- [ ] **Step 1: Write the failing tests**

Create `packages/session-protocol/src/__tests__/node-frames.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { NODE_PROTOCOL_VERSION, parseNodeCommandBody, parseNodeEvent } from "../node-frames.js";

const launchCmd = {
  type: "launch",
  sessionId: "s1",
  socket: "mote-abc",
  cwd: "/home/u/repo",
  harnessId: "claude-code",
  profile: { name: "P", env: { A: "b" }, flags: [], settings: null, configIsolation: false },
  moteEnv: { MOTE_API_KEY: "mote_x" },
  sessionName: "s1",
  harnessSession: { id: "h1", mode: "start" as const },
};

describe("parseNodeCommandBody", () => {
  it("accepts a well-formed launch and preserves fields", () => {
    const cmd = parseNodeCommandBody(structuredClone(launchCmd));
    expect(cmd).not.toBeNull();
    expect(cmd?.type).toBe("launch");
  });

  it("rejects launch with a malformed profile (env value not a string)", () => {
    const bad = structuredClone(launchCmd) as Record<string, unknown>;
    (bad.profile as Record<string, unknown>).env = { A: 1 };
    expect(parseNodeCommandBody(bad)).toBeNull();
  });

  it("rejects unknown command types, non-objects, and JSON garbage", () => {
    expect(parseNodeCommandBody({ type: "reboot" })).toBeNull();
    expect(parseNodeCommandBody(null)).toBeNull();
    expect(parseNodeCommandBody("[]")).toBeNull();
    expect(parseNodeCommandBody({})).toBeNull();
  });

  it("accepts input/resize/terminate/ping and checks their required fields", () => {
    expect(parseNodeCommandBody({ type: "ping" })).toEqual({ type: "ping" });
    expect(parseNodeCommandBody({ type: "input", sessionId: "s", data: "" })).not.toBeNull();
    expect(parseNodeCommandBody({ type: "input", sessionId: "s" })).toBeNull();
    expect(parseNodeCommandBody({ type: "resize", sessionId: "s", cols: 80, rows: 24 })).not.toBeNull();
    expect(parseNodeCommandBody({ type: "resize", sessionId: "s", cols: 0, rows: 24 })).toBeNull();
    expect(parseNodeCommandBody({ type: "terminate", sessionId: "s" })).not.toBeNull();
  });

  it("validates write_file chunk bounds and base64 payloads", () => {
    expect(
      parseNodeCommandBody({ type: "write_file", path: "/d/x", chunk_b64: "aGk=", chunk: 0, eof: true }),
    ).not.toBeNull();
    expect(
      parseNodeCommandBody({ type: "write_file", path: "/d/x", chunk_b64: "not base64!!", chunk: 0, eof: false }),
    ).toBeNull();
    expect(
      parseNodeCommandBody({ type: "write_file", path: "/d/x", chunk_b64: "aGk=", chunk: -1, eof: false }),
    ).toBeNull();
  });

  it("pins the protocol version constant", () => {
    expect(NODE_PROTOCOL_VERSION).toBe(1);
  });
});

describe("parseNodeEvent", () => {
  it("accepts ready with capabilities and parses inventory", () => {
    const ev = parseNodeEvent({
      type: "ready",
      agentVersion: "0.1.0",
      protocolVersion: 1,
      os: "darwin",
      arch: "arm64",
      hostname: "mac-mini",
      dataDir: "/Users/u/.local/share/mote-agent",
      capabilities: ["mcp"],
    });
    expect(ev?.type).toBe("ready");
    const inv = parseNodeEvent(
      JSON.stringify({
        type: "inventory",
        ts: "2026-08-31T00:00:00Z",
        harnesses: [{ harnessId: "claude-code", installed: true, version: "2.1", binaryPath: "/usr/bin/claude" }],
      }),
    );
    expect(inv?.type).toBe("inventory");
  });

  it("rejects non-positive byte ranges and bad base64 on output", () => {
    const good = { type: "output", sessionId: "s", subId: "t1", fromByte: 0, toByte: 3, data_b64: "aGk=" };
    expect(parseNodeEvent(good)).not.toBeNull();
    expect(parseNodeEvent({ ...good, fromByte: 5, toByte: 3 })).toBeNull();
    expect(parseNodeEvent({ ...good, data_b64: "%%%" })).toBeNull();
  });

  it("parses result ok/error, exit, heartbeat, sessions_report, error; rejects garbage", () => {
    expect(parseNodeEvent({ type: "result", ref: "j1", ok: true })?.type).toBe("result");
    expect(parseNodeEvent({ type: "result", ref: "j1", ok: false, error: "nope" })?.type).toBe("result");
    expect(parseNodeEvent({ type: "result", ref: "j1", ok: false })).toBeNull();
    expect(parseNodeEvent({ type: "heartbeat", ts: "t" })?.type).toBe("heartbeat");
    expect(parseNodeEvent({ type: "exit", sessionId: "s", exitCode: 1, at: "t" })?.type).toBe("exit");
    expect(parseNodeEvent({ type: "sessions_report", sessions: [] })?.type).toBe("sessions_report");
    expect(parseNodeEvent({ type: "error", code: "x", message: "y" })?.type).toBe("error");
    expect(parseNodeEvent("nope")).toBeNull();
    expect(parseNodeEvent({ type: "chat", text: "hi" })).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/session-protocol && bun test src/__tests__/node-frames.test.ts`
Expected: FAIL — `Cannot find module "../node-frames.js"` (or unresolved import).

- [ ] **Step 3: Implement `node-frames.ts`**

Create `packages/session-protocol/src/node-frames.ts` (full file):

```ts
import type { JsonValue } from "./json.js";

/**
 * Node ↔ control-plane wire contract (spec 2026-08-31 §3).
 *
 * The transport is a websocket dialed OUT by the agent (`GET /ws/node`,
 * bearer-authed at upgrade). Commands travel control-plane → agent inside a
 * signed JWS envelope (see node-signing.ts); events travel agent → control
 * unsigned — the socket itself is authenticated by the node key, so events
 * inherit exactly the node key's trust (spec §3.3, §12.6).
 */

/** Bumped on any breaking frame-shape change; both ends refuse mismatches. */
export const NODE_PROTOCOL_VERSION = 1;

/**
 * Frame ceiling both directions (spec §3.1). Bun's `maxPayloadLength` is
 * GLOBAL to the server, so each handler enforces this by byte length on
 * inbound messages rather than relying on server config (spec §7).
 */
export const NODE_MAX_FRAME_BYTES = 1_048_576;

/** Strict base64 (the alphabet used by `Buffer.toString("base64")` / `btoa`). */
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * Structural JSON mirror of `@internal/harnesses`' `ProfileDefinition`.
 *
 * Deliberately a copy: session-protocol is bundled by the frontend and must
 * not pull harnesses (which imports node:fs) at runtime (spec §3.2). The
 * agent decodes the blob against the real `ProfileDefinition` at launch.
 */
export interface ProfileDefinitionWire {
  /** Human-friendly profile name */
  name: string;
  /** Optional longer description */
  description?: string | null;
  /** Extra environment variables to set on the session (validated key names) */
  env: Record<string, string>;
  /** Extra CLI flags to pass to the harness binary */
  flags: string[];
  /** Settings blob passed to the harness (opaque JSON) */
  settings: Record<string, unknown> | null;
  /** If true, only this profile's config sources apply (isolation) */
  configIsolation: boolean;
  /** If true, new sessions from this profile auto-restart on exit */
  restartOnExit?: boolean;
}

/** Resume pin carried on `launch` (mirrors BuildCommandInput.harnessSession). */
export interface HarnessSessionWire {
  /** Harness-side conversation id */
  id: string;
  /** "start" mints a new id; "resume" continues the given one */
  mode: "start" | "resume";
}

/** Control-plane → agent command payloads — the JWS `cmd` claim (spec §3.2). */
export type NodeCommandBody =
  | {
      /** Start a harness pane: cwd + env + argv inputs, MCP file, output log path */
      type: "launch";
      /** mote session id */
      sessionId: string;
      /** tmux socket name (tmuxSocketFor(sessionId)) */
      socket: string;
      /** Absolute working dir ON THE NODE (already stat-verified via stat_dir) */
      cwd: string;
      /** Harness plugin id */
      harnessId: string;
      /** Launch config (mirror of harnesses ProfileDefinition) */
      profile: ProfileDefinitionWire;
      /** MOTE_* credential env, supplied by the control plane */
      moteEnv: Record<string, string>;
      /** MCP registration file the agent writes (0600) before spawning */
      mcp?: { path: string; fileContent: string };
      /** Resume pin for harnesses that support it */
      harnessSession?: HarnessSessionWire;
      /** tmux session name (the session id) */
      sessionName: string;
      /** Initial terminal geometry */
      cols?: number;
      /** Initial terminal geometry */
      rows?: number;
    }
  | { type: "terminate"; sessionId: string }
  | { type: "kill"; sessionId: string }
  | { type: "input"; sessionId: string; data: string }
  | { type: "resize"; sessionId: string; cols: number; rows: number }
  | {
      /** Agent-side prompt settle loop: capture-poll until the pane is quiet, type + Enter */
      type: "prompt_deliver";
      sessionId: string;
      text: string;
      settleTimeoutMs: number;
      pollMs: number;
    }
  | { type: "capture"; sessionId: string }
  | { type: "probe"; sessionIds: string[] }
  | { type: "probe_resume"; harnessId: string; harnessSessionId: string; cwd: string }
  | { type: "stat_dir"; path: string }
  | { type: "log_read"; sessionId: string; fromByte: number; maxBytes: number }
  | { type: "tail_start"; sessionId: string; subId: string; fromByte: number }
  | { type: "tail_stop"; subId: string }
  | { type: "remove_paths"; paths: string[] }
  | { type: "inventory" }
  | {
      /** Chunked file write (terminal uploads relay, spec §3.4) */
      type: "write_file";
      path: string;
      chunk_b64: string;
      chunk: number;
      eof: boolean;
    }
  | { type: "ping" };

/** Agent → control events, unsigned (socket-authed; spec §3.3). */
export type NodeEvent =
  | {
      type: "ready";
      agentVersion: string;
      protocolVersion: number;
      os: "linux" | "darwin" | "unknown";
      arch: string;
      hostname: string;
      dataDir: string;
      capabilities: string[];
    }
  | {
      type: "inventory";
      harnesses: { harnessId: string; installed: boolean; version?: string; binaryPath?: string }[];
      ts: string;
    }
  | { type: "heartbeat"; ts: string }
  | { type: "result"; ref: string; ok: true; data?: JsonValue }
  | { type: "result"; ref: string; ok: false; error: string }
  | { type: "output"; sessionId: string; subId: string; fromByte: number; toByte: number; data_b64: string }
  | { type: "exit"; sessionId: string; exitCode: number | null; at: string }
  | { type: "sessions_report"; sessions: { sessionId: string; alive: boolean; exitCode: number | null }[] }
  | { type: "error"; code: string; message: string };

/* ------------------------------------------------------------------ */
/* validators (hand-rolled, parseClientFrame style — spec §3)          */
/* ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isStr(value: unknown): value is string {
  return typeof value === "string";
}
function isNum(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
function isInt(value: unknown): value is number {
  return isNum(value) && Number.isInteger(value);
}
function isBool(value: unknown): value is boolean {
  return typeof value === "boolean";
}
function isStrArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isStr);
}
function isStringMap(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every(isStr);
}

function validProfileWire(p: unknown): p is ProfileDefinitionWire {
  if (!isRecord(p) || !isStr(p.name)) return false;
  if (!isStringMap(p.env)) return false;
  if (!isStrArray(p.flags)) return false;
  if (!("settings" in p) || !(p.settings === null || isRecord(p.settings))) return false;
  if (!isBool(p.configIsolation)) return false;
  if ("description" in p && p.description !== null && !isStr(p.description)) return false;
  if ("restartOnExit" in p && p.restartOnExit !== undefined && !isBool(p.restartOnExit)) return false;
  return true;
}

/**
 * Validates and narrows an arbitrary value (JWS `cmd` payload, parsed JSON,
 * or a pre-parsed object) to a known command. Unknown fields are dropped by
 * the returned copy on well-understood commands only where cheap; the
 * contract is that a NON-null return is safe to switch on by `type`.
 * @param value - candidate payload (typically JWT `cmd` claim)
 * @returns the narrowed command, or null when malformed/unknown
 */
export function parseNodeCommandBody(value: unknown): NodeCommandBody | null {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!isRecord(value) || !isStr(value.type)) return null;
  switch (value.type) {
    case "launch": {
      if (!isStr(value.sessionId) || !isStr(value.socket) || !isStr(value.cwd) || !isStr(value.harnessId))
        return null;
      if (!validProfileWire(value.profile) || !isStringMap(value.moteEnv)) return null;
      if (!isStr(value.sessionName)) return null;
      if ("mcp" in value) {
        const m = value.mcp;
        if (!isRecord(m) || !isStr(m.path) || !isStr(m.fileContent)) return null;
      }
      if ("harnessSession" in value) {
        const h = value.harnessSession;
        if (!isRecord(h) || !isStr(h.id) || (h.mode !== "start" && h.mode !== "resume")) return null;
      }
      if ("cols" in value && !isInt(value.cols)) return null;
      if ("rows" in value && !isInt(value.rows)) return null;
      return value as unknown as NodeCommandBody;
    }
    case "terminate":
    case "kill":
    case "capture":
      return isStr(value.sessionId) ? ({ type: value.type, sessionId: value.sessionId } as NodeCommandBody) : null;
    case "input":
      return isStr(value.sessionId) && isStr(value.data) ? (value as unknown as NodeCommandBody) : null;
    case "resize":
      return isStr(value.sessionId) && isInt(value.cols) && isInt(value.rows) && (value.cols as number) > 0 && (value.rows as number) > 0
        ? (value as unknown as NodeCommandBody)
        : null;
    case "prompt_deliver":
      return isStr(value.sessionId) && isStr(value.text) && isNum(value.settleTimeoutMs) && isNum(value.pollMs)
        ? (value as unknown as NodeCommandBody)
        : null;
    case "probe":
      return isStrArray(value.sessionIds) ? { type: "probe", sessionIds: value.sessionIds } : null;
    case "probe_resume":
      return isStr(value.harnessId) && isStr(value.harnessSessionId) && isStr(value.cwd)
        ? { type: "probe_resume", harnessId: value.harnessId, harnessSessionId: value.harnessSessionId, cwd: value.cwd }
        : null;
    case "stat_dir":
      return isStr(value.path) ? { type: "stat_dir", path: value.path } : null;
    case "log_read":
      return isStr(value.sessionId) && isInt(value.fromByte) && isInt(value.maxBytes) && (value.fromByte as number) >= 0 && (value.maxBytes as number) > 0
        ? (value as unknown as NodeCommandBody)
        : null;
    case "tail_start":
      return isStr(value.sessionId) && isStr(value.subId) && isInt(value.fromByte) && (value.fromByte as number) >= 0
        ? { type: "tail_start", sessionId: value.sessionId, subId: value.subId, fromByte: value.fromByte }
        : null;
    case "tail_stop":
      return isStr(value.subId) ? { type: "tail_stop", subId: value.subId } : null;
    case "remove_paths":
      return isStrArray(value.paths) ? { type: "remove_paths", paths: value.paths } : null;
    case "inventory":
      return { type: "inventory" };
    case "write_file":
      return isStr(value.path) && isStr(value.chunk_b64) && BASE64_RE.test(value.chunk_b64) && isInt(value.chunk) && (value.chunk as number) >= 0 && isBool(value.eof)
        ? { type: "write_file", path: value.path, chunk_b64: value.chunk_b64, chunk: value.chunk, eof: value.eof }
        : null;
    case "ping":
      return { type: "ping" };
    default:
      return null;
  }
}

/**
 * Validates and narrows an inbound agent frame (raw JSON text or the
 * already-parsed object — Elysia's ws middleware pre-parses JSON).
 * @param raw - frame as received
 * @returns the narrowed event, or null when malformed/unknown
 */
export function parseNodeEvent(raw: string | object): NodeEvent | null {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!isRecord(value) || !isStr(value.type)) return null;
  switch (value.type) {
    case "ready":
      return isStr(value.agentVersion) && isInt(value.protocolVersion) &&
        (value.os === "linux" || value.os === "darwin" || value.os === "unknown") &&
        isStr(value.arch) && isStr(value.hostname) && isStr(value.dataDir) && isStrArray(value.capabilities)
        ? (value as unknown as NodeEvent)
        : null;
    case "inventory": {
      if (!isStr(value.ts) || !Array.isArray(value.harnesses)) return null;
      for (const h of value.harnesses) {
        if (!isRecord(h) || !isStr(h.harnessId) || !isBool(h.installed)) return null;
        if ("version" in h && !isStr(h.version)) return null;
        if ("binaryPath" in h && !isStr(h.binaryPath)) return null;
      }
      return value as unknown as NodeEvent;
    }
    case "heartbeat":
      return isStr(value.ts) ? { type: "heartbeat", ts: value.ts } : null;
    case "result":
      if (!isStr(value.ref) || !isBool(value.ok)) return null;
      if (value.ok) return { type: "result", ref: value.ref, ok: true, data: value.data as JsonValue };
      return isStr(value.error) ? { type: "result", ref: value.ref, ok: false, error: value.error } : null;
    case "output":
      return isStr(value.sessionId) && isStr(value.subId) && isInt(value.fromByte) && isInt(value.toByte) &&
        (value.fromByte as number) >= 0 && (value.toByte as number) >= (value.fromByte as number) &&
        isStr(value.data_b64) && BASE64_RE.test(value.data_b64)
        ? (value as unknown as NodeEvent)
        : null;
    case "exit":
      return isStr(value.sessionId) && isStr(value.at) &&
        ((value.exitCode === null) || isInt(value.exitCode))
        ? (value as unknown as NodeEvent)
        : null;
    case "sessions_report": {
      if (!Array.isArray(value.sessions)) return null;
      for (const s of value.sessions) {
        if (!isRecord(s) || !isStr(s.sessionId) || !isBool(s.alive)) return null;
        if (!(s.exitCode === null || isInt(s.exitCode))) return null;
      }
      return value as unknown as NodeEvent;
    }
    case "error":
      return isStr(value.code) && isStr(value.message) ? { type: "error", code: value.code, message: value.message } : null;
    default:
      return null;
  }
}
```

The file imports a `JsonValue` type helper. Create `packages/session-protocol/src/json.ts`:

```ts
/** A JSON value, structurally typed (this package stays schema-lib-free). */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
```

- [ ] **Step 4: Re-export from the package index**

Append to `packages/session-protocol/src/index.ts`:

```ts
export type { JsonValue } from "./json.js";
export {
  NODE_MAX_FRAME_BYTES,
  NODE_PROTOCOL_VERSION,
  parseNodeCommandBody,
  parseNodeEvent,
  type HarnessSessionWire,
  type NodeCommandBody,
  type NodeEvent,
  type ProfileDefinitionWire,
} from "./node-frames.js";
```

- [ ] **Step 5: Run the tests + package checks**

Run: `cd packages/session-protocol && bun test && bun run verify-types`
Expected: all tests PASS (including the pre-existing `frames.test.ts`), types clean.

- [ ] **Step 6: Commit**

```bash
git add packages/session-protocol/src
git commit -m "feat(protocol): node wire frames — signed-command and event vocabulary (spec 2026-08-31 §3)"
```

---

### Task 2: Command signing (`node-signing.ts`)

**Files:**
- Create: `packages/session-protocol/src/node-signing.ts`
- Create: `packages/session-protocol/src/__tests__/node-signing.test.ts`
- Modify: `packages/session-protocol/package.json` (add `"jose": "6.2.9"` to a **new `dependencies` block** — the package currently has only devDependencies)
- Modify: `packages/session-protocol/src/index.ts` (append re-exports)
- Root `bun install` to refresh `bun.lock`

**Interfaces:**
- Consumes (Task 1): `NodeCommandBody`, `parseNodeCommandBody`.
- Produces (frozen — freeze point A, cont.): `NODE_CMD_ISSUER`, `NODE_CMD_TTL_SEC`, `ControlKeyPair { publicJwk, privateJwk }`, `generateControlKeys()`, `signCommand(privateJwk, input): Promise<string>`, `verifyCommand(jws, publicJwk, ctx): Promise<VerifyOutcome>`, `SeqTracker`, `JtiLru`, `CommandClaims`. Phase 1A uses `generateControlKeys`/`signCommand` (backend `services/nodes/node-signing.ts` is a thin file store + wrapper); phase 1B calls `verifyCommand` with the pinned key.

- [ ] **Step 1: Add the dependency**

In `packages/session-protocol/package.json`, add (exact pin):

```json
"dependencies": {
  "jose": "6.2.9"
}
```

Run `bun install` at the repo root; expected: lockfile updated, no version drift (`jose` already exists at 6.2.9 for the backend — syncpack-clean).

- [ ] **Step 2: Write the failing tests**

Create `packages/session-protocol/src/__tests__/node-signing.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import {
  JtiLru,
  SeqTracker,
  generateControlKeys,
  signCommand,
  verifyCommand,
} from "../node-signing.js";
import type { NodeCommandBody } from "../node-frames.js";

const cmd: NodeCommandBody = { type: "ping" };

async function fixtures() {
  const keys = await generateControlKeys();
  const jtiLru = new JtiLru();
  const seq = new SeqTracker();
  return { keys, jtiLru, seq };
}

describe("sign/verify round-trip", () => {
  it("verifies a fresh, correctly-addressed command", async () => {
    const { keys, jtiLru, seq } = await fixtures();
    const jws = await signCommand(keys.privateJwk, { nodeId: "n1", jti: "j1", seq: 1, cmd });
    const out = await verifyCommand(jws, keys.publicJwk, { nodeId: "n1", jtiLru, seqTracker: seq });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.claims.cmd).toEqual(cmd);
  });

  it("rejects the wrong audience (command aimed at another node)", async () => {
    const { keys, jtiLru, seq } = await fixtures();
    const jws = await signCommand(keys.privateJwk, { nodeId: "n1", jti: "j1", seq: 1, cmd });
    const out = await verifyCommand(jws, keys.publicJwk, { nodeId: "OTHER", jtiLru, seqTracker: seq });
    expect(out).toEqual({ ok: false, reason: "claims" });
  });

  it("rejects a foreign keypair and a tampered payload", async () => {
    const { keys, jtiLru, seq } = await fixtures();
    const other = await generateControlKeys();
    const jws = await signCommand(keys.privateJwk, { nodeId: "n1", jti: "j1", seq: 1, cmd });
    expect(
      await verifyCommand(jws, other.publicJwk, { nodeId: "n1", jtiLru, seqTracker: seq }),
    ).toEqual({ ok: false, reason: "signature" });
    expect(
      await verifyCommand(jws + "x", keys.publicJwk, { nodeId: "n1", jtiLru, seqTracker: seq }),
    ).toEqual({ ok: false, reason: "signature" });
  });

  it("rejects after the TTL (exp) with a caller-supplied clock", async () => {
    const { keys, jtiLru, seq } = await fixtures();
    const jws = await signCommand(keys.privateJwk, { nodeId: "n1", jti: "j1", seq: 1, cmd, nowSec: 1_000_000 });
    const out = await verifyCommand(jws, keys.publicJwk, {
      nodeId: "n1",
      jtiLru,
      seqTracker: seq,
      nowSec: 1_000_000 + 31,
    });
    expect(out).toEqual({ ok: false, reason: "claims" });
  });

  it("rejects a replayed jti and a seq regression, independent of each other", async () => {
    const { keys, jtiLru, seq } = await fixtures();
    const a = await signCommand(keys.privateJwk, { nodeId: "n1", jti: "jA", seq: 1, cmd });
    const b = await signCommand(keys.privateJwk, { nodeId: "n1", jti: "jB", seq: 2, cmd });
    expect((await verifyCommand(a, keys.publicJwk, { nodeId: "n1", jtiLru, seqTracker: seq })).ok).toBe(true);
    expect(await verifyCommand(a, keys.publicJwk, { nodeId: "n1", jtiLru, seqTracker: seq })).toEqual({
      ok: false,
      reason: "replay",
    });
    // b is ahead of a — fine
    expect((await verifyCommand(b, keys.publicJwk, { nodeId: "n1", jtiLru, seqTracker: seq })).ok).toBe(true);
    // a replay now fails as replay BEFORE seq logic even matters; craft regression with fresh jti:
    const c = await signCommand(keys.privateJwk, { nodeId: "n1", jti: "jC", seq: 1, cmd });
    expect(await verifyCommand(c, keys.publicJwk, { nodeId: "n1", jtiLru, seqTracker: seq })).toEqual({
      ok: false,
      reason: "seq",
    });
  });

  it("rejects a well-signed frame whose cmd is garbage", async () => {
    const { keys, jtiLru, seq } = await fixtures();
    const { SignJWT, importJWK, exportJWK } = await import("jose");
    void SignJWT; void importJWK; void exportJWK; // (dynamic import NOT allowed — see next step: use static imports in the impl test below)
  });
});

describe("SeqTracker", () => {
  it("requires strict increase, resets per connection", () => {
    const s = new SeqTracker();
    expect(s.accept(1)).toBe(true);
    expect(s.accept(1)).toBe(false);
    expect(s.accept(3)).toBe(true); // gap tolerated
    expect(s.accept(2)).toBe(false); // regression rejected
    s.reset();
    expect(s.accept(1)).toBe(true);
  });
});

describe("JtiLru", () => {
  it("reports seen ids and evicts oldest beyond capacity", () => {
    const l = new JtiLru(2);
    expect(l.seen("a")).toBe(false);
    expect(l.seen("a")).toBe(true);
    l.seen("b");
    l.seen("c"); // evicts "a"
    expect(l.seen("a")).toBe(false);
  });
});
```

**Correction for the last round-trip case (no dynamic imports in this repo):** replace the "garbage cmd" test body with a static-import version — sign a hand-built JWT by exporting `signRawClaims(privateJwk, claims)` from node-signing (test-only export with `@internal` JSDoc):

```ts
import { signRawClaims } from "../node-signing.js";
// …
it("rejects a well-signed frame whose cmd is garbage", async () => {
  const { keys, jtiLru, seq } = await fixtures();
  const jws = await signRawClaims(keys.privateJwk, {
    iss: "mote-control",
    aud: "node:n1",
    jti: "j1",
    seq: 1,
    cmd: { type: "wat" },
  });
  expect(await verifyCommand(jws, keys.publicJwk, { nodeId: "n1", jtiLru, seqTracker: seq })).toEqual({
    ok: false,
    reason: "malformed",
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `cd packages/session-protocol && bun test src/__tests__/node-signing.test.ts`
Expected: FAIL — unresolved import `../node-signing.js`.

- [ ] **Step 4: Implement `node-signing.ts`**

Create `packages/session-protocol/src/node-signing.ts`:

```ts
import { SignJWT, compactVerify, exportJWK, generateKey, importJWK, type KeyLike } from "jose";
import { parseNodeCommandBody, type NodeCommandBody } from "./node-frames.js";

/**
 * Command signing for the node link (spec 2026-08-31 §4). The control plane
 * owns one ES256 keypair; every command is a compact JWS bound to ONE node
 * (aud), short-lived (30 s), single-use (jti LRU), with a per-connection
 * ordering hint (seq — the tracker resets on reconnect, it is NOT the replay
 * defense; exp + jti are).
 */

/** `iss` claim every command carries. */
export const NODE_CMD_ISSUER = "mote-control";

/** Default command lifetime in seconds (spec §4: uniform, socket-open-only). */
export const NODE_CMD_TTL_SEC = 30;

/** An ES256 control keypair as exportable JWKs (persistence is the caller's job). */
export interface ControlKeyPair {
  /** Public half — handed to agents at enroll (pin-once) */
  publicJwk: JsonWebKey;
  /** Private half — secrets! Store 0600 outside the DB (spec §4) */
  privateJwk: JsonWebKey;
}

/** Generate a fresh control keypair (ES256 / P-256). */
export async function generateControlKeys(): Promise<ControlKeyPair> {
  const generated = await generateKey("ES256", { extractable: true });
  // jose returns CryptoKey for EC in some runtimes, KeyPair in others.
  const privateKey: KeyLike = "privateKey" in generated ? generated.privateKey : (generated as KeyLike);
  const publicKey: KeyLike = "publicKey" in generated ? generated.publicKey : (privateKey as KeyLike);
  const full = (await exportJWK(privateKey)) as JsonWebKey;
  const { d: _d, ...publicJwk } = full;
  void publicKey;
  return { publicJwk, privateJwk: full };
}

async function importPrivate(jwk: JsonWebKey): Promise<KeyLike> {
  return (await importJWK({ ...jwk, kty: "EC", crv: "P-256" }, "ES256")) as KeyLike;
}
async function importPublic(jwk: JsonWebKey): Promise<KeyLike> {
  return (await importJWK({ ...jwk, kty: "EC", crv: "P-256" }, "ES256")) as KeyLike;
}

/** Per-connection monotonic ordering hint (spec §4). Reset on every connect. */
export class SeqTracker {
  #last = 0;
  /** True when `seq` advances the tracker (gaps tolerated, regressions not). */
  accept(seq: number): boolean {
    if (!Number.isInteger(seq) || seq <= this.#last) return false;
    this.#last = seq;
    return true;
  }
  /** Forget history — call when a NEW socket opens. */
  reset(): void {
    this.#last = 0;
  }
}

/** Bounded LRU of accepted `jti` ids (>= 2× the exp window; spec §4). */
export class JtiLru {
  readonly #capacity: number;
  readonly #seen = new Set<string>();
  constructor(capacity = 2048) {
    this.#capacity = capacity;
  }
  /** True if already recorded; records (and evicts oldest) otherwise. */
  seen(jti: string): boolean {
    if (this.#seen.has(jti)) {
      this.#seen.delete(jti);
      this.#seen.add(jti);
      return true;
    }
    this.#seen.add(jti);
    if (this.#seen.size > this.#capacity) {
      const oldest = this.#seen.values().next().value as string;
      this.#seen.delete(oldest);
    }
    return false;
  }
}

/** Inputs to {@link signCommand}. */
export interface SignCommandInput {
  /** Node id (without the `node:` prefix) the command is aimed at */
  nodeId: string;
  /** Unique id per command (anti-replay + result correlation) */
  jti: string;
  /** Per-connection monotonic counter */
  seq: number;
  /** The payload */
  cmd: NodeCommandBody;
  /** Seconds since epoch (default: wall clock) — injectable for tests */
  nowSec?: number;
  /** Lifetime override (default {@link NODE_CMD_TTL_SEC}) */
  ttlSec?: number;
}

/** Sign a command into a compact JWS envelope. */
export async function signCommand(privateJwk: JsonWebKey, input: SignCommandInput): Promise<string> {
  const key = await importPrivate(privateJwk);
  const now = input.nowSec ?? Math.floor(Date.now() / 1000);
  return new SignJWT({ cmd: input.cmd, seq: input.seq })
    .setProtectedHeader({ alg: "ES256", typ: "JWT" })
    .setIssuer(NODE_CMD_ISSUER)
    .setAudience(`node:${input.nodeId}`)
    .setJti(input.jti)
    .setIssuedAt(now)
    .setExpirationTime(now + (input.ttlSec ?? NODE_CMD_TTL_SEC))
    .sign(key);
}

/**
 * Sign an arbitrary claim set with the control key.
 * @internal test-only — exercises the verify paths signCommand cannot produce.
 */
export async function signRawClaims(
  privateJwk: JsonWebKey,
  claims: Record<string, unknown> & { exp?: number; iat?: number },
): Promise<string> {
  const key = await importPrivate(privateJwk);
  const now = Math.floor(Date.now() / 1000);
  const jwt = new SignJWT(
    Object.fromEntries(Object.entries(claims).filter(([k]) => !["iss", "aud", "jti", "iat", "exp"].includes(k))),
  )
    .setProtectedHeader({ alg: "ES256", typ: "JWT" });
  if (typeof claims.iss === "string") jwt.setIssuer(claims.iss);
  if (typeof claims.aud === "string") jwt.setAudience(claims.aud);
  if (typeof claims.jti === "string") jwt.setJti(claims.jti);
  jwt.setIssuedAt(claims.iat ?? now);
  jwt.setExpirationTime(claims.exp ?? now + NODE_CMD_TTL_SEC);
  return jwt.sign(key);
}

/** Verified claims of one command frame. */
export interface CommandClaims {
  /** Command payload */
  cmd: NodeCommandBody;
  /** Anti-replay id */
  jti: string;
  /** Per-connection ordering hint */
  seq: number;
}

/** Outcome of {@link verifyCommand}; `reason` is stable for logging/metrics. */
export type VerifyOutcome =
  | { ok: true; claims: CommandClaims }
  | { ok: false; reason: "signature" | "claims" | "replay" | "seq" | "malformed" };

/** Context for {@link verifyCommand}: per-connection state lives here. */
export interface VerifyContext {
  /** This node's id (audience check) */
  nodeId: string;
  /** Shared anti-replay cache for this node's connections */
  jtiLru: JtiLru;
  /** Per-connection seq tracker (fresh/reset per socket) */
  seqTracker: SeqTracker;
  /** Seconds since epoch (default wall clock) — injectable for tests */
  nowSec?: number;
}

/**
 * Verify a signed command frame: signature → claims (iss/aud/exp) → jti
 * replay → seq hint → cmd well-formedness. Order matters: only frames that
 * pass EVERYTHING are recorded in the jti LRU (a frame rejected on seq must
 * still not re-verify — it can't, it's stale or hostile either way).
 */
export async function verifyCommand(jws: string, publicJwk: JsonWebKey, ctx: VerifyContext): Promise<VerifyOutcome> {
  let payload: Record<string, unknown>;
  try {
    const key = await importPublic(publicJwk);
    const verified = await compactVerify(jws, key, {
      issuer: NODE_CMD_ISSUER,
      audience: `node:${ctx.nodeId}`,
      clockTimestamp: ctx.nowSec ?? Math.floor(Date.now() / 1000),
    });
    payload = verified.payload as Record<string, unknown>;
  } catch {
    return { ok: false, reason: "signature" };
  }
  if (typeof payload.jti !== "string" || typeof payload.seq !== "number") {
    return { ok: false, reason: "malformed" };
  }
  if (ctx.jtiLru.seen(payload.jti)) return { ok: false, reason: "replay" };
  if (!ctx.seqTracker.accept(payload.seq)) return { ok: false, reason: "seq" };
  const cmd = parseNodeCommandBody(payload.cmd);
  if (!cmd) return { ok: false, reason: "malformed" };
  return { ok: true, claims: { cmd, jti: payload.jti, seq: payload.seq } };
}
```

Implementation notes for the implementer:
- `generateControlKeys` must produce a REAL public-only JWK: if the runtime's `generateKey("ES256", {extractable:true})` returns a single private `CryptoKey`, deriving the public JWK by stripping `d` is correct for P-256 JWKs (x/y/curve stand alone). Verify with the round-trip test — that is what it exists for.
- `compactVerify` rejects expired tokens via the `exp` check automatically; the expired test passes because `clockTimestamp` is supplied. If jose's claim validation throws (it does — `JWTExpiredError`), the catch maps it to `"signature"`. The expired test expects `"claims"`: **before implementing, split the catch** — first `try { const { payload } = await compactVerify(...) }` for signature failure, then a separate claim check using `jwtClaims()` from jose (`import { jwtClaims } from "jose"`) or re-validate `exp`/`iss`/`aud` manually against `payload` inside its own try/catch returning `"claims"`. Simplest correct shape: verify signature with `flattenedVerify(jws, key)` (crypto only), then call jose's `generalVerify`-free manual checks on the decoded payload: `iss === NODE_CMD_ISSUER`, `aud === node:<id>` (string or array), `exp > nowSec`, `iat <= nowSec + 5`. Adjust the tests' expected reasons accordingly (`signature` = bad crypto/format, `claims` = iss/aud/exp). Keep the reason strings stable.

- [ ] **Step 5: Run tests + package checks**

Run: `cd packages/session-protocol && bun test && bun run verify-types && bun run lint:check`
Expected: PASS (fix the test's static-import version of the garbage-cmd case per Step 2's correction; remove the placeholder body).

- [ ] **Step 6: Commit**

```bash
git add packages/session-protocol bun.lock
git commit -m "feat(protocol): ES256 command signing with aud/exp/jti/seq verification (spec 2026-08-31 §4)"
```

---

### Task 3: Migration 0017 + row types + schema registration

**Files:**
- Create: `apps/backend/src/db/migrations/0017-nodes.ts`
- Modify: `apps/backend/src/db/migrate.ts` (static map, `0017` import + entry)
- Create: `apps/backend/src/db/types/nodes.db-types.ts`, `node-shares.db-types.ts`, `node-setup-keys.db-types.ts`, `node-harnesses.db-types.ts`
- Modify: `apps/backend/src/db/types/index.ts` (Database interface), `sessions.db-types.ts` (`nodeId`), `profiles.db-types.ts` (`nodeId`), `recent-paths.db-types.ts` (`nodeId`)
- Create: `apps/backend/src/db/migrations/__tests__/0017-nodes.test.ts`

**Interfaces:**
- Consumes: nothing beyond Kysely conventions (CamelCasePlugin: migrations write **snake_case**, code reads camelCase).
- Produces (frozen — freeze point B): tables `nodes`, `node_shares`, `node_setup_keys`, `node_harnesses`; columns `sessions.node_id` (NOT NULL DEFAULT 'local'), `profiles.node_id` (NULL), `recent_paths.node_id` (DEFAULT 'local'); recreated unique index `idx_recent_paths_user_node_path (user_id, node_id, path)`; `idx_nodes_owner_name` UNIQUE `(owner_user_id, name)`. Task 4's repositories and every later phase type-check against these row types.

- [ ] **Step 1: Write the failing migration test**

Create `apps/backend/src/db/migrations/__tests__/0017-nodes.test.ts` (mirrors the `0016-session-sharing.test.ts` harness):

```ts
import { describe, expect, it } from "bun:test";
import { CamelCasePlugin, Kysely, sql } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import * as initMigration from "@/db/migrations/0001-init.js";
import * as nodesMigration from "@/db/migrations/0017-nodes.js";
import { openSqliteDatabase } from "@/db/open-database.js";

async function migratedDb(): Promise<Kysely<any>> {
  const db = new Kysely<any>({
    dialect: new BunSqliteDialect({ database: async () => openSqliteDatabase(":memory:") }),
    plugins: [new CamelCasePlugin()],
  });
  await initMigration.up(db);
  await nodesMigration.up(db);
  return db;
}

async function columns(db: Kysely<any>, table: string): Promise<string[]> {
  const r = await sql<{ name: string }>`SELECT name FROM pragma_table_info(${table})`.execute(db);
  return r.rows.map((c) => c.name);
}

describe("migration 0017-nodes", () => {
  it("creates nodes / node_shares / node_setup_keys / node_harnesses", async () => {
    const db = await migratedDb();
    expect(await columns(db, "nodes")).toContain("api_key_id");
    expect(await columns(db, "node_shares")).toContain("grantee_user_id");
    expect(await columns(db, "node_setup_keys")).toContain("key_hash");
    expect(await columns(db, "node_harnesses")).toContain("enabled");
  });

  it("defaults sessions.node_id to 'local' and profiles.node_id to NULL", async () => {
    const db = await migratedDb();
    await db
      .insertInto("sessions")
      .values({
        id: "s1",
        userId: "u1",
        profileId: "p1",
        harnessId: "pi",
        name: "S",
        workingDir: "/tmp",
        tmuxSocket: null,
      })
      .execute();
    const sess = await db.selectFrom("sessions").select("nodeId").where("id", "=", "s1").executeTakeFirstOrThrow();
    expect(sess.nodeId).toBe("local");
    await db
      .insertInto("profiles")
      .values({
        id: "p1",
        userId: "u1",
        harnessId: "pi",
        name: "P",
        description: "",
        envJson: "{}",
        flagsJson: "[]",
        settingsJson: null,
        configIsolation: 0,
        restartOnExit: 0,
        isDefault: 0,
      })
      .execute();
    const prof = await db.selectFrom("profiles").select("nodeId").where("id", "=", "p1").executeTakeFirstOrThrow();
    expect(prof.nodeId).toBeNull();
  });

  it("enforces one name per owner on nodes", async () => {
    const db = await migratedDb();
    const mk = (id: string, name: string) => ({
      id,
      ownerUserId: "u1",
      name,
      kind: "agent",
      status: "offline",
      createdAt: "t",
      updatedAt: "t",
    });
    await db.insertInto("nodes").values(mk("n1", "mac")).execute();
    await expect(db.insertInto("nodes").values(mk("n2", "mac"))).rejects.toThrow();
    await expect(db.insertInto("nodes").values({ ...mk("n3", "mac"), ownerUserId: "u2" })).resolves.toBeTruthy();
  });

  it("re-creates the recent_paths unique index across the node dimension", async () => {
    const db = await migratedDb();
    const mk = (id: string, node: string) => ({ id, userId: "u1", path: "/x", label: null, nodeId: node });
    await db.insertInto("recentPaths").values(mk("r1", "local")).execute();
    // same path on another node: allowed
    await expect(db.insertInto("recentPaths").values(mk("r2", "node-2"))).resolves.toBeTruthy();
    // same path, same node: rejected by the unique index
    await expect(db.insertInto("recentPaths").values(mk("r3", "local"))).rejects.toThrow();
  });

  it("cascade-deletes node_shares and node_harnesses with the node", async () => {
    const db = await migratedDb();
    await db
      .insertInto("nodes")
      .values({
        id: "n1",
        ownerUserId: "u1",
        name: "mac",
        kind: "agent",
        status: "offline",
        createdAt: "t",
        updatedAt: "t",
      })
      .execute();
    await db
      .insertInto("nodeShares")
      .values({ id: "sh1", nodeId: "n1", granteeUserId: null, permission: "view", createdBy: "u1", createdAt: "t" })
      .execute();
    await db.insertInto("nodeHarnesses").values({ nodeId: "n1", harnessId: "claude-code", enabled: 1 }).execute();
    await db.deleteFrom("nodes").where("id", "=", "n1").execute();
    expect(await db.selectFrom("nodeShares").selectAll().execute()).toHaveLength(0);
    expect(await db.selectFrom("nodeHarnesses").selectAll().execute()).toHaveLength(0);
  });

  it("down() removes the tables and restores the old recent_paths index", async () => {
    const db = await migratedDb();
    await nodesMigration.down(db);
    const tables = await sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type='table' AND name='nodes'`.execute(db);
    expect(tables.rows).toHaveLength(0);
    // old unique behavior back: same (user, path) twice on same node fails again
    await db
      .insertInto("recentPaths")
      .values({ id: "a", userId: "u1", path: "/y", label: null, nodeId: "local" } as never)
      .execute();
    await expect(
      db
        .insertInto("recentPaths")
        .values({ id: "b", userId: "u1", path: "/y", label: null, nodeId: "local" } as never)
        .execute(),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/backend && bun test src/db/migrations/__tests__/0017-nodes.test.ts`
Expected: FAIL — cannot resolve `0017-nodes.js`.

- [ ] **Step 3: Write the migration**

Create `apps/backend/src/db/migrations/0017-nodes.ts`:

```ts
import type { Kysely } from "kysely";

/**
 * Nodes — remote execution hosts (spec 2026-08-31 §6.1).
 *
 * - `nodes`: one row per machine. Kind "local" is the seeded control-plane
 *   host (id literally 'local', owner the system user, never connects).
 *   `api_key_id` mirrors sessions.api_key_id — the anti-forgery link the
 *   node auth path re-checks on every upgrade.
 * - `node_shares`: exact mirror of session_shares (0016); NULL grantee is
 *   "Everyone"; uniqueness enforced by the repository's transactional replace.
 * - `node_setup_keys`: single-use activation codes (SHA-256 at rest, plaintext
 *   never stored).
 * - `node_harnesses`: per-AGENT-node harness enable state; an absent row means
 *   the plugin's enabledByDefault (same lazy rule as harness_plugins).
 * - sessions.node_id defaults 'local' so every existing row keeps working.
 * - recent_paths' unique index is re-created with the node dimension
 *   (paths are per-machine); the service layer keeps profiles' node pin
 *   consistent (SET NULL on node delete — SQLite ALTER cannot add FKs).
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("nodes")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("owner_user_id", "text", (c) => c.notNull())
    .addColumn("name", "text", (c) => c.notNull())
    .addColumn("kind", "text", (c) => c.notNull()) // 'local' | 'agent'
    .addColumn("os", "text")
    .addColumn("arch", "text")
    .addColumn("hostname", "text")
    .addColumn("status", "text", (c) => c.notNull().defaultTo("offline"))
    .addColumn("last_seen_at", "text")
    .addColumn("agent_version", "text")
    .addColumn("protocol_version", "integer")
    .addColumn("public_key", "text")
    .addColumn("api_key_id", "text")
    .addColumn("capabilities", "text") // JSON array from `ready`
    .addColumn("inventory_json", "text")
    .addColumn("inventory_at", "text")
    .addColumn("created_at", "text", (c) => c.notNull())
    .addColumn("updated_at", "text", (c) => c.notNull())
    .execute();
  await db.schema
    .createIndex("idx_nodes_owner_name")
    .on("nodes")
    .columns(["owner_user_id", "name"])
    .unique()
    .execute();

  await db.schema
    .createTable("node_shares")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("node_id", "text", (c) => c.notNull().references("nodes.id").onDelete("cascade"))
    .addColumn("grantee_user_id", "text")
    .addColumn("permission", "text", (c) => c.notNull())
    .addColumn("created_by", "text", (c) => c.notNull())
    .addColumn("created_at", "text", (c) => c.notNull())
    .execute();
  await db.schema.createIndex("idx_node_shares_node").on("node_shares").column("node_id").execute();

  await db.schema
    .createTable("node_setup_keys")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("owner_user_id", "text", (c) => c.notNull())
    .addColumn("label", "text", (c) => c.notNull())
    .addColumn("key_hash", "text", (c) => c.notNull())
    .addColumn("created_at", "text", (c) => c.notNull())
    .addColumn("expires_at", "text", (c) => c.notNull())
    .addColumn("used_at", "text")
    .addColumn("consumed_node_id", "text")
    .execute();

  await db.schema
    .createTable("node_harnesses")
    .addColumn("node_id", "text", (c) => c.notNull().references("nodes.id").onDelete("cascade"))
    .addColumn("harness_id", "text", (c) => c.notNull())
    .addColumn("enabled", "integer", (c) => c.notNull())
    .addPrimaryKeyConstraint("pk_node_harnesses", ["node_id", "harness_id"])
    .execute();

  await db.schema.alterTable("sessions").addColumn("node_id", "text", (c) => c.notNull().defaultTo("local")).execute();
  await db.schema.alterTable("profiles").addColumn("node_id", "text").execute();
  await db.schema.alterTable("recent_paths").addColumn("node_id", "text", (c) => c.notNull().defaultTo("local")).execute();

  await db.schema.dropIndex("idx_recent_paths_user_path").execute();
  await db.schema
    .createIndex("idx_recent_paths_user_node_path")
    .on("recent_paths")
    .columns(["user_id", "node_id", "path"])
    .unique()
    .execute();
  await db.schema.createIndex("idx_sessions_node_status").on("sessions").columns(["node_id", "status"]).execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropIndex("idx_sessions_node_status").execute();
  await db.schema.dropIndex("idx_recent_paths_user_node_path").execute();
  await db.schema
    .createIndex("idx_recent_paths_user_path")
    .on("recent_paths")
    .columns(["user_id", "path"])
    .unique()
    .execute();
  await db.schema.alterTable("recent_paths").dropColumn("node_id").execute();
  await db.schema.alterTable("profiles").dropColumn("node_id").execute();
  await db.schema.alterTable("sessions").dropColumn("node_id").execute();
  await db.schema.dropTable("node_harnesses").execute();
  await db.schema.dropTable("node_setup_keys").execute();
  await db.schema.dropTable("node_shares").execute();
  await db.schema.dropTable("nodes").execute();
}
```

Register in `apps/backend/src/db/migrate.ts`: add `import * as nodesMigration from "@/db/migrations/0017-nodes.js";` (after 0016's import) and `"0017-nodes": nodesMigration,` in the provider map after `"0016-session-sharing"`.

- [ ] **Step 4: Row types (JSDoc per property, per repo convention)**

Create the four `*.db-types.ts` files in `apps/backend/src/db/types/`:

`nodes.db-types.ts`:

```ts
/** Lifecycle status projection of a node (truth = the live agent socket). */
export type NodeStatus = "online" | "offline";
/** Whether a node is the control-plane host or an enrolled agent machine. */
export type NodeKind = "local" | "agent";

/** The seeded control-plane host row id (spec 2026-08-31 §2). Single home —
 *  repositories AND services import it from this type file (a repository must
 *  never import from services/). */
export const LOCAL_NODE_ID = "local";

/**
 * Database table schema for nodes (spec 2026-08-31 §6.1).
 */
export interface NodeTable {
  /** Node id (uuid); the seeded control-plane host is literally 'local' */
  id: string;
  /** Owning user (system user for 'local') */
  ownerUserId: string;
  /** Display name, unique per owner */
  name: string;
  /** 'local' | 'agent' */
  kind: NodeKind;
  /** Reported OS ('linux' | 'darwin' | …), null until first ready */
  os: string | null;
  /** Reported CPU arch ('x64' | 'arm64' | …) */
  arch: string | null;
  /** Reported hostname */
  hostname: string | null;
  /** Persisted status projection; the live socket is authoritative */
  status: NodeStatus;
  /** ISO 8601 of the last heartbeat/ready */
  lastSeenAt: string | null;
  /** mote-agent version from `ready` */
  agentVersion: string | null;
  /** Node protocol version from `ready` */
  protocolVersion: number | null;
  /** Agent identity public JWK (pinned at enroll) */
  publicKey: string | null;
  /** better-auth apikey id bound to this node (anti-forgery link) */
  apiKeyId: string | null;
  /** JSON array of capability strings from `ready` */
  capabilities: string | null;
  /** Cached harness inventory (JSON), see inventory TTL in spec §6.2 */
  inventoryJson: string | null;
  /** ISO 8601 when inventoryJson was captured */
  inventoryAt: string | null;
  /** ISO 8601 creation time */
  createdAt: string;
  /** ISO 8601 last update time */
  updatedAt: string;
}

/** Insert payload: identity fields required, everything machine-reported optional. */
export type NewNode = Pick<NodeTable, "id" | "ownerUserId" | "name" | "kind"> &
  Partial<Omit<NodeTable, "id" | "ownerUserId" | "name" | "kind" | "updatedAt">> & {
    /** ISO 8601 creation time (default: now, set by the repository) */
    createdAt?: string;
  };
```

`node-shares.db-types.ts`:

```ts
/** Node access level a share grants (spec §2: any share grants launch; edit adds config). */
export type NodeSharePermission = "view" | "edit";

/**
 * Database table schema for per-node access grants — mirror of session_shares.
 */
export interface NodeShareTable {
  /** Unique id (uuid) */
  id: string;
  /** Node this grant is on */
  nodeId: string;
  /** Granteed user; NULL means the "Everyone" grant */
  granteeUserId: string | null;
  /** 'view' | 'edit' */
  permission: NodeSharePermission;
  /** User id who created the grant */
  createdBy: string;
  /** ISO 8601 creation time */
  createdAt: string;
}
```

`node-setup-keys.db-types.ts`:

```ts
/**
 * Database table schema for single-use node enrollment keys (spec §5.1).
 * The plaintext `nsk_…` code exists only in the create response and the
 * install command; only its SHA-256 hex digest is stored.
 */
export interface NodeSetupKeyTable {
  /** Unique id (uuid) */
  id: string;
  /** User who created the key (also the future node owner) */
  ownerUserId: string;
  /** Human label ("mac mini") */
  label: string;
  /** SHA-256 hex of the plaintext key — never the key itself */
  keyHash: string;
  /** ISO 8601 creation time */
  createdAt: string;
  /** ISO 8601 expiry (default 24h out) */
  expiresAt: string;
  /** ISO 8601 when consumed; null while unused */
  usedAt: string | null;
  /** Node created by consuming this key */
  consumedNodeId: string | null;
}
```

`node-harnesses.db-types.ts`:

```ts
/**
 * Database table schema for per-agent-node harness enable/disable.
 * Absent row ⇒ the plugin's enabledByDefault (same lazy rule as harness_plugins).
 */
export interface NodeHarnessTable {
  /** Node this row configures */
  nodeId: string;
  /** Harness plugin id */
  harnessId: string;
  /** 1 enabled / 0 disabled */
  enabled: number;
}
```

- [ ] **Step 5: Register types + add columns to existing row types**

`apps/backend/src/db/types/index.ts` — add imports and Database entries (place near `sessionShares`):

```ts
import type { NodeTable } from "@/db/types/nodes.db-types.js";
import type { NodeShareTable } from "@/db/types/node-shares.db-types.js";
import type { NodeSetupKeyTable } from "@/db/types/node-setup-keys.db-types.js";
import type { NodeHarnessTable } from "@/db/types/node-harnesses.db-types.js";
// in interface Database:
  nodes: NodeTable;
  nodeShares: NodeShareTable;
  nodeSetupKeys: NodeSetupKeyTable;
  nodeHarnesses: NodeHarnessTable;
```

`sessions.db-types.ts` — add to `SessionTable` (JSDoc'd):

```ts
  /** Node the session runs on ('local' = control-plane host) */
  nodeId: string;
```

`profiles.db-types.ts` — add:

```ts
  /** Node this profile is pinned to; null = any launch-eligible node */
  nodeId: string | null;
```

`recent-paths.db-types.ts` — add:

```ts
  /** Machine the path belongs to (recent paths are per-node) */
  nodeId: string;
```

Also update `RecentPathsRepository.touch` in `apps/backend/src/db/repositories/recent-paths.repository.ts` (the insert gains `nodeId: "local"` via a new parameter `nodeId = "local"` on `touch`, and `onConflict` becomes `oc.columns(["userId", "nodeId", "path"])`), plus any other insert site into `recentPaths` the compiler flags.

- [ ] **Step 6: Run the migration test and the full backend suite**

Run: `cd apps/backend && bun test src/db/migrations/__tests__/0017-nodes.test.ts && bun run verify-types`
Expected: PASS + types clean (repo compile fixes included). Then root: `bun run test` — existing suites must stay green (CamelCase maps `node_id`→`nodeId` everywhere; no behavior change yet).

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/db
git commit -m "feat(db): nodes schema — migration 0017, row types, per-node recent paths (spec 2026-08-31 §6.1)"
```

---

### Task 4: Nodes repositories + context wiring

**Files:**
- Create: `apps/backend/src/db/repositories/nodes.repository.ts`, `node-shares.repository.ts`, `node-setup-keys.repository.ts`, `node-harnesses.repository.ts`
- Modify: `apps/backend/src/db/repositories/index.ts` (Repositories type), `apps/backend/src/lib/context.ts` (ApiContext.repos)
- Create: `apps/backend/src/db/repositories/__tests__/nodes.repository.test.ts`, `node-setup-keys.repository.test.ts`, `node-shares.repository.test.ts`

**Interfaces:**
- Consumes (Task 3): row types + tables.
- Produces (frozen-ish; additive OK): `NodesRepository` (`create`, `findById`, `findAccessible(viewerUserId, { includeLocal: true })`, `listByOwner`, `rename`, `applyReady`, `applyInventory`, `setStatus`, `touch`, `setApiKeyId`, `deleteById`, `countPinnedProfiles`), `NodeSharesRepository` (`listForNode`, `listForNodes`, `replaceForNode` — same `ShareEntry` shape as session-shares), `NodeSetupKeysRepository` (`create(label, ownerUserId, ttlMs) → { row, plaintext }`, `consume(keyHash, nodeId) → row | null`, `listByUser`, `deleteById`), `NodeHarnessesRepository` (`setEnabled`, `enabledStates(nodeId): Map<string, boolean>`, `clearForNode`). Phase 1 routes/services call exactly these.

- [ ] **Step 1: Write failing tests**

Create the three test files; all three start with this shared fixture block (temp-file DB comes free from `test-preload.ts`; `unique()` keeps ids from colliding across suites — same rhythm as `session-shares.repository.test.ts`):

```ts
import { beforeAll, describe, expect, it } from "bun:test";
import { db } from "@/db/index.js";
import { runMigrations } from "@/db/migrate.js"; // no-op when already applied
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
// …per-file repo imports

let seq = 0;
const unique = (p: string) => `${p}-${process.pid}-${seq++}`;

async function mkNode(repo: NodesRepository, ownerUserId: string, name = unique("node")) {
  return repo.create({
    id: unique("n"),
    ownerUserId,
    name,
    kind: "agent",
    status: "offline",
    createdAt: new Date().toISOString(),
  });
}
```

**`nodes.repository.test.ts`** — full bodies:

```ts
describe("NodesRepository", () => {
  const repo = new NodesRepository(db);

  it("create + findById round-trip", async () => {
    const n = await mkNode(repo, unique("u"));
    const found = await repo.findById(n.id);
    expect(found?.name).toBe(n.name);
    expect(found?.status).toBe("offline");
  });

  it("findAccessible: owner yes, stranger no, view-sharee yes, local always", async () => {
    const owner = unique("u");
    const stranger = unique("u");
    const grantee = unique("u");
    const n = await mkNode(repo, owner);
    expect((await repo.findAccessible(owner)).some((x) => x.id === n.id)).toBe(true);
    expect((await repo.findAccessible(stranger)).some((x) => x.id === n.id)).toBe(false);
    await db
      .insertInto("nodeShares")
      .values({ id: unique("sh"), nodeId: n.id, granteeUserId: grantee, permission: "view", createdBy: owner, createdAt: new Date().toISOString() })
      .execute();
    expect((await repo.findAccessible(grantee)).some((x) => x.id === n.id)).toBe(true);
    // Everyone grant reaches any viewer
    await db
      .insertInto("nodeShares")
      .values({ id: unique("sh"), nodeId: n.id, granteeUserId: null, permission: "view", createdBy: owner, createdAt: new Date().toISOString() })
      .execute();
    expect((await repo.findAccessible(stranger)).some((x) => x.id === n.id)).toBe(true);
  });

  it("applyReady stamps identity, JSON-encodes capabilities, flips online", async () => {
    const n = await mkNode(repo, unique("u"));
    const updated = await repo.applyReady(n.id, {
      agentVersion: "0.1.0",
      protocolVersion: 1,
      os: "linux",
      arch: "x64",
      hostname: "box",
      capabilities: ["mcp"],
    });
    expect(updated?.status).toBe("online");
    expect(JSON.parse(updated?.capabilities ?? "[]")).toEqual(["mcp"]);
    expect(updated?.lastSeenAt).not.toBeNull();
  });

  it("setStatus/touch/setApiKeyId/applyInventory round-trip", async () => {
    const n = await mkNode(repo, unique("u"));
    await repo.setStatus(n.id, "online");
    expect((await repo.findById(n.id))?.status).toBe("online");
    await repo.setStatus(n.id, "offline");
    expect((await repo.findById(n.id))?.status).toBe("offline");
    await repo.touch(n.id);
    expect((await repo.findById(n.id))?.lastSeenAt).not.toBeNull();
    await repo.setApiKeyId(n.id, "key-1");
    expect((await repo.findById(n.id))?.apiKeyId).toBe("key-1");
    await repo.applyInventory(n.id, "[]");
    expect((await repo.findById(n.id))?.inventoryJson).toBe("[]");
  });

  it("deleteById unpins profiles and removes the node; countPinnedProfiles pre-counts", async () => {
    const n = await mkNode(repo, unique("u"));
    const userId = unique("u");
    await db
      .insertInto("profiles")
      .values({
        id: unique("p"),
        userId,
        harnessId: "pi",
        name: unique("p"),
        description: "",
        envJson: "{}",
        flagsJson: "[]",
        settingsJson: null,
        configIsolation: 0,
        restartOnExit: 0,
        isDefault: 0,
        nodeId: n.id,
      })
      .execute();
    expect(await repo.countPinnedProfiles(n.id)).toBe(1);
    await repo.deleteById(n.id);
    expect(await repo.findById(n.id)).toBeUndefined();
    expect(await repo.countPinnedProfiles(n.id)).toBe(0); // profile survived, unpinned
  });
});
```

**`node-shares.repository.test.ts`** — full bodies:

```ts
describe("NodeSharesRepository", () => {
  const nodes = new NodesRepository(db);
  const shares = new NodeSharesRepository(db);

  it("replace stores Everyone + named grants; shrinking replace leaves nothing stale", async () => {
    const n = await mkNode(nodes, unique("u"));
    const u1 = unique("u");
    await shares.replaceForNode(n.id, [{ granteeUserId: null, permission: "view" }, { granteeUserId: u1, permission: "edit" }], n.ownerUserId);
    expect(await shares.listForNode(n.id)).toHaveLength(2);
    await shares.replaceForNode(n.id, [{ granteeUserId: u1, permission: "view" }], n.ownerUserId);
    const after = await shares.listForNode(n.id);
    expect(after).toHaveLength(1);
    expect(after[0]?.permission).toBe("view");
  });

  it("duplicate grantees (Everyone included) collapse to the last entry", async () => {
    const n = await mkNode(nodes, unique("u"));
    await shares.replaceForNode(
      n.id,
      [
        { granteeUserId: null, permission: "view" },
        { granteeUserId: null, permission: "edit" },
      ],
      n.ownerUserId,
    );
    const rows = await shares.listForNode(n.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.permission).toBe("edit");
  });

  it("listForNodes buckets per node, empty arrays included", async () => {
    const a = await mkNode(nodes, unique("u"));
    const b = await mkNode(nodes, unique("u"));
    await shares.replaceForNode(a.id, [{ granteeUserId: unique("u"), permission: "view" }], a.ownerUserId);
    const map = await shares.listForNodes([a.id, b.id]);
    expect(map.get(a.id)).toHaveLength(1);
    expect(map.get(b.id)).toHaveLength(0);
  });
});
```

**`node-setup-keys.repository.test.ts`** — full bodies:

```ts
describe("NodeSetupKeysRepository", () => {
  const repo = new NodeSetupKeysRepository(db);

  it("plaintext keys never persist; consume is single-use", async () => {
    const { row, plaintext } = await repo.create("lab", unique("u"), 60_000);
    expect(plaintext.startsWith("nsk_")).toBe(true);
    const stored = await repo.findById(row.id);
    expect(stored?.keyHash).not.toContain(plaintext);
    expect(stored?.keyHash).toMatch(/^[0-9a-f]{64}$/);
    const consumed = await repo.consume(plaintext, "n1");
    expect(consumed?.id).toBe(row.id);
    expect(await repo.consume(plaintext, "n2")).toBeNull();
    const after = await repo.findById(row.id);
    expect(after?.usedAt).not.toBeNull();
    expect(after?.consumedNodeId).toBe("n1");
  });

  it("expired and wrong-hash consumption return null", async () => {
    const { plaintext } = await repo.create("old", unique("u"), -1000); // already expired
    expect(await repo.consume(plaintext, "n1")).toBeNull();
    expect(await repo.consume("nsk_nonexistent", "n1")).toBeNull();
  });

  it("listByUser scoped to owner; deleteById only by owner", async () => {
    const owner = unique("u");
    const { row } = await repo.create("lab", owner);
    expect(await repo.listByUser(owner)).toHaveLength(1);
    expect(await repo.listByUser(unique("u"))).toHaveLength(0);
    expect(await repo.deleteById(row.id, "someone-else")).toBe(0);
    expect(await repo.deleteById(row.id, owner)).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run to verify failures** (unresolved imports).

- [ ] **Step 3: Implement the four repositories**

`nodes.repository.ts` (representative — follow `sessions.repository.ts` idioms; every method JSDoc'd):

```ts
import { BaseRepository } from "@/db/repositories/base.repository.js";
import { LOCAL_NODE_ID, type NewNode, type NodeStatus, type NodeTable } from "@/db/types/nodes.db-types.js";

/** Registry writes/reads; authorization is decided by lib/node-access (phase 1). */
export class NodesRepository extends BaseRepository {
  async create(input: NewNode): Promise<NodeTable> {
    const now = new Date().toISOString();
    return await this.db
      .insertInto("nodes")
      .values({ ...input, createdAt: input.createdAt ?? now, updatedAt: now })
      .returningAll()
      .executeTakeFirstOrThrow();
  }
  async findById(id: string): Promise<NodeTable | undefined> {
    return await this.db.selectFrom("nodes").selectAll().where("id", "=", id).executeTakeFirst();
  }
  /** Nodes visible to a viewer: their own, plus any they hold a share on, plus 'local'. */
  async findAccessible(viewerUserId: string): Promise<NodeTable[]> {
    return await this.db
      .selectFrom("nodes")
      .selectAll()
      .where((eb) =>
        eb.or([
          eb("ownerUserId", "=", viewerUserId),
          eb("id", "=", LOCAL_NODE_ID),
          eb.exists(
            eb
              .selectFrom("nodeShares")
              .select("id")
              .where("nodeShares.nodeId", "=", eb.ref("nodes.id"))
              .where((e2) => e2.or([e2("nodeShares.granteeUserId", "=", viewerUserId), e2("nodeShares.granteeUserId", "is", null)])),
          ),
        ]),
      )
      .orderBy("createdAt", "asc")
      .execute();
  }
  async listByOwner(ownerUserId: string): Promise<NodeTable[]> {
    return await this.db.selectFrom("nodes").selectAll().where("ownerUserId", "=", ownerUserId).execute();
  }
  async rename(id: string, name: string): Promise<NodeTable | undefined> {
    return await this.db
      .updateTable("nodes")
      .set({ name, updatedAt: new Date().toISOString() })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst();
  }
  /** Apply a `ready` frame (spec §5.3): identity + online + last-seen in one write. */
  async applyReady(
    id: string,
    r: {
      agentVersion: string;
      protocolVersion: number;
      os: string;
      arch: string;
      hostname: string;
      capabilities: string[];
    },
  ): Promise<NodeTable | undefined> {
    return await this.db
      .updateTable("nodes")
      .set({
        ...r,
        capabilities: JSON.stringify(r.capabilities),
        status: "online",
        lastSeenAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst();
  }
  async applyInventory(id: string, inventoryJson: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.updateTable("nodes").set({ inventoryJson, inventoryAt: now, updatedAt: now }).where("id", "=", id).execute();
  }
  async setStatus(id: string, status: NodeStatus): Promise<void> {
    await this.db.updateTable("nodes").set({ status, updatedAt: new Date().toISOString() }).where("id", "=", id).execute();
  }
  async touch(id: string): Promise<void> {
    await this.db.updateTable("nodes").set({ lastSeenAt: new Date().toISOString() }).where("id", "=", id).execute();
  }
  async setApiKeyId(id: string, apiKeyId: string): Promise<void> {
    await this.db.updateTable("nodes").set({ apiKeyId, updatedAt: new Date().toISOString() }).where("id", "=", id).execute();
  }
  /** Profiles pinned to this node — the delete confirm dialog warns with this count (spec §5.4). */
  async countPinnedProfiles(id: string): Promise<number> {
    const r = await this.db
      .selectFrom("profiles")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("nodeId", "=", id)
      .executeTakeFirst();
    return Number(r?.n ?? 0);
  }
  /** Unpin + delete in one transaction; NULLs `profiles.node_id` (spec §5.4). */
  async deleteById(id: string): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      await tx.updateTable("profiles").set({ nodeId: null }).where("nodeId", "=", id).execute();
      await tx.deleteFrom("nodes").where("id", "=", id).execute();
    });
  }
}
```

`node-shares.repository.ts`: copy `session-shares.repository.ts`'s three methods with `session→node` renames and `nodeShares` table; reuse the `ShareEntry` type name locally (`NodeShareEntry = { granteeUserId: string | null; permission: NodeSharePermission }`) — do NOT import session types across resources (they are separate contracts, spec §2).

`node-setup-keys.repository.ts`:

```ts
import { createHash, randomBytes } from "node:crypto";
import { BaseRepository } from "@/db/repositories/base.repository.js";
import type { NodeSetupKeyTable } from "@/db/types/node-setup-keys.db-types.js";

/** 24 h default lifetime (spec §5.1). */
export const SETUP_KEY_TTL_MS = 24 * 60 * 60 * 1000;

function hashKey(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

/** Single-use enrollment keys; the plaintext exists only in create()'s result. */
export class NodeSetupKeysRepository extends BaseRepository {
  async create(
    label: string,
    ownerUserId: string,
    ttlMs: number = SETUP_KEY_TTL_MS,
  ): Promise<{ row: NodeSetupKeyTable; plaintext: string }> {
    const plaintext = `nsk_${randomBytes(24).toString("base64url")}`;
    const now = new Date();
    const row = await this.db
      .insertInto("nodeSetupKeys")
      .values({
        id: crypto.randomUUID(),
        ownerUserId,
        label,
        keyHash: hashKey(plaintext),
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
        usedAt: null,
        consumedNodeId: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return { row, plaintext };
  }
  async findById(id: string): Promise<NodeSetupKeyTable | undefined> {
    return await this.db.selectFrom("nodeSetupKeys").selectAll().where("id", "=", id).executeTakeFirst();
  }
  async listByUser(ownerUserId: string): Promise<NodeSetupKeyTable[]> {
    return await this.db
      .selectFrom("nodeSetupKeys")
      .selectAll()
      .where("ownerUserId", "=", ownerUserId)
      .orderBy("createdAt", "desc")
      .execute();
  }
  async deleteById(id: string, ownerUserId: string): Promise<number> {
    const r = await this.db.deleteFrom("nodeSetupKeys").where("id", "=", id).where("ownerUserId", "=", ownerUserId).execute();
    return Number(r.length ?? 0);
  }
  /**
   * Transactionally consume a presented plaintext for a new node. Returns the
   * key row on success (unused, unexpired), null otherwise. The flip
   * (`used_at`) and the guard share one transaction — two racers cannot both
   * redeem (spec §5.2).
   */
  async consume(plaintext: string, nodeId: string): Promise<NodeSetupKeyTable | null> {
    const keyHash = hashKey(plaintext);
    const nowIso = new Date().toISOString();
    return this.db.transaction().execute(async (tx) => {
      const row = await tx
        .selectFrom("nodeSetupKeys")
        .selectAll()
        .where("keyHash", "=", keyHash)
        .where("usedAt", "is", null)
        .where("expiresAt", ">", nowIso)
        .executeTakeFirst();
      if (!row) return null;
      await tx
        .updateTable("nodeSetupKeys")
        .set({ usedAt: nowIso, consumedNodeId: nodeId })
        .where("id", "=", row.id)
        .where("usedAt", "is", null)
        .execute();
      return row;
    });
  }
}
```

Note on the `consume` race: the update re-checks `usedAt is null` and returns rows-affected — for strict single-winner semantics, check `numUpdatedRows` (read both `numUpdatedRows`/`numUpdated` like `sessions.repository.ts` does for the dialect quirk) and return `null` when zero. Implement it that way.

`node-harnesses.repository.ts`:

```ts
import { BaseRepository } from "@/db/repositories/base.repository.js";
import type { NodeHarnessTable } from "@/db/types/node-harnesses.db-types.js";

/** Per-agent-node harness enablement (lazy rows: absent ⇒ plugin default). */
export class NodeHarnessesRepository extends BaseRepository {
  async setEnabled(nodeId: string, harnessId: string, enabled: boolean): Promise<NodeHarnessTable> {
    return await this.db
      .insertInto("nodeHarnesses")
      .values({ nodeId, harnessId, enabled: enabled ? 1 : 0 })
      .onConflict((oc) => oc.columns(["nodeId", "harnessId"]).doUpdateSet({ enabled: enabled ? 1 : 0 }))
      .returningAll()
      .executeTakeFirstOrThrow();
  }
  /** Explicitly-configured states only; callers merge plugin defaults. */
  async enabledStates(nodeId: string): Promise<Map<string, boolean>> {
    const rows = await this.db.selectFrom("nodeHarnesses").selectAll().where("nodeId", "=", nodeId).execute();
    return new Map(rows.map((r) => [r.harnessId, r.enabled === 1]));
  }
  async clearForNode(nodeId: string): Promise<void> {
    await this.db.deleteFrom("nodeHarnesses").where("nodeId", "=", nodeId).execute();
  }
}
```

- [ ] **Step 4: Wire into `Repositories` + `ApiContext`**

`db/repositories/index.ts`: add the four imports, and to `Repositories`:

```ts
  readonly nodes: NodesRepository;
  readonly nodeShares: NodeSharesRepository;
  readonly nodeSetupKeys: NodeSetupKeysRepository;
  readonly nodeHarnesses: NodeHarnessesRepository;
```

`lib/context.ts`: construct them in `this.repos` alongside the others.

- [ ] **Step 5: Run tests + verification trio**

Run: `cd apps/backend && bun test src/db && bun run verify-types`, then root `bun run lint:check && bun run test`.
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/db apps/backend/src/lib/context.ts
git commit -m "feat(db): nodes repositories — registry, shares, single-use setup keys, per-node harness state"
```

---

### Task 5: Move `TmuxRunner` into `@internal/harnesses`

**Files:**
- Move: `apps/backend/src/services/tmux/tmux-runner.ts` → `packages/harnesses/src/tmux-runner.ts` (git mv)
- Move: `apps/backend/src/services/tmux/__tests__/tmux-runner.test.ts` → `packages/harnesses/src/__tests__/tmux-runner.test.ts`
- Modify: `packages/harnesses/src/index.ts` (export block)
- Modify importers: `apps/backend/src/services/session-manager.service.ts`, `apps/backend/src/ws/session-ws.ts`, `apps/backend/src/services/channels/nudge.ts`, `apps/backend/src/ws/__tests__/session-ws.test.ts`, `apps/backend/src/services/__tests__/session-manager.service.test.ts`, `apps/backend/src/services/__tests__/session-manager-mcp.test.ts`, `apps/backend/src/api/channels/__tests__/channels-route.test.ts`

**Interfaces:**
- Consumes: `shellQuote` becomes a same-package relative import (`./shell.js`) inside tmux-runner.
- Produces (frozen — freeze point C, part 1): `@internal/harnesses` now exports `TmuxRunner`, `tmuxSocketFor` (identical signatures; `TmuxRunner` keeps constructor `(tmuxBinary = "tmux")` and all public methods). The phase-1B agent imports these directly.

- [ ] **Step 1: Move both files** (`git mv`), then in `packages/harnesses/src/tmux-runner.ts` change `import { shellQuote } from "@internal/harnesses";` → `import { shellQuote } from "./shell.js";`.

- [ ] **Step 2: Export from the package index** — append to `packages/harnesses/src/index.ts`:

```ts
export { TmuxRunner, tmuxSocketFor } from "./tmux-runner.js";
```

- [ ] **Step 3: Rewrite backend imports** — in every file listed above replace the tmux-runner import line with the package import (they mostly already import from `@internal/harnesses`, so fold the names in):

```ts
// before
import { TmuxRunner, tmuxSocketFor } from "@/services/tmux/tmux-runner.js";
// after
import { TmuxRunner, tmuxSocketFor } from "@internal/harnesses";
```

Delete the now-empty `apps/backend/src/services/tmux/` directory.

- [ ] **Step 4: Fix the moved test's import path** in `packages/harnesses/src/__tests__/tmux-runner.test.ts` (`../tmux-runner.js`). The test spawns real tmux — confirm `which tmux` on this host (dev box and CI containers both have it; if absent the suite's existing skips/expectations apply unchanged).

- [ ] **Step 5: Verification trio** (root).
Expected: green; the harness test file runs under `packages/harnesses`' `bun test`.

- [ ] **Step 6: Commit**

```bash
git add apps/backend packages/harnesses
git commit -m "refactor(harnesses): TmuxRunner + tmuxSocketFor move into @internal/harnesses for agent reuse (spec 2026-08-31 §6.4)"
```

---

### Task 6: Shared launch assembly (`buildHarnessCommand`, `validateWorkingDir` → harnesses)

**Files:**
- Create: `packages/harnesses/src/launch.ts`
- Modify: `packages/harnesses/src/index.ts` (exports)
- Modify: `apps/backend/src/services/session-manager.service.ts` (delete local `buildHarnessCommand`/`curatedEnv`/`validateWorkingDir`/`ENV_KEY_RE`/`isDirectory`, import from package, keep re-export-free call sites compiling)
- Modify any other importer the compiler flags (`grep -rn "validateWorkingDir\|buildHarnessCommand" apps/backend/src` — known: session-manager, its two test files)
- Create: `packages/harnesses/src/__tests__/launch.test.ts`

**Interfaces:**
- Consumes: `shellQuote` (same package), `HarnessPlugin`, `ProfileDefinition`, `McpRegistration` types.
- Produces (frozen — freeze point C, part 2): `buildHarnessCommand(harness, binary, cwd, profile, sessionName, moteEnv?, mcp?, harnessSession?): string` — **byte-identical output to today's implementation** (spec §6.4); `curatedEnv(): Record<string,string>`; `validateWorkingDir(raw: string): Promise<string>` (same error messages: `"workingDir is required"`, `` `Path does not exist: ${resolved}` ``, `` `Not a directory: ${resolved}` ``); `ENV_KEY_RE`.

- [ ] **Step 1: Write the failing byte-identity tests** — `packages/harnesses/src/__tests__/launch.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { getHarness } from "../index.js";
import { ENV_KEY_RE, buildHarnessCommand, validateWorkingDir } from "../launch.js";

describe("buildHarnessCommand", () => {
  const pi = getHarness("pi");
  it("assembles env -i with quoted values and the TERM literal", () => {
    if (!pi) throw new Error("pi plugin missing");
    const cmd = buildHarnessCommand(
      pi,
      "/usr/bin/pi",
      "/home/u/proj",
      { name: "P", env: { FOO: "ba r'z" }, flags: [], settings: null, configIsolation: false },
      "sess1",
      { MOTE_API_KEY: "mote_x" },
    );
    expect(cmd.startsWith("env -i ")).toBe(true);
    expect(cmd).toContain(`FOO=${"'ba r'\\''z'"}`); // POSIX quoting of an inner quote
    expect(cmd).toContain(`MOTE_API_KEY='mote_x'`);
    expect(cmd).toContain(`TERM="$TERM"`); // appended when the profile doesn't set TERM
  });
  it("lets an explicit profile TERM win over the literal", () => {
    if (!pi) throw new Error("pi plugin missing");
    const cmd = buildHarnessCommand(
      pi,
      "/usr/bin/pi",
      "/tmp",
      { name: "P", env: { TERM: "xterm-256color" }, flags: [], settings: null, configIsolation: false },
      "s",
    );
    expect(cmd).toContain(`TERM='xterm-256color'`);
    expect(cmd).not.toContain(`TERM="$TERM"`);
  });
  it("rejects env keys that are not shell-safe names", () => {
    if (!pi) throw new Error("pi plugin missing");
    expect(() =>
      buildHarnessCommand(
        pi,
        "/bin/pi",
        "/tmp",
        { name: "P", env: { "X; touch /tmp/pwned": "1" }, flags: [], settings: null, configIsolation: false },
        "s",
      ),
    ).toThrow(/Invalid harness env var name/);
  });
  it("keeps ENV_KEY_RE canonical", () => {
    expect(ENV_KEY_RE.test("MOTE_API_KEY")).toBe(true);
    expect(ENV_KEY_RE.test("1BAD")).toBe(false);
  });
});

describe("validateWorkingDir", () => {
  it("resolves an existing dir to its realpath", async () => {
    expect(await validateWorkingDir("/tmp")).toBeTypeOf("string");
  });
  it("rejects missing paths and non-strings", async () => {
    await expect(validateWorkingDir("/nope/nope/nope")).rejects.toThrow(/Path does not exist/);
    await expect(validateWorkingDir("" as never)).rejects.toThrow(/workingDir is required/);
  });
});
```

- [ ] **Step 2: Run to verify failure** (module missing).

- [ ] **Step 3: Move the implementations**

Create `packages/harnesses/src/launch.ts` containing — **moved verbatim** — from `apps/backend/src/services/session-manager.service.ts`: `ENV_KEY_RE`, `buildHarnessCommand` (JSDoc comment block travels with it; add one sentence: "Local launcher (backend) and remote agents (mote-agent) assemble pane commands through this exact function — byte-identity is the spec (§6.4)."), `curatedEnv`, `validateWorkingDir`, `isDirectory`; static imports at the top of the new file:

```ts
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { shellQuote } from "./shell.js";
import type { HarnessPlugin, McpRegistration, ProfileDefinition } from "./types.js";
```

(Replace `Bun.file(p).stat()` in `isDirectory` with the same call — `@types/bun` is a devDep here, and the package already spawns processes, so Bun runtime APIs are in-contract for it.)

In `session-manager.service.ts`: delete the moved definitions, add `buildHarnessCommand`, `validateWorkingDir` to its existing `@internal/harnesses` import, remove now-unused `ENV_KEY_RE`/`curatedEnv`/`isDirectory`. Keep the `McpRegistration`-related call shape unchanged (the wrapper disappeared — call sites pass the same args).

Export additions in `packages/harnesses/src/index.ts`:

```ts
export { ENV_KEY_RE, buildHarnessCommand, curatedEnv, validateWorkingDir } from "./launch.js";
```

- [ ] **Step 4: Update test imports** — `session-manager.service.test.ts` / `session-manager-mcp.test.ts` import `buildHarnessCommand`/`validateWorkingDir` (if any) from `"@internal/harnesses"` now.

- [ ] **Step 5: Verification trio** (root).
Expected: green — this task must change no behavior; a red session-manager test means output drifted. Debug with the failing expected-vs-actual string diff.

- [ ] **Step 6: Commit**

```bash
git add packages/harnesses apps/backend
git commit -m "refactor(harnesses): pane-command assembly + working-dir validation move to @internal/harnesses (spec 2026-08-31 §6.4)"
```

---

### Task 7: `scanHarnesses()` inventory helper

**Files:**
- Create: `packages/harnesses/src/inventory.ts`
- Modify: `packages/harnesses/src/index.ts`
- Create: `packages/harnesses/src/__tests__/inventory.test.ts`

**Interfaces:**
- Consumes: `ALL_HARNESSES`, each plugin's `isInstalled/findBinary/getVersion`.
- Produces (freeze point C, part 3): `HarnessInventoryEntry { harnessId; installed; version?; binaryPath? }`, `scanHarnesses(): Promise<HarnessInventoryEntry[]>`. Phase 1B's agent sends these as the `inventory` event's `harnesses`; phase 1A's backend caches them in `nodes.inventoryJson`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "bun:test";
import { ALL_HARNESSES } from "../index.js";
import { scanHarnesses } from "../inventory.js";

describe("scanHarnesses", () => {
  it("returns one entry per built-in harness with consistent optionals", async () => {
    const entries = await scanHarnesses();
    expect(entries.map((e) => e.harnessId).sort()).toEqual(ALL_HARNESSES.map((h) => h.id).sort());
    for (const e of entries) {
      expect(typeof e.installed).toBe("boolean");
      if (!e.installed) {
        expect(e.version).toBeUndefined();
        expect(e.binaryPath).toBeUndefined();
      } else if (e.version !== undefined) {
        expect(typeof e.version).toBe("string");
      }
    }
  });
});
```

- [ ] **Step 2: Verify failure**, then **Step 3: implement**:

```ts
import { ALL_HARNESSES } from "./index.js";

/** One row of a node's harness inventory (spec 2026-08-31 §3.3). */
export interface HarnessInventoryEntry {
  /** Harness plugin id */
  harnessId: string;
  /** CLI binary found and executable from this machine's perspective */
  installed: boolean;
  /** `<binary> --version` output when installed and readable */
  version?: string;
  /** Resolved binary path when installed */
  binaryPath?: string;
}

/**
 * Probe every built-in harness ON THIS MACHINE. Detection is process-local
 * by construction (spec §1, harnesses/binary-lookup.ts) — which is precisely
 * why the agent imports this package: control plane and node run identical
 * plugin code against their own filesystems.
 */
export async function scanHarnesses(): Promise<HarnessInventoryEntry[]> {
  return Promise.all(
    ALL_HARNESSES.map(async (h) => {
      const installed = await h.isInstalled();
      if (!installed) return { harnessId: h.id, installed: false };
      const [binaryPath, version] = await Promise.all([h.findBinary(), h.getVersion()]);
      return {
        harnessId: h.id,
        installed: true,
        ...(binaryPath ? { binaryPath } : {}),
        ...(version ? { version } : {}),
      };
    }),
  );
}
```

`index.ts`: `export { scanHarnesses, type HarnessInventoryEntry } from "./inventory.js";`
(If `inventory.ts` importing `./index.js` for `ALL_HARNESSES` trips a cycle at runtime, import `ALL_HARNESSES` from a small `./registry.js` extracted from `index.ts` — the static array plus `getHarness` — and have `index.ts` re-export it.)

- [ ] **Step 4: Package + root verification trio. Step 5: Commit**

```bash
git commit -m "feat(harnesses): scanHarnesses inventory helper shared by backend and mote-agent"
```

---

### Task 8: `NodeLauncher` interface + `LocalLauncher` (the seam)

**Files:**
- Create: `apps/backend/src/services/nodes/node-launcher.ts` (interface + `LaunchPlan`)
- Create: `apps/backend/src/services/nodes/session-paths.ts` (`sessionLogPath` moved here, next to the launcher that consumes it)
- Create: `apps/backend/src/services/nodes/local-launcher.ts`
- Modify: `apps/backend/src/services/session-manager.service.ts` (call sites route through `this.#launcher`; `sessionLogPath`/`readSessionLogTail` import from the new path file; constructor gains `launcher?`)
- Modify: `apps/backend/src/ws/session-ws.ts`, `apps/backend/src/api/sessions/__tests__/sessions-log-route.test.ts` (only the `sessionLogPath` import path)
- Create: `apps/backend/src/services/nodes/__tests__/local-launcher.test.ts`

**Interfaces:**
- Consumes: everything frozen so far (TmuxRunner, buildHarnessCommand, validateWorkingDir via `@internal/harnesses`; `sessionLogPath` from `session-paths.ts`; `SessionTable`).
- Produces (frozen — freeze point D): `LaunchPlan` (below), `NodeLauncher` (exact spec §6.3 surface), `LocalLauncher` (`constructor(deps?: { tmux?: TmuxRunner })`). `LOCAL_NODE_ID`'s single home is `db/types/nodes.db-types.ts` (Task 3) — import, never redefine. `SessionManagerService` constructor: the existing `tmux?: TmuxRunner` option is KEPT (wraps `new LocalLauncher({ tmux })`) so every existing test injects MockTmux unchanged — plus a new `launcher?: NodeLauncher` option for phase 2.

```ts
// node-launcher.ts
import type { HarnessPlugin, McpRegistration, ProfileDefinition } from "@internal/harnesses";

/** One harness start, structured (spec 2026-08-31 §6.3). */
export interface LaunchPlan {
  /** mote session id (also the tmux session name) */
  id: string;
  /** tmux socket (tmuxSocketFor(id)) */
  socket: string;
  /** Resolved plugin */
  harness: HarnessPlugin;
  /** Absolute binary path on the TARGET machine (resolveBinary output) */
  binary: string;
  /** Working dir on the TARGET machine (validateWorkingDir output) */
  cwd: string;
  /** Decoded profile */
  profile: ProfileDefinition;
  /** Display/session name handed to the plugin */
  sessionName: string;
  /** MOTE_* credential env */
  moteEnv: Record<string, string>;
  /** MCP registration (dialect computed control-side) */
  mcp?: McpRegistration;
  /** Resume pin */
  harnessSession?: { id: string; mode: "start" | "resume" };
}

/**
 * Every machine-local operation a session needs, so the orchestrator never
 * touches tmux/fs/agent sockets directly (spec §6.3). LocalLauncher is
 * today's code; RemoteLauncher (phase 2) signs NodeCommandBodies.
 */
export interface NodeLauncher {
  validateWorkingDir(raw: string): Promise<string>;
  resolveBinary(harness: HarnessPlugin): Promise<string | null>;
  launch(plan: LaunchPlan): Promise<void>;
  terminate(socket: string, id: string): Promise<void>;
  killSession(socket: string, id: string): Promise<void>;
  hasSession(socket: string, id: string): Promise<boolean>;
  paneExitCode(socket: string, id: string): Promise<number | null>;
  paneTitle(socket: string, id: string): Promise<{ title: string; command: string } | null>;
  capture(socket: string, id: string): Promise<string>;
  resize(socket: string, id: string, cols: number, rows: number): Promise<void>;
  sendInput(socket: string, id: string, input: string): Promise<void>;
  pressEnter(socket: string, id: string): Promise<void>;
  logPath(id: string): string;
  readLogTail(id: string): Promise<{ lines: string[]; truncated: boolean }>;
  readLog(id: string, fromByte: number, maxBytes: number): Promise<{ bytes: Uint8Array; next: number }>;
  tailStart(
    id: string,
    subId: string,
    fromByte: number,
    onChunk: (bytes: Uint8Array, next: number) => void,
  ): Promise<() => void>;
  canResume(harness: HarnessPlugin, storedId: string, cwd: string): Promise<boolean>;
  writeArtifact(id: string, kind: "mcp-config", content: string): Promise<string>;
  removeArtifacts(paths: string[]): Promise<void>;
}
```

- [ ] **Step 1: Write the failing LocalLauncher test** — real tmux, real pipes (same footing as today's `session-manager.service.test.ts`, which already launches panes this way). Full file:

```ts
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TmuxRunner, tmuxSocketFor } from "@internal/harnesses";
import { LocalLauncher } from "../local-launcher.js";
import { sessionLogPath } from "../session-paths.js";

const tmux = new TmuxRunner();
const launcher = new LocalLauncher({ tmux });
const id = `launcher-test-${process.pid}`;
const socket = tmuxSocketFor(id);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterAll(() => {
  tmux.killSession(socket, id);
  tmux.cleanSocket(socket);
  void Bun.file(sessionLogPath(id)).unlink().catch(() => {});
});

describe("LocalLauncher pane lifecycle (direct tmux seeding)", () => {
  beforeAll(() => {
    tmux.newSession(socket, id, tmpdir(), "sleep 30");
  });

  it("hasSession / capture / sendInput + pressEnter round-trip", async () => {
    expect(await launcher.hasSession(socket, id)).toBe(true);
    await launcher.sendInput(socket, id, "marker-not-typed\r"); // no Enter yet
    expect(await launcher.capture(socket, id)).toContain("marker-not-typed");
    await launcher.resize(socket, id, 120, 40);
    expect(await launcher.paneTitle(socket, id)).not.toBeNull();
    expect(await launcher.paneExitCode(socket, id)).toBeNull(); // still alive
  });

  it("log plumbing: readLogTail / readLog / tailStart disposer (pane seeded directly)", async () => {
    // `launch()`'s command assembly is covered byte-identically by the
    // pi-stub cases in session-manager.service.test.ts (routed through the
    // launcher by Step 3), so this file covers the LOG side: seed a pane
    // directly and pipe it to the launcher's own logPath, then read through
    // the launcher API.
    const lid = `${id}-log`;
    const lsock = tmuxSocketFor(lid);
    tmux.newSession(lsock, lid, tmpdir(), "echo hi; sleep 5");
    tmux.pipePane(lsock, lid, sessionLogPath(lid));
    await sleep(400); // pipe-pane flush
    const tail = await launcher.readLogTail(lid);
    expect(tail.lines.join("\n")).toContain("hi");
    const read = await launcher.readLog(lid, 0, 1024);
    expect(read.bytes.byteLength).toBeGreaterThan(0);
    expect(read.next).toBe(read.bytes.byteLength);
    const chunks: Uint8Array[] = [];
    const stop = await launcher.tailStart(lid, "sub1", read.next, (b) => chunks.push(b));
    tmux.sendInput(lsock, lid, "streamed\r");
    await sleep(600);
    stop();
    const before = chunks.reduce((n, c) => n + c.byteLength, 0);
    expect(before).toBeGreaterThan(0);
    stop(); // disposer is idempotent
    tmux.sendInput(lsock, lid, "after-stop\r");
    await sleep(600);
    expect(chunks.reduce((n, c) => n + c.byteLength, 0)).toBe(before);
    tmux.killSession(lsock, lid);
    tmux.cleanSocket(lsock);
    await launcher.removeArtifacts([sessionLogPath(lid)]);
    expect((await launcher.readLogTail(lid)).lines).toEqual([]); // missing log = empty
  });

  it("terminate kills the session", async () => {
    await launcher.terminate(socket, id);
    expect(await launcher.hasSession(socket, id)).toBe(false);
  });
});

describe("LocalLauncher artifacts + validation", () => {
  const tmp = mkdtempSync(join(tmpdir(), "launcher-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it("validateWorkingDir rejects missing paths", async () => {
    await expect(launcher.validateWorkingDir(join(tmp, "nope"))).rejects.toThrow(/Path does not exist/);
  });

  it("writeArtifact('mcp-config') writes 0600 under the session data dir and removeArtifacts deletes it", async () => {
    const path = await launcher.writeArtifact(`${id}-art`, "mcp-config", '{"mcpServers":{}}');
    const meta = await Bun.file(path).stat();
    expect(meta.size).toBeGreaterThan(0);
    // mode check is POSIX-only; skip on non-POSIX hosts (none here):
    // biome-ignore lint/suspicious/noExplicitAny: stat.mode is Bun's extra field
    expect(((meta as any).mode & 0o077) === 0).toBe(true);
    await launcher.removeArtifacts([path]);
    expect(await Bun.file(path).exists()).toBe(false);
  });
});
```

Notes for the implementer:
- `writeArtifact`'s directory: mirror where `registerSessionMcp`/`mcp-launch.ts` writes today (`grep -rn "mcp" apps/backend/src/services/mcp-launch.ts`); the test asserts the returned path exists and is private, not the exact directory.
- If the tail/chunk timing flakes under CI load, widen the two `sleep(600)` windows before touching the pump logic — the pump itself has a 1 s backstop by design (ported from `startLogTail`).

- [ ] **Step 2: Verify failure**, then implement.

`session-paths.ts` — move `sessionLogPath` (and its JSDoc block) out of `session-manager.service.ts` here verbatim; update its importers: `session-manager.service.ts`, `ws/session-ws.ts`, `api/sessions/__tests__/sessions-log-route.test.ts` (+ anything `grep -rn "sessionLogPath" apps/backend/src` flags). Delete the old definition (single home).

`local-launcher.ts` — implement every `NodeLauncher` member from the moved code:

```ts
import { mkdirSync, unlinkSync, watch } from "node:fs";
import { dirname } from "node:path";
import {
  TmuxRunner,
  buildHarnessCommand,
  validateWorkingDir,
  type HarnessPlugin,
} from "@internal/harnesses";
import { LOG_TAIL_BYTES, LOG_TAIL_LINES, readLogTailFrom } from "./log-tail.js";
import type { LaunchPlan, NodeLauncher } from "./node-launcher.js";
import { sessionLogPath } from "./session-paths.js";

/** Today's exact tmux/fs behavior behind the launcher seam (spec §6.3). */
export class LocalLauncher implements NodeLauncher {
  readonly #tmux: TmuxRunner;
  constructor(deps: { tmux?: TmuxRunner } = {}) {
    this.#tmux = deps.tmux ?? new TmuxRunner();
  }
  // validateWorkingDir → delegate to the package function.
  // resolveBinary(h) → h.findBinary().
  // launch(plan) → buildHarnessCommand(...) + newSession + mkdir(logDir) + pipePane — the
  //   EXACT sequence currently at session-manager.service.ts createSession (~lines
  //   232-247) and #reviveRow (~696-741); copy both into one method, behavior verbatim.
  // terminate/killSession/hasSession/paneExitCode/paneTitle/capture/resize/
  //   sendInput/pressEnter → thin async wrappers returning the TmuxRunner call directly.
  // logPath → sessionLogPath(id).
  // readLogTail → readLogTailFrom(this.logPath(id))  (moved with LOG_TAIL_* consts out of
  //   session-manager.service.ts into ./log-tail.js, verbatim; session-manager's exported
  //   readSessionLogTail becomes a one-line delegation to the module-level
  //   defaultLocalLauncher.readLogTail so routes/tests keep their import).
  // readLog → Bun.file(logPath).slice(from, from+max).bytes() + next offset (empty array
  //   when the file is missing), matching readSessionLogTail's missing-file-as-empty rule.
  // tailStart → fs.watch(logPath) + size-pump loop seeded by a readLog catch-up from
  //   fromByte; port of ws/session-ws.ts startLogTail's local pump (fs.watch + 1 s
  //   backstop interval); returns a disposer closing the watcher and clearing the timer.
  // canResume → harness.resume ? harness.resume.canResume(storedId, cwd) : false.
  // writeArtifact → path = `${dirname(sessionLogPath(id))}/../mcp/${id}.json` … follow the
  //   CURRENT path used by registerSessionMcp/mcp-launch (grep services/mcp-launch.ts) —
  //   phase 0 does NOT move MCP file writing; writeArtifact mirrors it for phase 2 and
  //   must be implemented by reading where registerSessionMcp writes today, writing with
  //   mode 0o600, returning the path.
  // removeArtifacts → for (p of paths) unlinkSync(p) best-effort try/catch (current delete
  //   behavior at session-manager deleteSession ~line 558 uses unlinkSync(sessionLogPath)).
}

/** Module-level default (mirrors the constructor default; used by readSessionLogTail). */
export const defaultLocalLauncher = new LocalLauncher();
```

- [ ] **Step 3: Route `session-manager.service.ts` through the launcher.**

Constructor changes (keep `tmux?:` working for tests):

```ts
readonly #launcher: NodeLauncher;
constructor({ sessions, profiles, tmux, audit = defaultAudit, tokens = defaultTokens, notify = defaultNotify, launcher }: {
  sessions: SessionsRepository;
  profiles: ProfilesRepository;
  /** @deprecated test-compat shim — wrapped in a LocalLauncher */
  tmux?: TmuxRunner;
  audit?: (event: AuditEventInput) => Promise<void>;
  tokens?: SessionTokenProvider;
  notify?: (sessionId: string, kind: NotifyKind) => Promise<void>;
  /** Machine interface for this manager's sessions; phase 0: always LocalLauncher */
  launcher?: NodeLauncher;
}) {
  this.#launcher = launcher ?? new LocalLauncher({ tmux: tmux ?? new TmuxRunner() });
  // …rest of the assignments unchanged (drop the #tmux field)
}
```

Mechanical rewrites (each `await` added inside already-async methods; verify with verify-types where an enclosing function must turn async — expected: `#preview` and its two callers):

| Current call (in `session-manager.service.ts`) | Becomes |
|---|---|
| `validateWorkingDir(workingDir)` / `validateWorkingDir(row.workingDir)` | `await this.#launcher.validateWorkingDir(…)` |
| `harness.findBinary()` (×2) | `await this.#launcher.resolveBinary(harness)` |
| `buildHarnessCommand(...)` + `newSession` + mkdir + `pipePane` block (createSession and #reviveRow) | `await this.#launcher.launch({ id, socket, harness, binary, cwd: realPath, profile, sessionName: id (current arg order — keep), moteEnv, mcp, harnessSession })` |
| `this.#tmux.capturePane(socket, id)` (prompt settle, ~293; pane-title paths) | `await this.#launcher.capture(socket, id)` |
| `this.#tmux.sendInput(...)` / `pressEnter(...)` (prompt delivery) | `await this.#launcher.sendInput(...)` / `pressEnter(...)` |
| `screenTail(this.#tmux.capturePane(row.tmuxSocket, row.id))` (~352) | `screenTail(await this.#launcher.capture(row.tmuxSocket, row.id))` — make `#preview` (or the containing function) async and `await` at its call sites |
| `this.#tmux.killSession(...)` (×4 sites incl. restart park, terminate, revive rollback) | `await this.#launcher.killSession(...)` |
| `unlinkSync(sessionLogPath(id))` (~558) | `await this.#launcher.removeArtifacts([this.#launcher.logPath(id)])` — keep the surrounding `#revokeTokenOrUnlink` semantics identical |
| `this.#tmux.hasSession(...)` (isAlive ~582, reconcile ~785) | `await this.#launcher.hasSession(...)` |
| `this.#tmux.paneExitCode(...)` (~787) | `await this.#launcher.paneExitCode(...)` |
| `this.#tmux.paneTitle(...)` (~826) | `await this.#launcher.paneTitle(...)` |
| `Bun.file(sessionLogPath(row.id)).stat()` (~833) | keep (lastOutputAt mtime probe; not machine-scoped in phase 0 — add a code comment `// TODO(spec §6.3): phase-2 routes through launcher`) |
| `harness.resume.canResume(storedId, cwd)` (~128, `#planHarnessSession`) | `await this.#launcher.canResume(harness, storedId, cwd)` — make the containing method async if needed |
| `readSessionLogTail` (module export) | body becomes `return defaultLocalLauncher.readLogTail(sessionId);` — same signature, same behavior |

Keep exported names (`validateWorkingDir`? — no: it moved to `@internal/harnesses` in Task 6; anything still imported from session-manager by other modules — `sessionLogPath`, `readSessionLogTail`, `TmuxRunner` type usage) resolving; update importer imports where a move broke them (compiler will list all).

- [ ] **Step 4: Run the session-manager suites — the acceptance gate**

Run: `cd apps/backend && bun test src/services/__tests__/session-manager.service.test.ts src/services/__tests__/session-manager-mcp.test.ts src/services/nodes/__tests__/local-launcher.test.ts`
Expected: ALL PASS with no assertion edits (import-line edits allowed). A failure here means the extraction changed behavior — fix the launcher, not the test.

- [ ] **Step 5: Verification trio at root** (full suite incl. ws + route tests — `session-ws.test.ts` and MockTmux-based suites must pass untouched).

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/services apps/backend/src/ws apps/backend/src/api
git commit -m "refactor(backend): NodeLauncher seam — LocalLauncher extracted, session manager routed through it (spec 2026-08-31 §6.3)"
```

---

### Task 9: `session-ws.ts` reads through the launcher + phase close-out

**Files:**
- Modify: `apps/backend/src/ws/session-ws.ts` (TmuxRunner → `LocalLauncher`)
- Modify: `apps/backend/src/ws/__tests__/session-ws.test.ts` (constructor/import updates only)

**Interfaces:**
- Consumes (Task 8): `LocalLauncher` (`hasSession`, `capture`, `resize`, `sendInput` — all async).
- Produces: every tmux touchpoint of the live-terminal path resolves through `NodeLauncher`, so phase 2's remote branch is a launcher swap + tail relay, not a handler rewrite. (The fs log tail in this file stays direct-fs in phase 0 — phase 2 switches the local branch to `launcher.tailStart` when it adds the remote relay, per spec §6.5; leave a pointer comment there.)

- [ ] **Step 1: Swap the socket's machine handle.** In `handleSessionWs`: replace `const tmux = new TmuxRunner()` with `const launcher = new LocalLauncher()`; `!tmux.hasSession(...)` → `!(await launcher.hasSession(...))`; the replay `tmux.capturePane(...)` → `await launcher.capture(...)`. In the shared attach `data` bag, replace the `tmux: TmuxRunner` field with `launcher: NodeLauncher` and update the three message-path uses: the pane-poll `out = data.tmux.capturePane(...)` → `await data.launcher.capture(...)` (its enclosing poll callback is async — if it isn't already, make the callback `async` and keep the timer fire-and-forget with `void`), `data.tmux.resizeWindow(...)` → `void data.launcher.resize(...)` and `data.tmux.sendInput(...)` → `void data.launcher.sendInput(...)` (spec §6.3: local stays sync-fast inside the async wrapper; the browser socket does not wait on tmux).
- [ ] **Step 2: Pointer comment** at the fs tail call site: `// spec §6.5: phase 2 routes local + remote tails through NodeLauncher.tailStart`.
- [ ] **Step 3: Update `session-ws.test.ts`** imports/mocks to the `launcher` field. No assertion changes.
- [ ] **Step 4: Verification trio (root).** Expected: green.
- [ ] **Step 5: Manual smoke (the phase's real acceptance):** `bun run dev` elsewhere per your usual flow, create a session from the web UI with a prompt, attach a terminal, type input, resize the browser, restart it from the UI, terminate it. All behaviors must be indistinguishable from `main`.
- [ ] **Step 6: Commit + record the freeze**

```bash
git add apps/backend/src/ws
git commit -m "refactor(ws): terminal handler routes through NodeLauncher; freeze point D (spec 2026-08-31 §6.3)"
```

Then append to `docs/superpowers/plans/2026-08-31-nodes.md`, under the Phase 0 heading: `> Executed: see 2026-08-31-nodes-phase0-contracts.md (frozen: A wire, B schema, C harness primitives, D launcher seam).` and commit the doc touch.

---

## Self-review notes (plan author)

- **Spec coverage (phase 0 scope only):** frames+signing §3/§4 (Tasks 1–2), schema §6.1 + referential rules §5.4 (Tasks 3–4), shared primitives §6.4 (Tasks 5–7), launcher seam §6.3 (Tasks 8–9). REST surface §9, ws handler §5.3, frontend §10, agent §7 → later phase plans; freeze point E (REST shapes) is already satisfied — spec §9's table is the frozen sketch.
- **Known drift risk:** `writeArtifact` in `LocalLauncher` must mirror wherever `registerSessionMcp`/`mcp-launch.ts` writes today — the implementer reads that file (the plan deliberately does not restate it; grep `MOTE_MCP_COMMAND`/`registerSessionMcp` first). It has no phase-0 caller beyond its own test.
- **Type consistency:** `LOCAL_NODE_ID` single home = `nodes.repository.ts`; `NodeLauncher.launch` consumes `LaunchPlan` exactly as Task 8 defines; `readLogTail` return shape matches `readSessionLogTail`'s current `{ lines, truncated }`.
