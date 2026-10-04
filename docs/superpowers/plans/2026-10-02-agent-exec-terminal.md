# exec_in_terminal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An agent runs one shell command in a plain terminal pane and gets back that command's output and exit code, by way of a server-composed sentinel line and the byte-cursor log reader.

**Architecture:** A pure protocol module (`pane-exec.ts`) owns sentinel composition, accumulation-safe recognition, the quiet probe, and the wait loop over the existing `LogWindowReader` seam. `SubshellsService.execInTerminal` gates (edit-level, terminal-type pane, in-flight lease), types two inputs through the existing `sendInput` seam, and waits. One Elysia route (`POST /api/subshells/:id/exec`) and one MCP tool (`exec_in_terminal`, a thin POST). Zero node-protocol surface.

**Tech Stack:** Bun, TypeScript, Elysia (t schemas), Zod (MCP schemas), bun:test, jose-free (no crypto here), react-query-free (no SPA work).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-10-02-agent-exec-terminal-design.md` (this branch). Its rulings bind: timeout REPORTS and never touches the pane; quiet-check refuses while producing, no force flag; nothing merges until the operator verifies.
- REST bodies and responses are **camelCase** (`timeoutMs`, `exitCode`, `nextByte`); snake_case lives only in query params and MCP tool schemas (`subshell_id`, `timeout_ms`).
- No U+2014 anywhere in authored prose (docs, comments, UI copy); `bun run lint:prose` enforces. UI copy stays at most two sentences (no UI here, but tool descriptions follow house voice).
- Every Elysia `t` schema property carries a `description` (rules/code-style). Tool schemas are named constants (rules/code-style). No dynamic `await import` (rules/build).
- Work happens on branch `feat/agent-exec-terminal` (stacked on `feat/mcp-terminal-sessions`; the cursor machinery from it is load-bearing). Never merge; PR against the S1 branch is opened at the end and left to the operator.
- Focused checks while iterating (`bun test <files>`, `bunx turbo verify-types --filter=<pkg>`, `bunx biome check <paths>`); the full boundary (`bun run verify-types && bun run lint:check && bun run lint:prose && bun run test`, plus `bunx turbo build`) only at the final task's gate.
- Commits carry the trailer `Co-Authored-By: Claude Opus 4.8 (1M context)`.
- Constants (exact values from the spec): `EXEC_QUIET_MS = 1000`, `EXEC_TIMEOUT_MS = 30_000`, timeout clamp `[1000, 300000]`, `EXEC_POLL_MS = 500`, `EXEC_MAX_OUTPUT_BYTES = 256 * 1024`, token = 16 lowercase hex chars. Sentinel command: `printf '__xcomm_<T>_DONE rc=%s\n' "$?"`. Recognition regex: `^__xcomm_<T>_DONE rc=([0-9]+)$`.

Key existing seams (verified on this branch; import names are literal):

- `cursorLinesFromWindow(bytes, fromByte, size)` -> `{ lines, truncated, nextByte }` and type `LogWindowReader = (fromByte, maxBytes) => Promise<{ bytes: Uint8Array; next: number; size: number }>` from `apps/server/api/src/services/nodes/log-tail.js`; `LOG_WINDOW_DEFAULT_BYTES`, `LOG_MAX_WINDOW_BYTES` beside them.
- `launcherFor(nodeId)` from `@/services/nodes/launcher-registry.js`; the launcher's `sendInput(socket, id, text)` and `readLogWindow(id, fromByte, maxBytes)` members.
- `#gate`, `throwApiError`, `rethrowLaunchRefusal`, `tmuxSocketFor`, `getHarness` are already imported and used in `apps/server/api/src/services/subshells.service.ts`; error codes are the `BackendErrorCodes` enum in `packages/backend-errors/src/error-codes.ts`.
- MCP: `guard()` wrapper + `server.registerTool` pattern in `packages/mcp-core/src/server.ts`; `ToolApi`/`ToolDeps` in `packages/mcp-core/src/tools.ts`; `describeToolError` there too.
- Route tests ride the real app + `attachScriptedNode` (see `apps/server/api/src/api/subshells/__tests__/subshell-input-route.test.ts` for the whole idiom, including the `LIFECYCLE` command-handler map).

---

### Task 1: The pure protocol module (`pane-exec.ts`)

**Files:**
- Create: `apps/server/api/src/services/nodes/pane-exec.ts`
- Test: `apps/server/api/src/services/nodes/__tests__/pane-exec.test.ts`

**Interfaces:**
- Consumes: `cursorLinesFromWindow`, `LOG_WINDOW_DEFAULT_BYTES`, type `LogWindowReader` from `../log-tail.js` (relative from `services/nodes/` it is `./log-tail.js`).
- Produces (Task 2 imports exactly these):
  - `const EXEC_QUIET_MS: 1000`, `EXEC_TIMEOUT_MS: 30_000`, `EXEC_POLL_MS: 500`, `EXEC_MAX_OUTPUT_BYTES: 256 * 1024`, `EXEC_TIMEOUT_MIN = 1000`, `EXEC_TIMEOUT_MAX = 300_000`
  - `function execSentinelToken(): string`
  - `function execSentinelCommand(token: string): string`
  - `function windowIsPartial(bytes: Uint8Array): boolean`
  - `function createSentinelScanner(token: string): { push(lines: string[], partialLast: boolean): { rc: number; hitInWindow: number } | null; output(): string[] }`
  - `function execTimeoutMs(requested: number | undefined): number`
  - `async function probeQuiet(read: LogWindowReader, sleep: (ms: number) => Promise<void>): Promise<{ quiet: boolean; size: number }>`
  - `async function waitSentinel(read: LogWindowReader, token: string, startByte: number, opts: { timeoutMs: number; sleep: (ms: number) => Promise<void>; now: () => number; alive?: () => Promise<boolean> }): Promise<{ status: "completed" | "timed_out"; rc: number | null; outputLines: string[]; nextByte: number }>`
  - `function execOutputTail(lines: string[], capBytes: number): { text: string; truncated: boolean }`

- [ ] **Step 1: Write the failing tests**

Create `apps/server/api/src/services/nodes/__tests__/pane-exec.test.ts`. The reader fake is a closure over a chunk queue that mimics the launcher triple (each pull delivers the next queued window or empty bytes plus the running size), and the split-sentinel case mirrors S1's scripted log-route tests' liveness shape (`subshells-log-route.test.ts` "window with no newline" cases).

```ts
import { describe, expect, it } from "bun:test";
import {
  EXEC_MAX_OUTPUT_BYTES,
  createSentinelScanner,
  execOutputTail,
  execSentinelCommand,
  execSentinelToken,
  execTimeoutMs,
  probeQuiet,
  waitSentinel,
  windowIsPartial,
} from "../pane-exec.js";
import type { LogWindowReader } from "../log-tail.js";

const enc = new TextEncoder();

/** A reader over a fixed log: pulls advance a cursor like the real windows do. */
function readerOver(bytes: Uint8Array, windowSize = 64): LogWindowReader {
  return async (fromByte, maxBytes) => {
    const end = Math.min(bytes.byteLength, fromByte + Math.min(maxBytes, windowSize));
    return { bytes: bytes.subarray(fromByte, end), next: end, size: bytes.byteLength };
  };
}

const sleepNoop = async () => {};
const clock = (() => {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
})();

describe("sentinel composition", () => {
  it("token is 16 lowercase hex chars; command is the exact printf line", () => {
    expect(execSentinelToken()).toMatch(/^[0-9a-f]{16}$/);
    expect(execSentinelCommand("aabbccddeeff0011")).toBe(`printf '__xcomm_aabbccddeeff0011_DONE rc=%s\\n' "$?"`);
  });
});

describe("scanner recognition", () => {
  it("matches the whole-stream sentinel, records output before it, and reports the window index", () => {
    const s = createSentinelScanner("t0");
    expect(s.push(["working dir ok", "build started"], false)).toBeNull();
    const hit = s.push(["__xcomm_t0_DONE rc=0"], false);
    expect(hit).toEqual({ rc: 0, hitInWindow: 0 });
    expect(s.output()).toEqual(["working dir ok", "build started"]);
  });

  it("the typed echo never matches (it carries quotes and a literal $?)", () => {
    const s = createSentinelScanner("t1");
    const echo = `$ printf '__xcomm_t1_DONE rc=%s\\n' "$?"`;
    expect(s.push([echo], false)).toBeNull();
  });

  it("a fish-shaped empty rc never matches and the stream keeps accumulating", () => {
    const s = createSentinelScanner("t2");
    expect(s.push(["__xcomm_t2_DONE rc="], false)).toBeNull();
    expect(s.output()).toEqual(["__xcomm_t2_DONE rc="]); // ordinary text, not a hit, not lost
  });

  it("a partial tail line is carried, matched when completed by the next window", () => {
    const s = createSentinelScanner("t3");
    expect(s.push(["noise"], false)).toBeNull();
    expect(s.push(["__xcomm_t3_DO"], true)).toBeNull(); // split read 1: NO match, held
    const hit = s.push(["NE rc=3"], false); // split read 2: merged line matches
    expect(hit).toEqual({ rc: 3, hitInWindow: 0 });
    expect(s.output()).toEqual(["noise"]);
  });

  it("windowIsPartial is the no-newline rule of S1's liveness branch", () => {
    expect(windowIsPartial(enc.encode("abc"))).toBe(true);
    expect(windowIsPartial(enc.encode("ab\nc"))).toBe(false);
    expect(windowIsPartial(new Uint8Array(0))).toBe(false);
  });
});

describe("execTimeoutMs clamping", () => {
  it("defaults, floors, and caps exactly", () => {
    expect(execTimeoutMs(undefined)).toBe(30_000);
    expect(execTimeoutMs(1)).toBe(1_000);
    expect(execTimeoutMs(9_999_999)).toBe(300_000);
    expect(execTimeoutMs(45_000)).toBe(45_000);
  });
});

describe("probeQuiet", () => {
  it("same size across the two probes means quiet, and reports the size", async () => {
    let calls = 0;
    const read: LogWindowReader = async () => ({ bytes: new Uint8Array(0), next: 0, size: 77 });
    void calls;
    const r = await probeQuiet(read, sleepNoop);
    expect(r).toEqual({ quiet: true, size: 77 });
  });
  it("a size that moved between probes is not quiet", async () => {
    let size = 10;
    const read: LogWindowReader = async () => {
      size += 5;
      return { bytes: new Uint8Array(0), next: 0, size };
    };
    expect((await probeQuiet(read, sleepNoop)).quiet).toBe(false);
  });
});

describe("waitSentinel", () => {
  it("finds the sentinel whole in one window and lands nextByte right after its newline", async () => {
    const log = enc.encode(`out line\n__xcomm_w1_DONE rc=0\n$ `);
    const r = await waitSentinel(readerOver(log), "w1", 0, {
      timeoutMs: 5_000,
      sleep: sleepNoop,
      now: () => 0,
    });
    expect(r.status).toBe("completed");
    expect(r.rc).toBe(0);
    expect(r.outputLines).toEqual(["out line"]);
    // nextByte: right after the sentinel's own newline, NOT the window end;
    // the "$ " after it must still be pending for the follow-up read.
    expect(log.subarray(r.nextByte)).toEqual(enc.encode("$ "));
  });

  it("finds the sentinel split across two reads (the liveness-rule case)", async () => {
    const log = enc.encode(`work\n__xcomm_w2_DON` + `E rc=7\nrest`);
    const r = await waitSentinel(readerOver(log, 13), "w2", 0, {
      timeoutMs: 20_000,
      ...clock,
    });
    expect(r).toMatchObject({ status: "completed", rc: 7, outputLines: ["work"] });
    expect(log.subarray(r.nextByte)).toEqual(enc.encode("rest"));
  });

  it("an unfound sentinel reports timed_out with everything seen and nothing touched", async () => {
    const log = enc.encode("still going\nstill going\n");
    let now = 0;
    const r = await waitSentinel(readerOver(log, 16), "w3", 0, {
      timeoutMs: 100,
      sleep: async (ms) => void (now += ms),
      now: () => now,
    });
    expect(r.status).toBe("timed_out");
    expect(r.rc).toBeNull();
    expect(r.outputLines.join("")).toContain("still going");
  });

  it("a pane that died mid-wait ends the wait immediately", async () => {
    let now = 0;
    const read = readerOver(enc.encode("x\n".repeat(500)), 8);
    const r = await waitSentinel(read, "w4", 0, {
      timeoutMs: 100_000,
      sleep: async (ms) => void (now += ms),
      now: () => now,
      alive: async () => now < 1_000, // dies at the second poll
    });
    expect(r.status).toBe("timed_out");
    expect(now).toBeLessThan(2_000); // did not run out the 100 s timeout
  });
});

describe("execOutputTail", () => {
  it("keeps whole lines from the newest backwards inside the cap", () => {
    const lines = ["a".repeat(100), "b".repeat(100), "c"];
    const r = execOutputTail(lines, 105);
    expect(r.text).toBe("b".repeat(100) + "\nc");
    expect(r.truncated).toBe(true);
  });
  it("under the cap: everything, not truncated", () => {
    const r = execOutputTail(["one", "two"], EXEC_MAX_OUTPUT_BYTES);
    expect(r).toEqual({ text: "one\ntwo", truncated: false });
  });
});
```

- [ ] **Step 2: Run them, verify they fail**

Run: `cd apps/server/api && bun test ./src/services/nodes/__tests__/pane-exec.test.ts`
Expected: FAIL, `Cannot find module '../pane-exec.js'`.

- [ ] **Step 3: Implement `pane-exec.ts`**

```ts
/**
 * The exec protocol, pure (spec 2026-10-02 §1). The pane's shell is dumb on
 * purpose; completion is machinery, and all of it lives here: the sentinel
 * line the plane types, the ACCUMULATED recognition (S1's liveness rule can
 * split the answer line across two cursor reads, so matching runs over the
 * merged line stream, never per window; a per-read match would answer a
 * finished command with a silent false timeout), the quiet probe that decides
 * whether anything may be typed yet, and the bounded wait loop. No launcher,
 * no DB, no Elysia: the service composes these over the LogWindowReader seam.
 */

import { LOG_WINDOW_DEFAULT_BYTES, cursorLinesFromWindow, type LogWindowReader } from "./log-tail.js";

/** A pane whose log size moved within this window is producing; typing now risks corruption. */
export const EXEC_QUIET_MS = 1_000;
/** Default wait for the sentinel; the caller may ask shorter or longer, never outside the clamp. */
export const EXEC_TIMEOUT_MS = 30_000;
export const EXEC_TIMEOUT_MIN = 1_000;
export const EXEC_TIMEOUT_MAX = 300_000;
/**
 * Poll cadence. Deliberately NOT `TAIL_POLL_MS` (50): that is the ATTACHED
 * pump's local stat-poll, and every remote exec poll is a SIGNED log_read
 * round trip - 500 ms bounds a max-timeout remote exec at 600 command frames
 * instead of thousands.
 */
export const EXEC_POLL_MS = 500;
/** The `output` keeps the newest lines inside this cap (the log-tail precedent). */
export const EXEC_MAX_OUTPUT_BYTES = 256 * 1024;

const TOKEN_RE = /^[0-9a-f]{16}$/;

/** One fresh sentinel token per exec; unguessable, so nothing else can complete the line. */
export function execSentinelToken(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The lone printf line typed after the command. `$?` is read when the shell parses THIS line. */
export function execSentinelCommand(token: string): string {
  if (!TOKEN_RE.test(token)) throw new Error("exec: sentinel token must be 16 lowercase hex chars");
  return `printf '__xcomm_${token}_DONE rc=%s\\n' "$?"`;
}

/** S1's liveness branch: a window with no newline returns its text partial and advances. */
export function windowIsPartial(bytes: Uint8Array): boolean {
  return bytes.byteLength > 0 && bytes.lastIndexOf(0x0a) === -1;
}

export interface SentinelScanner {
  /** Feed one read's stripped lines; a hit reports the rc and the line's index IN THIS WINDOW. */
  push(lines: string[], partialLast: boolean): { rc: number; hitInWindow: number } | null;
  /** Every completed non-sentinel line consumed so far. */
  output(): string[];
}

/**
 * Recognition over the merged stream. A partial tail line is CARRIED, never
 * matched (its remainder arrives as the next read's leading line and the two
 * are joined before the anchored test); the typed echo cannot match because
 * it carries quotes and a literal `$?` and sits behind prompt bytes.
 */
export function createSentinelScanner(token: string): SentinelScanner {
  const re = new RegExp(`^__xcomm_${token}_DONE rc=([0-9]+)$`);
  const out: string[] = [];
  let carry = "";
  return {
    push(lines, partialLast) {
      const complete = partialLast ? lines.slice(0, -1) : lines;
      const tail = partialLast ? (lines.at(-1) ?? "") : "";
      for (let i = 0; i < complete.length; i++) {
        const line = (i === 0 ? carry : "") + complete[i]!;
        carry = "";
        const m = re.exec(line);
        if (m) return { rc: Number(m[1]), hitInWindow: i };
        out.push(line);
      }
      carry += tail;
      return null;
    },
    output: () => out,
  };
}

/** Route-side clamp: absent means the default; out-of-range is pulled in, never refused. */
export function execTimeoutMs(requested: number | undefined): number {
  if (requested === undefined) return EXEC_TIMEOUT_MS;
  return Math.min(EXEC_TIMEOUT_MAX, Math.max(EXEC_TIMEOUT_MIN, Math.trunc(requested)));
}

/**
 * Two tiny reads at least `EXEC_QUIET_MS` apart; an unchanged whole-file size
 * across them is the quiet verdict (remote logs carry no mtime, so size is
 * the only shared signal both launchers can answer). `size` is the start
 * offset the caller sends from.
 */
export async function probeQuiet(
  read: LogWindowReader,
  sleep: (ms: number) => Promise<void>,
): Promise<{ quiet: boolean; size: number }> {
  const a = await read(0, 1);
  await sleep(EXEC_QUIET_MS);
  const b = await read(0, 1);
  return { quiet: a.size === b.size, size: b.size };
}

export interface ExecWaitAnswer {
  status: "completed" | "timed_out";
  rc: number | null;
  outputLines: string[];
  nextByte: number;
}

/**
 * Poll windows from `startByte` until the sentinel completes or the deadline
 * passes. `nextByte` on a hit is the offset right AFTER the sentinel line's
 * newline, found by walking the raw window (stripped lines correspond 1:1 to
 * raw newline-separated lines; ANSI runs do not contain newlines in practice,
 * and the answer line itself is plain bytes printf wrote). On a miss it is
 * where the scan stopped. `alive` false ends the wait early: polling a dead
 * pane's log is reading noise, and stopping touches nothing (ruling 2).
 */
export async function waitSentinel(
  read: LogWindowReader,
  token: string,
  startByte: number,
  opts: { timeoutMs: number; sleep: (ms: number) => Promise<void>; now: () => number; alive?: () => Promise<boolean> },
): Promise<ExecWaitAnswer> {
  const scanner = createSentinelScanner(token);
  const deadline = opts.now() + opts.timeoutMs;
  let cursor = startByte;
  for (;;) {
    if (opts.alive && !(await opts.alive())) {
      return { status: "timed_out", rc: null, outputLines: scanner.output(), nextByte: cursor };
    }
    const { bytes, size } = await read(cursor, LOG_WINDOW_DEFAULT_BYTES);
    const { lines, nextByte } = cursorLinesFromWindow(bytes, cursor, size);
    if (lines.length > 0) {
      const hit = scanner.push(lines, windowIsPartial(bytes));
      if (hit) {
        // The consumed portion of the window ends at its last newline; the
        // sentinel is the (hitInWindow+1)-th line of it, so summing raw line
        // lengths plus their newlines lands exactly after the sentinel.
        const consumed = bytes.subarray(0, nextByte - cursor);
        let after = 0;
        for (let seen = 0; seen <= hit.hitInWindow; ) {
          const nl = consumed.subarray(after).indexOf(0x0a);
          if (nl === -1) break; // unreachable on a hit: matched lines were complete
          after += nl + 1;
          seen++;
        }
        return {
          status: "completed",
          rc: hit.rc,
          outputLines: scanner.output(),
          nextByte: cursor + after,
        };
      }
      cursor = nextByte;
    }
    if (opts.now() >= deadline) {
      return { status: "timed_out", rc: null, outputLines: scanner.output(), nextByte: cursor };
    }
    await opts.sleep(EXEC_POLL_MS);
  }
}

/** Keep whole lines newest-first inside the byte cap; past it, the head is dropped and named. */
export function execOutputTail(lines: string[], capBytes: number): { text: string; truncated: boolean } {
  const total = lines.reduce((n, l) => n + l.length + 1, 0) - (lines.length > 0 ? 1 : 0);
  if (total <= capBytes) return { text: lines.join("\n"), truncated: false };
  let size = -1; // first join adds nothing before line 0; track as sum(len+1), fix at the end
  let start = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    size += lines[i]!.length + 1;
    if (size > capBytes) break;
    start = i;
  }
  const kept = lines.slice(start);
  return { text: kept.join("\n"), truncated: true };
}
```

- [ ] **Step 4: Run the tests, verify they pass**

Run: `cd apps/server/api && bun test ./src/services/nodes/__tests__/pane-exec.test.ts`
Expected: PASS (all suites).

- [ ] **Step 5: Static checks and commit**

```bash
bunx biome check apps/server/api/src/services/nodes/pane-exec.ts apps/server/api/src/services/nodes/__tests__/pane-exec.test.ts
cd apps/server/api && bunx turbo verify-types --filter=@internal/server   # from repo root: bunx turbo verify-types --filter=@internal/server
git add apps/server/api/src/services/nodes/pane-exec.ts apps/server/api/src/services/nodes/__tests__/pane-exec.test.ts
git commit -m "feat(server): the exec sentinel protocol, pure (spec 2026-10-02 §1)

Co-Authored-By: Claude Opus 4.8 (1M context)"
```

---

### Task 2: The service verb + the three error codes

**Files:**
- Modify: `packages/backend-errors/src/error-codes.ts` (add three enum members beside `SUBSHELL_NOT_RUNNING`)
- Modify: `apps/server/api/src/services/subshells.service.ts` (new method after `sendSubshellInput`)
- Test: `apps/server/api/src/services/__tests__/subshells-exec.test.ts`

**Interfaces:**
- Consumes: Task 1's exports; `#gate`, `launcherFor`, `tmuxSocketFor`, `getHarness`, `throwApiError`, `rethrowLaunchRefusal`, `this.repos.subshells` (all already used in the file).
- Produces (Task 3 rides exactly this): `SubshellsService.execInTerminal(viewerId: string, id: string, command: string, timeoutMs: number | undefined, actor: GuardActor): Promise<{ status: "completed" | "timed_out"; exitCode: number | null; output: string; truncated: boolean; nextByte: number }>`. Refusals are `throwApiError` with codes `EXEC_TERMINAL_ONLY` (400), `EXEC_PANE_BUSY` (409), `EXEC_IN_FLIGHT` (409), plus the input route's existing 403/404/409s.

- [ ] **Step 1: Add the codes**

In `packages/backend-errors/src/error-codes.ts`, after `SUBSHELL_NOT_RUNNING = "SUBSHELL_NOT_RUNNING",`:

```ts
  /** exec (spec 2026-10-02): the harness in this pane is not a terminal; nothing was typed. */
  EXEC_TERMINAL_ONLY = "EXEC_TERMINAL_ONLY",
  /** exec: the pane's log grew inside the quiet window; nothing was typed. */
  EXEC_PANE_BUSY = "EXEC_PANE_BUSY",
  /** exec: another exec already holds this pane's lease. */
  EXEC_IN_FLIGHT = "EXEC_IN_FLIGHT",
```

- [ ] **Step 2: Write the failing service test**

The service is exercised directly. Copy `subshell-input-route.test.ts`'s `beforeAll` setup block verbatim (auth users, rows, `attachScriptedNode`, `seedPreset`, the `LIFECYCLE` handler map), extend `LIFECYCLE` with a `log_read` handler whose SHAPE is copied verbatim from the scripted `log_read` case in `src/services/nodes/__tests__/remote-launcher.test.ts` (base64 window + `next` + whole-file `size`), and back that handler with a growing closure: calls with `fromByte === 0 && maxBytes === 1` (the quiet probes) report the scripted size; cursor calls return the scripted bytes. Write exactly these five cases:

1. exec on an AGENT-harness row answers 400 `EXEC_TERMINAL_ONLY` and the scripted node captured NO `input` and NO `log_read` frames after the setup drain (a refusal types nothing, and the type gate precedes even the probe).
2. exec on a terminal-harness row whose `log_read` size GROWS between the two probes answers 409 `EXEC_PANE_BUSY` with no `input` frames.
3. the happy path, fully written below.
4. while case 3 is in flight (hold its second probe with a deferred), a second `execInTerminal` on the same row answers 409 `EXEC_IN_FLIGHT`.
5. a terminated row (`status:"running", alive:0` - the parked shape) answers 409 `SUBSHELL_NOT_RUNNING` before the terminal-type check (mirror the input suite's ordering assertion, same scripted-node capture style).

Full case-3 code (others adapt by substitution):

```ts
it("types command+Enter, sentinel+Enter, and answers with the rc", async () => {
  const svc = /* the same SubshellsService construction subshell-input-route.test.ts uses */;
  const token = "0123456789abcdef";
  // Scripted log: one output line then the sentinel for token above.
  const log = new TextEncoder().encode(
    `out line\n__xcomm_${token}_DONE rc=0\n$ `,
  );
  // The handler needs the token the service will draw, so the service takes an
  // injectable token source in tests ONLY by exporting the seam: pass it as
  // the optional 6th arg `tokenSource` on execInTerminal (default
  // execSentinelToken). Keep the parameter internal (undocumented in the route).
  const answer = await svc.execInTerminal(ownerId, rowId, "echo hi", undefined, "cookie", {
    tokenSource: () => token,
  });
  expect(answer).toMatchObject({ status: "completed", exitCode: 0, truncated: false });
  expect(answer.output).toContain("out line");
  const frames = node.commands("input").map((c) => c.args.text);
  expect(frames.slice(0, 4)).toEqual(["echo hi", "\r", `printf '__xcomm_${token}_DONE rc=%s\\n' "$?"`, "\r"]);
});
```

If `node.commands("input")` differs in the scripted-node helper's real API, read `apps/server/api/src/test-helpers/scripted-node.ts` and use its actual capture accessor (the input route test shows the spelling; copy it).

- [ ] **Step 3: Run, verify failure**

Run: `cd apps/server/api && bun test ./src/services/__tests__/subshells-exec.test.ts`
Expected: FAIL, `execInTerminal is not a function`.

- [ ] **Step 4: Implement**

In `subshells.service.ts`, imports to extend: add from `@/services/nodes/pane-exec.js` the names used (`EXEC_MAX_OUTPUT_BYTES`, `execOutputTail`, `execSentinelCommand`, `execSentinelToken`, `execTimeoutMs`, `probeQuiet`, `waitSentinel`), and from `node:crypto` nothing (the token source is in pane-exec).

Add a class field beside the other module state:

```ts
  /** exec's per-pane lease (spec 2026-10-02 §2): the RESTART_IN_FLIGHT pattern,
   * service-scoped because exec never leaves this service. */
  #execInFlight = new Map<string, Promise<ExecAnswer>>();
```

and the method after `sendSubshellInput` (its comments carry the WHYs; do not thin them):

```ts
  /**
   * Run ONE shell command in a TERMINAL pane and answer with its output and
   * exit code (spec 2026-10-02). Everything the pane cannot tell us is
   * machinery's job: the sentinel protocol lives in `pane-exec.ts`, the two
   * sends ride the SAME `sendInput` seam as every keystroke in this app (argv
   * posture included, accepted §11.2), and the wait reads through the
   * `readLogWindow` seam the cursor reads already use. Gates mirror
   * `sendSubshellInput` verbatim (edit grant, the two facts, the offline
   * mapper) and ADD two: a non-terminal harness is refused by name (an
   * agent pane would eat the line into its own input box), and one exec per
   * pane at a time (interleaved sentinels corrupt each other). The quiet
   * check precedes EVERYTHING typed: a refusal never touches the pane, and
   * neither does a lease, timeout, or wait (ruling 2 - the command keeps
   * running; this call just stops watching). No publishLive, no audit row:
   * like input, the row never changed; the pane's own log records the typing.
   */
  async execInTerminal(
    viewerId: string,
    id: string,
    command: string,
    timeoutMs: number | undefined,
    actor: GuardActor,
    internal?: { tokenSource?: () => string },
  ): Promise<ExecAnswer> {
    const { row } = await this.#gate(viewerId, id, "edit", actor);
    if (row.status !== "running" || row.alive !== 1) {
      throwApiError({
        code: BackendErrorCodes.SUBSHELL_NOT_RUNNING,
        message: "The subshell is not running; nothing was typed. Restart it first.",
        doNotLog: true,
      });
    }
    if (getHarness(row.harnessId)?.type !== "terminal") {
      throwApiError({
        code: BackendErrorCodes.EXEC_TERMINAL_ONLY,
        message: "exec types shell commands into terminal panes; this pane runs a harness",
        doNotLog: true,
      });
    }
    const running = this.#execInFlight.get(id);
    if (running) {
      throwApiError({
        code: BackendErrorCodes.EXEC_IN_FLIGHT,
        message: "Another exec is already waiting on this pane; retry once it finishes",
        doNotLog: true,
      });
    }
    const call = this.#execInner(row, id, command, execTimeoutMs(timeoutMs), internal).finally(() =>
      this.#execInFlight.delete(id),
    );
    this.#execInFlight.set(id, call);
    return await call;
  }

  private async #execInner(
    row: SubshellTable,
    id: string,
    command: string,
    timeoutMs: number,
    internal?: { tokenSource?: () => string },
  ): Promise<ExecAnswer> {
    const launcher = launcherFor(row.nodeId);
    const socket = row.tmuxSocket ?? tmuxSocketFor(id);
    const read: LogWindowReader = (fromByte, maxBytes) => launcher.readLogWindow(id, fromByte, maxBytes).catch(rethrowLaunchRefusal);
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const quiet = await probeQuiet(read, sleep);
    if (!quiet.quiet) {
      throwApiError({
        code: BackendErrorCodes.EXEC_PANE_BUSY,
        message: "The pane is producing output; nothing was typed. Read it or wait, then retry.",
        doNotLog: true,
      });
    }
    const token = (internal?.tokenSource ?? execSentinelToken)();
    for (const text of [command, "\r", execSentinelCommand(token), "\r"]) {
      await launcher.sendInput(socket, id, text).catch(rethrowLaunchRefusal);
    }
    const waited = await waitSentinel(read, token, quiet.size, {
      timeoutMs,
      sleep,
      now: Date.now,
      alive: async () => {
        const fresh = await this.repos.subshells.find(id);
        return fresh?.status === "running" && fresh?.alive === 1;
      },
    });
    const tail = execOutputTail(waited.outputLines, EXEC_MAX_OUTPUT_BYTES);
    return {
      status: waited.status,
      exitCode: waited.rc,
      output: tail.text,
      truncated: tail.truncated,
      nextByte: waited.nextByte,
    };
  }
```

Declare `interface ExecAnswer { status: "completed" | "timed_out"; exitCode: number | null; output: string; truncated: boolean; nextByte: number }` in the same file (above the class) and export it. If `this.repos.subshells.find` is not the real method name, use whatever `getSubshell` uses for a single-row re-read. `SubshellTable` and `GuardActor` are already imported there.

- [ ] **Step 5: Run the test, verify it passes**

Run: `cd apps/server/api && bun test ./src/services/__tests__/subshells-exec.test.ts`
Expected: PASS.

- [ ] **Step 6: Rebuild backend-errors for consumers and commit**

```bash
bunx turbo build --filter=@internal/backend-errors --filter=@internal/server
bunx biome check apps/server/api/src/services/subshells.service.ts apps/server/api/src/services/__tests__/subshells-exec.test.ts packages/backend-errors/src/error-codes.ts
cd apps/server/api && bun test ./src/api/subshells/__tests__/subshell-input-route.test.ts   # the touched neighbor stays green
git add packages/backend-errors/src/error-codes.ts apps/server/api/src/services/subshells.service.ts apps/server/api/src/services/__tests__/subshells-exec.test.ts
git commit -m "feat(server): execInTerminal service verb with terminal gate, quiet check, and lease

Co-Authored-By: Claude Opus 4.8 (1M context)"
```

---

### Task 3: The route (`POST /api/subshells/:id/exec`)

**Files:**
- Create: `apps/server/api/src/api/subshells/exec-subshell.route.ts`
- Modify: `apps/server/api/src/api/subshells/index.ts` (import + `.use`, alphabetically the import list puts it after `deleteSubshellRoute`)
- Test: `apps/server/api/src/api/subshells/__tests__/subshell-exec-route.test.ts`

**Interfaces:**
- Consumes: `ctx.services.subshells.execInTerminal` (Task 2), `requirePerm`, `apiModels`, `execTimeoutMs` bounds for the schema limits.
- Produces: HTTP `POST /api/subshells/:id/exec`, body `{ command, timeoutMs? }`, 200 `{ status, exitCode, output, truncated, nextByte }`, operationId `execSubshell`. Task 4's MCP tool rides it.

- [ ] **Step 1: Write the failing route test**

Copy `subshell-input-route.test.ts`'s setup block verbatim (auth, rows, scripted node, `LIFECYCLE` map extended with a `log_read` handler that answers from a growing closure exactly as the Task 2 case-3 script does). Cases:

```ts
// 1. happy: POST /api/subshells/<id>/exec {command:"echo hi"} as the owner
//    cookie answers 200 {status:"completed", exitCode:0, output containing
//    "out line", truncated:false, nextByte:number>0}; the scripted node saw
//    the four input frames.
// 2. a `view` grantee POSTs 403 (and zero input frames were sent).
// 3. a foreign caller 404s.
// 4. a bearer pane key of the SAME owner acts (edit rides the owner path);
//    assert the 200 and the four frames.
// 5. body {command:""} and a 20 001-char command answer 400 (validation,
//    nothing typed) - mirror the input route's INPUT_VALIDATION_ERROR cases.
// 6. {command:"x", timeoutMs: 5} still completes (the clamp is a pull-in, not
//    a refusal): assert 200, not 400.
// 7. agent-harness row 400s with body.code === "EXEC_TERMINAL_ONLY".
// 8. dead row 409s with body.code === "SUBSHELL_NOT_RUNNING" before any frame.
```

- [ ] **Step 2: Run, verify failure** (`Cannot find module`/404s).

Run: `cd apps/server/api && bun test ./src/api/subshells/__tests__/subshell-exec-route.test.ts`

- [ ] **Step 3: Implement the route**

```ts
import { Elysia, t } from "elysia";
import { authGuard, requirePerm } from "@/api/auth-guard.js";
import { contextPlugin } from "@/plugins/context.plugin.js";
import { apiModels } from "@/api/models.js";
import { EXEC_TIMEOUT_MAX, EXEC_TIMEOUT_MIN } from "@/services/nodes/pane-exec.js";

/**
 * One shell command, run in a TERMINAL pane, answered with its output and
 * exit code (spec 2026-10-02). The sentinel protocol and every refusal that
 * types nothing live in the service; this file is shape only. `timeoutMs` is
 * CLAMPED by the service, not refused out of range: a caller asking 1 ms or
 * 99 hours still means "run it".
 */
const ExecBodySchema = t.Object(
  {
    command: t.String({
      minLength: 1,
      maxLength: 20000,
      description: "The shell command line, typed verbatim through the same keystroke seam as pane input",
    }),
    timeoutMs: t.Optional(
      t.Number({
        minimum: EXEC_TIMEOUT_MIN,
        maximum: EXEC_TIMEOUT_MAX,
        description:
          "How long to wait for the shell's sentinel before answering timed_out (default 30000; clamped 1000..300000; a timeout never touches the pane)",
      }),
    ),
  },
  { description: "One command to run in a terminal pane's shell" },
);

const ExecResultSchema = t.Object({
  status: t.Union([t.Literal("completed"), t.Literal("timed_out")], {
    description: "completed: the sentinel arrived and exitCode is the command's status; timed_out: it did not, nothing further was typed",
  }),
  exitCode: t.Nullable(
    t.Number({ description: "The shell's status for the command; null unless status is completed" }),
  ),
  output: t.String({
    description: "The pane's lines from before the command until the sentinel (includes the shell's echo of the typed command); newest-kept past the cap",
  }),
  truncated: t.Boolean({ description: "True when output dropped older lines to stay inside the 256 KiB cap" }),
  nextByte: t.Number({ description: "Raw log offset just after the sentinel line (or where the wait stopped); pass it as read_subshell_log's from_byte to continue exactly" }),
});

/**
 * `POST /api/subshells/:id/exec` (spec 2026-10-02). Gates mirror the input
 * route (an `edit` act; view 403, foreign 404, bearer as owner), plus: the
 * pane must run a `terminal`-type harness (400 EXEC_TERMINAL_ONLY - an agent
 * pane would read the line into its own input), the pane must be quiet first
 * (409 EXEC_PANE_BUSY, nothing typed), and one exec at a time per pane
 * (409 EXEC_IN_FLIGHT). A `timed_out` 200 is a SUCCESS response by ruling: a
 * slow build is not an error path.
 */
export const execSubshellRoute = new Elysia()
  .use(contextPlugin)
  .use(authGuard)
  .use(apiModels)
  .post(
    "/:id/exec",
    async ({ params, body, user, actor, apiKeyPermissions, ctx }) => {
      requirePerm({ actor, apiKeyPermissions }, "subshells", "write");
      return await ctx.services.subshells.execInTerminal(user.id, params.id, body.command, body.timeoutMs, actor);
    },
    {
      body: ExecBodySchema,
      response: {
        200: ExecResultSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
        409: "ApiErrorResponse",
      },
      detail: {
        operationId: "execSubshell",
        tags: ["subshells"],
        description:
          "Run one command in a terminal pane's shell and return its output and exit code (an edit act; refusals type nothing)",
      },
    },
  );
```

Mount in `index.ts`: add the import line in the alphabetical list and `.use(execSubshellRoute)` after `.use(inputSubshellRoute)`.

- [ ] **Step 4: Run the test, verify it passes**

Run: `cd apps/server/api && bun test ./src/api/subshells/__tests__/subshell-exec-route.test.ts ./src/api/subshells/__tests__/subshell-input-route.test.ts`
Expected: both PASS (the neighbor guards the mount from breaking sibling routes).

- [ ] **Step 5: Build the Eden client and commit**

```bash
bunx turbo build --filter=@internal/server --filter=@internal/backend-client
bunx biome check apps/server/api/src/api/subshells/exec-subshell.route.ts apps/server/api/src/api/subshells/index.ts apps/server/api/src/api/subshells/__tests__/subshell-exec-route.test.ts
git add apps/server/api/src/api/subshells/exec-subshell.route.ts apps/server/api/src/api/subshells/index.ts apps/server/api/src/api/subshells/__tests__/subshell-exec-route.test.ts
git commit -m "feat(server): POST /api/subshells/:id/exec (spec 2026-10-02)

Co-Authored-By: Claude Opus 4.8 (1M context)"
```

---

### Task 4: The MCP tool (`exec_in_terminal`)

**Files:**
- Create: `packages/mcp-core/src/terminal-tools.ts`
- Modify: `packages/mcp-core/src/server.ts` (register after the `send_to_subshell` block)
- Modify: `packages/mcp-core/src/tools.ts` (three `describeToolError` branches + the doc-comment's code list)
- Test: `packages/mcp-core/src/__tests__/terminal-tools.test.ts` (new), `packages/mcp-core/src/__tests__/tools.test.ts` (extend), `packages/mcp-core/src/__tests__/server.test.ts` (name set + description pins)

**Interfaces:**
- Consumes: Task 3's HTTP shape; `ToolApi`, `ToolDeps`, `describeToolError`/`ApiError` patterns already in `tools.ts`; the `guard()` wrapper in `server.ts`.
- Produces: MCP tool `exec_in_terminal` (21st on this branch), args `{subshell_id, command, timeout_ms?}`, text content = the server's JSON.

- [ ] **Step 1: The failing MCP tests**

`terminal-tools.test.ts` (fakeApi idiom copied from `tools.test.ts`):

```ts
import { describe, expect, it } from "bun:test";
import { execInTerminal } from "../terminal-tools.js";
import type { ToolApi } from "../tools.js";

function api(calls: { path: string; method: string; body?: unknown }[]): ToolApi {
  return {
    async req<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
      calls.push({ path, method: init?.method ?? "GET", body: init?.body });
      return { status: "completed", exitCode: 0, output: "ok", truncated: false, nextByte: 42 } as T;
    },
  };
}

describe("execInTerminal (MCP thin POST)", () => {
  it("POSTs the camelCase body and passes the answer through untouched", async () => {
    const calls: { path: string; method: string; body?: unknown }[] = [];
    const own = { /* copy the minimal IdentityKeyPair stub tools.test.ts uses */ };
    const out = await execInTerminal({ api: api(calls), own } as never, {
      subshell_id: "s/1",
      command: "echo hi",
      timeout_ms: 5000,
    });
    expect(calls[0]).toEqual({
      path: "/api/subshells/s%2F1/exec",
      method: "POST",
      body: { command: "echo hi", timeoutMs: 5000 },
    });
    expect(out).toMatchObject({ status: "completed", exitCode: 0 });
  });
  it("omits timeoutMs when the caller named none", async () => {
    const calls: unknown[] = [];
    // same construction; assert body deep-equals { command: "ls" } exactly
  });
});
```

Extend `tools.test.ts`'s `describeToolError` suite (follow the existing NODE_* branch tests' shape): an `ApiError` with `code: "EXEC_PANE_BUSY"` answers a message containing "producing output" and "nothing was typed"; `EXEC_TERMINAL_ONLY` names `send_to_subshell`; `EXEC_IN_FLIGHT` names "retry". Extend `server.test.ts`: add `"exec_in_terminal"` to the pinned name set (making 21 on this branch), and pin the description carries "POSIX" and "timed_out" (the shell-contract honesty), and leave `SUBSHELL_MCP_INSTRUCTIONS` UNTOUCHED (the budget pins prove it: briefing text does not grow; the tool description carries the guidance).

- [ ] **Step 2: Run, verify failure.**
  `cd packages/mcp-core && bun test ./src/__tests__/terminal-tools.test.ts ./src/__tests__/tools.test.ts ./src/__tests__/server.test.ts` (module not found).

- [ ] **Step 3: Implement**

`terminal-tools.ts`:

```ts
import type { z } from "zod";
import type { ToolDeps } from "./tools.js";

/**
 * The terminal-family MCP tools (spec 2026-10-02). Own file for the same
 * reason transfer-tools.ts exists: subshell-tools.ts passed its size budget
 * long ago, and the terminal family (exec today) deserves a seam of its own.
 */

/** Schema for `exec_in_terminal`. MCP args stay snake_case; the verb's body is camelCase. */
export const ExecInTerminalToolSchema = {
  subshell_id: z.string().describe("The terminal pane's subshell id (find it with list_subshells)"),
  command: z.string().describe("One shell command line, typed verbatim into the pane's shell"),
  timeout_ms: z
    .number()
    .int()
    .min(1000)
    .max(300000)
    .optional()
    .describe("How long to wait for the command (default 30000, max 300000; a timeout never touches the pane)"),
};

export interface ExecInTerminalArgs {
  subshell_id: string;
  command: string;
  timeout_ms?: number;
}

/** `exec_in_terminal`: one command in a terminal pane, answered by the server's sentinel machinery. */
export async function execInTerminal(
  deps: ToolDeps,
  args: ExecInTerminalArgs,
): Promise<{ status: string; exitCode: number | null; output: string; truncated: boolean; nextByte: number }> {
  return await deps.api.req(`/api/subshells/${encodeURIComponent(args.subshell_id)}/exec`, {
    method: "POST",
    body: { command: args.command, ...(args.timeout_ms !== undefined ? { timeoutMs: args.timeout_ms } : {}) },
  });
}
```

(If `server.ts`'s registrations inline their `z.object({...})` at the call site, that remains the KNOWN documented divergence in `rules/code-style.md`; new tools follow the named-constant rule, so export the shape above and use `z.object(ExecInTerminalToolSchema)` at registration.)

`server.ts`, directly after the `send_to_subshell` block:

```ts
  server.registerTool(
    "exec_in_terminal",
    {
      title: "Exec in terminal",
      description:
        "Run one shell command in a terminal pane and return its output and exit code once the shell's sentinel confirms. Refuses without typing while the pane is producing output; on timeout it touches nothing and reports what printed so far. Interactive programs (password prompts, editors, TUIs) belong to send_to_subshell plus read_subshell_log, and the exit-code sentinel speaks POSIX: a fish pane answers timed_out once its command completes.",
      inputSchema: z.object(ExecInTerminalToolSchema),
    },
    guard(({ subshell_id, command, timeout_ms }: ExecInTerminalArgs) =>
      execInTerminal(deps, { subshell_id, command, ...(timeout_ms !== undefined ? { timeout_ms } : {}) }),
    ),
  );
```

`tools.ts`: three branches BEFORE the `status === 401` one (named codes come first, like NODE_*):

```ts
    if (err.code === "EXEC_PANE_BUSY") {
      return new Error(`subshell: the pane is producing output, nothing was typed (${err.message}); read it first or wait, then retry`);
    }
    if (err.code === "EXEC_TERMINAL_ONLY") {
      return new Error(`subshell: exec runs shell commands in terminal panes only (${err.message}); to type into this pane, use send_to_subshell`);
    }
    if (err.code === "EXEC_IN_FLIGHT") {
      return new Error(`subshell: another exec is already waiting on this pane (${err.message}); retry once it finishes`);
    }
```

And amend the file's doc comment: it enumerates the mapped codes ("maps exactly the five values...") - update the list to the eight it now names, keeping the paragraph's honest framing (nothing is mapped that cannot arrive).

- [ ] **Step 4: Run tests, verify they pass.**

Run: `cd packages/mcp-core && bun test`
Expected: PASS (name set now 21 on this branch).

- [ ] **Step 5: Build the package for consumers and commit.**

```bash
bunx turbo build --filter=@internal/mcp-core
bunx biome check packages/mcp-core/src/terminal-tools.ts packages/mcp-core/src/server.ts packages/mcp-core/src/tools.ts packages/mcp-core/src/__tests__/
git add packages/mcp-core/src/terminal-tools.ts packages/mcp-core/src/server.ts packages/mcp-core/src/tools.ts packages/mcp-core/src/__tests__/terminal-tools.test.ts packages/mcp-core/src/__tests__/tools.test.ts packages/mcp-core/src/__tests__/server.test.ts
git commit -m "feat(mcp): exec_in_terminal tool over the exec verb (spec 2026-10-02)

Co-Authored-By: Claude Opus 4.8 (1M context)"
```

---

### Task 5: Docs, changesets, full boundary, push

**Files:**
- Modify: `apps/docs/content/docs/mcp/tools.mdx` (new tool section)
- Modify: the terminal-sessions guide page (find it: `grep -rl "read_subshell_log" apps/docs/content/docs | head`; add one paragraph)
- Modify: `docs/security.md` (pane logs & input section, one sentence) and `.claude/rules/security-context.md` (the matching bullet)
- Create: one changeset file under `.changeset/` (copy the S1 exec-era changeset's shape: `git show feat/mcp-terminal-sessions --stat | grep changeset` to see the naming convention, then `ls .changeset`)
- No source changes.

- [ ] **Step 1: Docs.** `tools.mdx`: add `exec_in_terminal` following the file's existing per-tool heading style; state the four answers (`completed`/`timed_out`, refusals type nothing, POSIX/fish boundary, interactive goes to send/read). The guide page: one paragraph contrasting exec with the manual send+cursor loop. `docs/security.md` pane-logs section, after the `POST /api/subshells/:id/input` paragraph, one sentence: exec rides the same `sendInput` seam and argv posture, the sentinel line lands in the pane's own log (random noise, not data), `timed_out` never signals. Mirror one clause into the `security-context.md` REST-input bullet's neighborhood. No U+2014 in any of it.

- [ ] **Step 2: Changeset.** New `.changeset/<random-words>.md` marking `@internal/server`: minor and `@internal/mcp-core`: minor, one-line descriptions naming the verb and the tool.

- [ ] **Step 3: Full boundary.** From repo root:

```bash
bunx turbo build && bun run verify-types && bun run lint:check && bun run lint:prose && bun run test
```

Expected: exit 0 across all five. If `lint:prose` flags your prose, it is an em dash or a voice rule; fix the prose, not the linter.

- [ ] **Step 4: Commit and push the branch (no merge, no PR against main - the base is the S1 branch).**

```bash
git add apps/docs/content/docs/mcp/tools.mdx docs/security.md .claude/rules/security-context.md .changeset/
# plus the terminal-sessions guide page edited in Step 1 (its exact path came from that grep)
git commit -m "docs: exec_in_terminal docs, security note, changesets (spec 2026-10-02)

Co-Authored-By: Claude Opus 4.8 (1M context)"
git push
gh pr create --base feat/mcp-terminal-sessions --title "exec_in_terminal: one command in a terminal pane, with the exit code" --body "Spec: docs/superpowers/specs/2026-10-02-agent-exec-terminal-design.md (sections cited inline). Stacked on the terminal-sessions branch; do not merge before the operator verifies behavior."
```

---

## Self-review notes (plan vs spec)

- Spec §1 (token, two sends, anchored recognition over the ACCUMULATED stream, output slicing + nextByte-after-sentinel): Task 1 + its tests (the split-window case is its own test). Fish/POSIX: Task 1 test + Task 4 description pin. The two-sends race/partial-pair honesty: service doc comment (Task 2) + docs sentence (Task 5).
- Spec §2 (gate order incl. terminal-type, quiet probe, lease, clamp, dead-pane early stop, camelCase wire, no audit): Task 2 + Task 3 route tests each name their case.
- Spec §3 (own file, name deviation decided, three describeToolError branches, name-set pin, instructions untouched at 1166): Task 4; the instructions budget is asserted by the EXISTING pin (untouched text cannot break it - the pin staying green is the proof).
- Spec §4 docs/security/changesets: Task 5. Spec §5 test list: every line has a home (pure-helper cases, scripted-node frames, gate matrix, MCP pass-through + branches; "no compiled-binary gate" honored - Task 5's boundary adds no test:cli).
- Type consistency: `ExecAnswer` (service) = the route 200 = the tool's declared return; `waitSentinel` returns `rc`/`outputLines`/`nextByte`, mapped to `exitCode`/`output`+`truncated`/`nextByte` in `#execInner` only.
