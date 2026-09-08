# Terminal Paste & File Drop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the session terminal accept pasted images and dragged/dropped files by uploading them into the session's workspace and injecting their absolute paths into the terminal.

**Architecture:** All client→server WS frames become JSON (`{type:"input"|"resize"}`) via a new shared `@internal/session-protocol` package. Files reach the server over a multipart `POST /api/sessions/:id/uploads`, land in `<workspace>/.mote/uploads/`, and their paths are injected wrapped in bracketed-paste markers so a leading `/` does not trigger Claude Code's slash-command palette. `react-dropzone` supplies both the drop target and the clipboard-file paste handler. Adopting `@xterm/addon-serialize` deletes the hand-rolled transcript accumulator, which forces (and is repaid by) adopting `@xterm/addon-search`.

**Tech Stack:** Bun, Elysia 1.4.29, Kysely/SQLite, React 19 + TanStack Router/Query, xterm 6, Tailwind. New deps: `react-dropzone@20.1.1`, `sanitize-filename@1.6.4`, `file-type@22.0.2`, `@xterm/addon-serialize@0.14.0`, `@xterm/addon-search@0.16.0`.

**Spec:** `docs/superpowers/specs/2026-08-27-terminal-uploads-design.md`

## Global Constraints

- **Package manager is Bun only.** `bun install`, `bun add`, `bunx`. Never npm/pnpm/yarn.
- **All dependency versions must be pinned** (no `^`/`~`). After any `bun add`, run `bunx syncpack fix` then `bun install`. The pre-commit hook rejects unpinned versions.
- **No dynamic `await import(...)` anywhere.** Static top-level imports only — dynamic imports break `bun build --compile`.
- **Every Elysia `t` schema property needs a `description`** (feeds OpenAPI → the generated `@internal/backend-client`).
- **All public functions/classes get JSDoc; all interface properties get JSDoc.**
- **Define schemas as named constants**, never inline in the `registerTool`/route call.
- **Files stay focused.** Split beyond ~300–400 lines; route components beyond ~200 lines push logic into `src/hooks/`, `src/components/`, `src/lib/`.
- **Verification after every task:** `bun run verify-types`, `bunx turbo run lint`, `bun test`. `turbo build` additionally after Task 4 (new route changes the OpenAPI spec).
- **Upload cap is exactly 25MB** (`t.File({ maxSize: "25m" })`, and `maxSize: 25 * 1024 * 1024` on the client).
- **Uploads directory is exactly `<workspace>/.mote/uploads/`**, workspace-scoped, never auto-deleted.

### Pre-existing failures — NOT regressions, do not "fix" them

These are red on `main` before this work starts. Confirm they are still the *only* failures; never treat them as caused by a task:

- `TmuxRunner > streams output to a pipe-pane file` (test attaches `pipe-pane` after the pane's `echo` already ran).
- `SessionManagerService notes + restart > restartSession clones profile/workspace with a (2) name`.
- `workspaces route > admin creates a workspace (POST) and lists it (GET)`.
- `@internal/frontend#verify-types` → `Cannot find module 'vitest/config'` (vestigial `apps/frontend/vitest.config.ts`; vitest is not installed and the `test` script is `bun test --pass-with-no-tests`).

Also note `bun test` in `apps/backend` picks up stale compiled copies under `dist/`, so failures may appear twice. Run `bun test src` to see source-only results.

---

## File Structure

**New — `packages/session-protocol/`** (the WS contract, shared by both apps)
- `src/frames.ts` — `ClientFrame`, `ServerFrame`, `parseClientFrame`, bracketed-paste constants
- `src/index.ts` — re-export
- `src/__tests__/frames.test.ts`
- `package.json`, `tsconfig.json`, `tsdown.config.ts` — cloned from `packages/backend-errors`

**Backend**
- Modify `src/ws/session-ws.ts` — frame dispatch
- Modify `src/ws/ws.plugin.ts` — stop re-stringifying
- Modify `src/ws/__tests__/session-ws.test.ts` — JSON frame shape
- Create `src/services/uploads.service.ts` — path/name/git-exclude/write helpers
- Create `src/services/__tests__/uploads.service.test.ts`
- Create `src/api/uploads.route.ts` — `POST /api/sessions/:id/uploads`
- Create `src/api/__tests__/helpers/auth-tables.ts` — extracted table setup + `signIn` + `authedRequest`
- Create `src/api/__tests__/uploads-route.test.ts`
- Modify `src/api/routes.ts` — register the route

**Frontend**
- Create `src/lib/session-frames.ts` — frame senders + bracketed-paste wrapping
- Create `src/lib/session-uploads.ts` — upload call + pure text helpers
- Create `src/lib/__tests__/session-uploads.test.ts`
- Create `src/hooks/use-terminal-uploads.ts` — react-dropzone wrapper
- Create `src/components/terminal-drop-overlay.tsx`
- Modify `src/lib/use-session-ws.ts` — JSON frames; delete `onFrame`/`onReplay`
- Modify `src/routes/sessions_.$id.tsx` — addons, dropzone root, overlay; delete `transcriptRef`
- Rewrite `src/components/transcript-search.tsx` — driven by `SearchAddon`

**Docs**
- Modify `docs/overview.md` — protocol + uploads rows

---

### Task 1: `@internal/session-protocol` package

**Files:**
- Create: `packages/session-protocol/package.json`
- Create: `packages/session-protocol/tsconfig.json`
- Create: `packages/session-protocol/tsdown.config.ts`
- Create: `packages/session-protocol/src/frames.ts`
- Create: `packages/session-protocol/src/index.ts`
- Test: `packages/session-protocol/src/__tests__/frames.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ClientFrame`, `ServerFrame`, `parseClientFrame(raw: string | object): ClientFrame | null`, `BRACKETED_PASTE_START: string`, `BRACKETED_PASTE_END: string`. Tasks 2, 5 and 6 import these from `@internal/session-protocol`.

- [ ] **Step 1: Scaffold the package by cloning `backend-errors` config**

```bash
mkdir -p packages/session-protocol/src/__tests__
cp packages/backend-errors/tsconfig.json packages/session-protocol/tsconfig.json
cp packages/backend-errors/tsdown.config.ts packages/session-protocol/tsdown.config.ts
```

Then write `packages/session-protocol/package.json`, copying the `scripts` block verbatim from `packages/backend-errors/package.json` (build, build:dev, clean, lint, lint:staged, verify-types) and using no dependencies:

```json
{
  "name": "@internal/session-protocol",
  "description": "WebSocket frame contract shared by the backend and frontend",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "types": "dist/index.d.ts"
}
```

Open `packages/backend-errors/package.json`, copy its `scripts` and `devDependencies` objects into this file, then verify `tsdown.config.ts` points at `src/index.ts` (adjust if the copied config names a different entry).

- [ ] **Step 2: Write the failing test**

`packages/session-protocol/src/__tests__/frames.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { BRACKETED_PASTE_END, BRACKETED_PASTE_START, parseClientFrame } from "../frames.js";

describe("parseClientFrame", () => {
  it("parses an input frame from a JSON string", () => {
    expect(parseClientFrame(JSON.stringify({ type: "input", data: "hello" }))).toEqual({
      type: "input",
      data: "hello",
    });
  });

  it("parses an input frame from an already-parsed object", () => {
    expect(parseClientFrame({ type: "input", data: "x" })).toEqual({ type: "input", data: "x" });
  });

  it("preserves control bytes in input data", () => {
    const data = "\x04\x1b[A\r";
    expect(parseClientFrame(JSON.stringify({ type: "input", data }))).toEqual({ type: "input", data });
  });

  it("parses a resize frame", () => {
    expect(parseClientFrame(JSON.stringify({ type: "resize", cols: 120, rows: 40 }))).toEqual({
      type: "resize",
      cols: 120,
      rows: 40,
    });
  });

  it("returns null for malformed JSON", () => {
    expect(parseClientFrame("{not json")).toBeNull();
  });

  it("returns null for a JSON array", () => {
    expect(parseClientFrame("[1,2,3]")).toBeNull();
  });

  it("returns null for an unknown type", () => {
    expect(parseClientFrame(JSON.stringify({ type: "explode" }))).toBeNull();
  });

  it("returns null when input data is not a string", () => {
    expect(parseClientFrame(JSON.stringify({ type: "input", data: 42 }))).toBeNull();
  });

  it("returns null when resize dimensions are missing or non-numeric", () => {
    expect(parseClientFrame(JSON.stringify({ type: "resize", cols: 80 }))).toBeNull();
    expect(parseClientFrame(JSON.stringify({ type: "resize", cols: "80", rows: 24 }))).toBeNull();
  });

  it("returns null for a resize with non-positive dimensions", () => {
    expect(parseClientFrame(JSON.stringify({ type: "resize", cols: 0, rows: 24 }))).toBeNull();
  });

  it("exposes the bracketed paste markers", () => {
    expect(BRACKETED_PASTE_START).toBe("\x1b[200~");
    expect(BRACKETED_PASTE_END).toBe("\x1b[201~");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd packages/session-protocol && bun test`
Expected: FAIL — `Cannot find module '../frames.js'`.

- [ ] **Step 4: Implement `src/frames.ts`**

```ts
/**
 * Start of a bracketed paste (DECSET 2004). Wrapping injected text in these
 * markers makes a TUI treat it as pasted content rather than keystrokes —
 * essential because an injected absolute path begins with "/", which Claude
 * Code would otherwise read as the start of a slash command.
 */
export const BRACKETED_PASTE_START = "\x1b[200~";

/** End of a bracketed paste. Pairs with {@link BRACKETED_PASTE_START}. */
export const BRACKETED_PASTE_END = "\x1b[201~";

/**
 * A frame sent by the browser to the session WebSocket.
 *
 * Every client frame is JSON. There is deliberately no "raw text means
 * input" fallback: that heuristic could not distinguish terminal input from
 * a control message when the user pasted a JSON object.
 */
export type ClientFrame =
  | {
      /** Raw terminal input, forwarded to the pane byte for byte. */
      type: "input";
      /**
       * The exact bytes the pane's process should receive. Control bytes are
       * carried as-is (JSON escapes them), so "\r", "\x04" and escape
       * sequences need no extra encoding.
       */
      data: string;
    }
  | {
      /** Client terminal geometry changed; resize the tmux window to match. */
      type: "resize";
      /** Terminal width in columns; must be positive. */
      cols: number;
      /** Terminal height in rows; must be positive. */
      rows: number;
    };

/**
 * A frame sent by the session WebSocket to the browser.
 */
export interface ServerFrame {
  /** `replay` rebuilds history on attach; `output` is live pane output. */
  type: "replay" | "output";
  /** Terminal bytes, including ANSI escape sequences. Absent on empty frames. */
  data?: string;
}

/**
 * Validates and narrows an incoming client frame.
 *
 * Accepts either the raw JSON text or an already-parsed object, because
 * Elysia's WebSocket middleware JSON-parses frames before handing them over.
 *
 * @param raw - The frame as received (JSON string or parsed object)
 * @returns The narrowed frame, or `null` if it is not a valid client frame
 */
export function parseClientFrame(raw: string | object): ClientFrame | null {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const frame = value as Record<string, unknown>;
  if (frame.type === "input") {
    return typeof frame.data === "string" ? { type: "input", data: frame.data } : null;
  }
  if (frame.type === "resize") {
    const { cols, rows } = frame;
    if (typeof cols !== "number" || typeof rows !== "number") return null;
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols <= 0 || rows <= 0) return null;
    return { type: "resize", cols, rows };
  }
  return null;
}
```

`src/index.ts`:

```ts
export {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  type ClientFrame,
  parseClientFrame,
  type ServerFrame,
} from "./frames.js";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/session-protocol && bun test`
Expected: PASS, 11 tests.

- [ ] **Step 6: Wire the package into both apps and build it**

Add `"@internal/session-protocol": "workspace:*"` to the `dependencies` of both `apps/backend/package.json` and `apps/frontend/package.json`, then:

```bash
bun install
bunx turbo run build --filter=@internal/session-protocol
bun run verify-types
bunx turbo run lint
```

Expected: the package builds to `dist/`; `verify-types` shows only the pre-existing frontend `vitest/config` failure.

- [ ] **Step 7: Commit**

```bash
git add packages/session-protocol apps/backend/package.json apps/frontend/package.json bun.lock
git commit -m "feat(protocol): add @internal/session-protocol WS frame contract"
```

---

### Task 2: Switch the WS to JSON frames (backend + frontend, atomic)

Both sides must change together — a protocol change cannot be half-deployed, and no compatibility shim is wanted (nothing is deployed).

**Files:**
- Modify: `apps/backend/src/ws/session-ws.ts` (`handleSessionMessage`, ~line 168-195)
- Modify: `apps/backend/src/ws/ws.plugin.ts` (`message` handler, ~line 22-31)
- Modify: `apps/backend/src/ws/__tests__/session-ws.test.ts`
- Create: `apps/frontend/src/lib/session-frames.ts`
- Modify: `apps/frontend/src/lib/use-session-ws.ts`
- Modify: `apps/frontend/src/routes/sessions_.$id.tsx` (`sendCtlD`, ~line 193)

**Interfaces:**
- Consumes: `parseClientFrame`, `ClientFrame`, `ServerFrame`, `BRACKETED_PASTE_START`, `BRACKETED_PASTE_END` from `@internal/session-protocol`; `TmuxRunner.sendInput(socket, sessionName, input)` (already exists).
- Produces (frontend, from `@/lib/session-frames.js`):
  - `sendInput(ws: WebSocket | null, data: string): void`
  - `sendResize(ws: WebSocket | null, cols: number, rows: number): void`
  - `injectText(ws: WebSocket | null, text: string, bracketed: boolean): void`
  Task 5 calls `injectText`; Task 6 calls `sendInput`.

- [ ] **Step 1: Update the backend WS tests to the JSON frame shape**

Replace the body of `apps/backend/src/ws/__tests__/session-ws.test.ts`'s `describe` with these cases (keep the existing `fakeSocket` helper exactly as it is):

```ts
describe("handleSessionMessage", () => {
  it("forwards a keystroke without submitting it", () => {
    const { ws, inputs } = fakeSocket();
    for (const ch of "hello") handleSessionMessage(ws, JSON.stringify({ type: "input", data: ch }));
    expect(inputs).toEqual(["h", "e", "l", "l", "o"]);
  });

  it("forwards a multi-line paste as a single unmodified chunk", () => {
    const { ws, inputs } = fakeSocket();
    const data = "line one\nline two\n\nline four";
    handleSessionMessage(ws, JSON.stringify({ type: "input", data }));
    expect(inputs).toEqual([data]);
  });

  it("forwards control bytes verbatim", () => {
    const { ws, inputs } = fakeSocket();
    for (const data of ["\x04", "\x1b[A", "\r"]) {
      handleSessionMessage(ws, JSON.stringify({ type: "input", data }));
    }
    expect(inputs).toEqual(["\x04", "\x1b[A", "\r"]);
  });

  it("delivers a pasted JSON object verbatim instead of eating it as a control frame", () => {
    const { ws, inputs, resizes } = fakeSocket();
    const pasted = '{"type":"resize","cols":1,"rows":1}';
    handleSessionMessage(ws, JSON.stringify({ type: "input", data: pasted }));
    expect(inputs).toEqual([pasted]);
    expect(resizes).toEqual([]);
  });

  it("accepts an already-parsed frame object from Elysia", () => {
    const { ws, resizes } = fakeSocket();
    handleSessionMessage(ws, { type: "resize", cols: 120, rows: 40 });
    expect(resizes).toEqual([{ cols: 120, rows: 40 }]);
  });

  it("routes a resize frame to tmux instead of stdin", () => {
    const { ws, inputs, resizes } = fakeSocket();
    handleSessionMessage(ws, JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
    expect(resizes).toEqual([{ cols: 120, rows: 40 }]);
    expect(inputs).toEqual([]);
  });

  it("ignores an empty input frame", () => {
    const { ws, inputs } = fakeSocket();
    handleSessionMessage(ws, JSON.stringify({ type: "input", data: "" }));
    expect(inputs).toEqual([]);
  });

  it("drops malformed and unknown frames without throwing", () => {
    const { ws, inputs, resizes } = fakeSocket();
    handleSessionMessage(ws, "{not json");
    handleSessionMessage(ws, JSON.stringify({ type: "explode" }));
    handleSessionMessage(ws, "plain text is no longer input");
    expect(inputs).toEqual([]);
    expect(resizes).toEqual([]);
  });
});
```

Also widen the import and the handler's parameter type in the test file's `handleSessionMessage(ws, ...)` calls — the signature becomes `(ws: WsSocket, message: string | object)`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/backend && bun test src/ws`
Expected: FAIL — the raw-text path still treats `'{"type":"input",...}'` as literal input, so `inputs` contains JSON text rather than `"h"`.

- [ ] **Step 3: Implement the backend dispatch**

In `apps/backend/src/ws/session-ws.ts`, replace `handleSessionMessage` entirely:

```ts
/**
 * Client → server frame dispatch.
 *
 * Every client frame is JSON (see `@internal/session-protocol`). Elysia's
 * WebSocket middleware JSON-parses frames that start with `{`, so `message`
 * may arrive as either the raw text or an already-parsed object;
 * `parseClientFrame` accepts both. Anything that is not a valid frame is
 * logged and dropped — it can no longer be mistaken for terminal input.
 */
export function handleSessionMessage(ws: WsSocket, message: string | object): void {
  const data = ws.data;
  if (!data?.tmux) return;
  const frame = parseClientFrame(message);
  if (!frame) {
    logger.warn("ws: dropped unrecognized client frame");
    return;
  }
  try {
    if (frame.type === "resize") {
      data.tmux.resizeWindow(data.socket, data.sessionId, frame.cols, frame.rows);
      return;
    }
    // Raw terminal input, forwarded verbatim. The client emits one frame per
    // keystroke and already encodes Enter as "\r", so the bytes must not be
    // split, filtered or terminated here.
    if (frame.data) data.tmux.sendInput(data.socket, data.sessionId, frame.data);
  } catch (err) {
    logger.withError(err).warn("ws input failed");
  }
}
```

Add `import { parseClientFrame } from "@internal/session-protocol";` at the top, and update the file's header comment: `* and forwards client input to the tmux pane verbatim (send-keys -l).` stays accurate — no change needed there.

In `apps/backend/src/ws/ws.plugin.ts`, simplify the `message` handler and update its comment:

```ts
  message(ws, message) {
    // Elysia's WS middleware JSON-parses frames that start with `{`, so a
    // frame arrives as either the raw string or a parsed object.
    // parseClientFrame (inside handleSessionMessage) accepts both.
    if (typeof message === "string" || (message && typeof message === "object")) {
      handleSessionMessage(ws as unknown as WsSocket, message);
    }
  },
```

- [ ] **Step 4: Run the backend tests to verify they pass**

Run: `cd apps/backend && bun test src/ws`
Expected: PASS, 8 tests.

- [ ] **Step 5: Implement the frontend frame senders**

Create `apps/frontend/src/lib/session-frames.ts`:

```ts
import { BRACKETED_PASTE_END, BRACKETED_PASTE_START, type ClientFrame } from "@internal/session-protocol";

/** Serializes and sends a frame when the socket is open; a no-op otherwise. */
function send(ws: WebSocket | null, frame: ClientFrame): void {
  if (ws?.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(frame));
}

/**
 * Sends raw terminal bytes to the session.
 * @param ws - The session socket (may be null while reconnecting)
 * @param data - Exact bytes for the pane's process; sent unmodified
 */
export function sendInput(ws: WebSocket | null, data: string): void {
  if (!data) return;
  send(ws, { type: "input", data });
}

/**
 * Tells the session to resize its tmux window to the client geometry.
 * @param ws - The session socket (may be null while reconnecting)
 * @param cols - Terminal width in columns
 * @param rows - Terminal height in rows
 */
export function sendResize(ws: WebSocket | null, cols: number, rows: number): void {
  if (cols <= 0 || rows <= 0) return;
  send(ws, { type: "resize", cols, rows });
}

/**
 * Injects text into the session as if the user had pasted it.
 *
 * When the remote has enabled bracketed paste (DECSET 2004) the text is
 * wrapped in paste markers. This matters for injected file paths: they begin
 * with "/", which Claude Code reads as the start of a slash command when it
 * arrives as keystrokes. Wrapping also makes a multi-path insert atomic.
 *
 * @param ws - The session socket (may be null while reconnecting)
 * @param text - Text to inject
 * @param bracketed - Whether the remote has bracketed paste enabled
 *   (read from `term.modes.bracketedPasteMode`)
 */
export function injectText(ws: WebSocket | null, text: string, bracketed: boolean): void {
  if (!text) return;
  sendInput(ws, bracketed ? `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}` : text);
}
```

- [ ] **Step 6: Switch `use-session-ws.ts` to frames**

In `apps/frontend/src/lib/use-session-ws.ts`:

1. Add `import type { ServerFrame } from "@internal/session-protocol";` and `import { sendResize } from "@/lib/session-frames.js";` and `import { sendInput } from "@/lib/session-frames.js";` (combine into one import).
2. Replace the `sendResize` inner closure body with `sendResize(ws, term.cols, term.rows);` (rename the local helper to `syncSize` to avoid shadowing the import).
3. In `ws.onmessage`, type the parsed value as `ServerFrame` instead of the inline `{ type: string; data?: string }`.
4. Replace the `term.onData` body:

```ts
    inputDisposableRef.current = term.onData((data) => {
      sendInput(wsRef.current, data);
    });
```

5. Replace the `term.onResize` body:

```ts
    const resizeDisposable = term.onResize(({ cols, rows }) => {
      sendResize(wsRef.current, cols, rows);
    });
```

Leave `onFrame`/`onReplay` in place for now — Task 6 removes them, and removing them here would break `/copy` in the interim.

- [ ] **Step 7: Switch `sendCtlD` in the route**

In `apps/frontend/src/routes/sessions_.$id.tsx`, replace the `sendCtlD` body and update its JSDoc:

```ts
  /**
   * Sends Ctrl-D to the session. Goes out as an `input` frame like any other
   * keystroke, so the byte reaches the pane's stdin unmodified.
   */
  function sendCtlD() {
    sendInput(wsRef.current, "\x04");
  }
```

Add `import { sendInput } from "@/lib/session-frames.js";`.

- [ ] **Step 8: Verify**

```bash
bun run verify-types
bunx turbo run lint
cd apps/backend && bun test src
```

Expected: only the pre-existing failures listed in Global Constraints.

- [ ] **Step 9: Manually confirm the terminal still works end-to-end**

Start the stack (`bun run start`), open a session, and check: typing `hello` shows one line and submits once on Enter; arrow keys and Ctrl-C work; resizing the window reflows the pane; `/exit` still exits.

- [ ] **Step 10: Commit**

```bash
git add apps/backend/src/ws apps/frontend/src/lib apps/frontend/src/routes
git commit -m "feat(ws)!: all client frames are JSON

BREAKING CHANGE: plain-text WS frames are no longer treated as terminal
input. Clients must send {type:\"input\",data} / {type:\"resize\",cols,rows}.
Removes the {-prefix heuristic that silently swallowed pasted JSON."
```

---

### Task 3: `uploads.service.ts`

All the security-relevant logic lives here, DB-free and independently testable.

**Files:**
- Create: `apps/backend/src/services/uploads.service.ts`
- Test: `apps/backend/src/services/__tests__/uploads.service.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `uploadsDirFor(workspaceRealPath: string): string`
  - `safeUploadName(rawName: string, sniffedExt: string | null, now: Date): string`
  - `resolveUploadPath(workspaceRealPath: string, name: string): string` (throws `UploadError`)
  - `ensureGitExcluded(workspaceRealPath: string): void`
  - `writeUpload(args: { workspaceRealPath: string; file: File; now?: Date }): Promise<UploadResult>`
  - `class UploadError extends Error { readonly code: "invalid_name" | "escapes_workspace" }`
  - `interface UploadResult { path: string; name: string; size: number; contentType: string }`
  Task 4 calls `writeUpload`, `ensureGitExcluded` and catches `UploadError`.

- [ ] **Step 1: Add the dependencies**

```bash
cd apps/backend && bun add sanitize-filename file-type
cd ../.. && bunx syncpack fix && bun install
```

Confirm `apps/backend/package.json` shows exact versions with no `^`/`~` (expect `sanitize-filename` `1.6.4`, `file-type` `22.0.2`).

- [ ] **Step 2: Write the failing test**

`apps/backend/src/services/__tests__/uploads.service.test.ts`:

```ts
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureGitExcluded,
  resolveUploadPath,
  safeUploadName,
  UploadError,
  uploadsDirFor,
  writeUpload,
} from "../uploads.service.js";

const created: string[] = [];

/** Makes a throwaway workspace directory, cleaned up after each test. */
function tempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "mote-upload-test-"));
  created.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const NOW = new Date("2026-08-27T14:32:10Z");

describe("uploadsDirFor", () => {
  it("nests uploads under .mote in the workspace", () => {
    expect(uploadsDirFor("/ws")).toBe("/ws/.mote/uploads");
  });
});

describe("safeUploadName", () => {
  it("timestamp-prefixes a clean name", () => {
    expect(safeUploadName("screenshot.png", null, NOW)).toBe("20260827-143210-screenshot.png");
  });

  it("replaces spaces so the path never needs quoting", () => {
    expect(safeUploadName("my holiday photo.png", null, NOW)).toBe("20260827-143210-my-holiday-photo.png");
  });

  it("strips directory components", () => {
    const name = safeUploadName("../../etc/passwd", null, NOW);
    expect(name).not.toContain("/");
    expect(name).not.toContain("..");
  });

  it("strips control characters", () => {
    expect(safeUploadName("a\x00b\x1bc.txt", null, NOW)).toBe("20260827-143210-abc.txt");
  });

  it("defuses a Windows reserved name", () => {
    expect(safeUploadName("CON.txt", null, NOW)).not.toBe("20260827-143210-CON.txt");
  });

  it("falls back to 'pasted' when nothing usable survives", () => {
    expect(safeUploadName("???", "png", NOW)).toBe("20260827-143210-pasted.png");
  });

  it("prefers the sniffed extension over a lying client one", () => {
    expect(safeUploadName("totally-an-image.png", "pdf", NOW)).toBe("20260827-143210-totally-an-image.pdf");
  });

  it("keeps the name under the 255-byte filesystem limit", () => {
    expect(safeUploadName(`${"a".repeat(400)}.png`, null, NOW).length).toBeLessThanOrEqual(255);
  });
});

describe("resolveUploadPath", () => {
  it("resolves inside the workspace uploads dir", () => {
    expect(resolveUploadPath("/ws", "a.png")).toBe("/ws/.mote/uploads/a.png");
  });

  it("rejects a name that would escape the workspace", () => {
    expect(() => resolveUploadPath("/ws", "../../../etc/passwd")).toThrow(UploadError);
  });

  it("rejects an absolute name", () => {
    expect(() => resolveUploadPath("/ws", "/etc/passwd")).toThrow(UploadError);
  });
});

describe("ensureGitExcluded", () => {
  it("does nothing when the workspace is not a git repo", () => {
    const ws = tempWorkspace();
    ensureGitExcluded(ws);
    expect(existsSync(join(ws, ".git"))).toBe(false);
  });

  it("appends .mote/ to .git/info/exclude", () => {
    const ws = tempWorkspace();
    mkdirSync(join(ws, ".git", "info"), { recursive: true });
    writeFileSync(join(ws, ".git", "info", "exclude"), "# existing\n");
    ensureGitExcluded(ws);
    expect(readFileSync(join(ws, ".git", "info", "exclude"), "utf8")).toContain(".mote/");
  });

  it("creates info/exclude when absent", () => {
    const ws = tempWorkspace();
    mkdirSync(join(ws, ".git"), { recursive: true });
    ensureGitExcluded(ws);
    expect(readFileSync(join(ws, ".git", "info", "exclude"), "utf8")).toContain(".mote/");
  });

  it("is idempotent", () => {
    const ws = tempWorkspace();
    mkdirSync(join(ws, ".git", "info"), { recursive: true });
    ensureGitExcluded(ws);
    ensureGitExcluded(ws);
    const body = readFileSync(join(ws, ".git", "info", "exclude"), "utf8");
    expect(body.match(/\.mote\//g)).toHaveLength(1);
  });
});

describe("writeUpload", () => {
  it("writes the file into the workspace and reports its path", async () => {
    const ws = tempWorkspace();
    const file = new File(["hello upload"], "notes.txt", { type: "text/plain" });
    const result = await writeUpload({ workspaceRealPath: ws, file, now: NOW });
    expect(result.path).toBe(join(ws, ".mote/uploads/20260827-143210-notes.txt"));
    expect(result.name).toBe("20260827-143210-notes.txt");
    expect(result.size).toBe(file.size);
    expect(readFileSync(result.path, "utf8")).toBe("hello upload");
  });

  it("names a PNG from its magic bytes when the client sends no usable name", async () => {
    const ws = tempWorkspace();
    // 8-byte PNG signature followed by a stub IHDR chunk header.
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
    const file = new File([png], "", { type: "application/octet-stream" });
    const result = await writeUpload({ workspaceRealPath: ws, file, now: NOW });
    expect(result.name).toBe("20260827-143210-pasted.png");
  });

  it("suffixes on collision instead of overwriting", async () => {
    const ws = tempWorkspace();
    const first = await writeUpload({
      workspaceRealPath: ws,
      file: new File(["one"], "dup.txt", { type: "text/plain" }),
      now: NOW,
    });
    const second = await writeUpload({
      workspaceRealPath: ws,
      file: new File(["two"], "dup.txt", { type: "text/plain" }),
      now: NOW,
    });
    expect(second.path).not.toBe(first.path);
    expect(second.name).toBe("20260827-143210-dup-2.txt");
    expect(readFileSync(first.path, "utf8")).toBe("one");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd apps/backend && bun test src/services/__tests__/uploads.service.test.ts`
Expected: FAIL — `Cannot find module '../uploads.service.js'`.

- [ ] **Step 4: Implement `uploads.service.ts`**

```ts
import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, resolve, sep } from "node:path";
import { fileTypeFromBuffer } from "file-type";
import sanitize from "sanitize-filename";

/** Directory (relative to a workspace) that holds Mote's per-workspace state. */
const MOTE_DIR = ".mote";

/** The single line appended to .git/info/exclude. */
const GIT_EXCLUDE_LINE = `${MOTE_DIR}/`;

/** Filesystem limit for a single path component. */
const MAX_NAME_BYTES = 255;

/** Result of a successful upload. */
export interface UploadResult {
  /** Absolute path the harness can read the file at */
  path: string;
  /** Final on-disk filename (sanitized, timestamp-prefixed) */
  name: string;
  /** Size in bytes */
  size: number;
  /** MIME type, sniffed from content when possible, else the client's */
  contentType: string;
}

/** An upload that cannot be stored safely. */
export class UploadError extends Error {
  readonly code: "invalid_name" | "escapes_workspace";
  constructor(code: UploadError["code"], message: string) {
    super(message);
    this.name = "UploadError";
    this.code = code;
  }
}

/**
 * The uploads directory for a workspace.
 *
 * Uploads are keyed by workspace, not by session: `restart` mints a new
 * session id for the same workspace, and a transcript may be reopened much
 * later, so a session-scoped directory would break every path in it.
 *
 * @param workspaceRealPath - Resolved absolute workspace directory
 * @returns Absolute path of the uploads directory
 */
export function uploadsDirFor(workspaceRealPath: string): string {
  return join(workspaceRealPath, MOTE_DIR, "uploads");
}

/**
 * Derives a safe, collision-resistant filename.
 *
 * Beyond stripping traversal and control characters, this guarantees the
 * result contains no whitespace — the path is injected into an agent prompt
 * (not a shell), where quoting would be wrong, so a space-free name is what
 * makes a space-joined list of paths unambiguous.
 *
 * @param rawName - Client-supplied filename (may be empty or hostile)
 * @param sniffedExt - Extension detected from the file's magic bytes, if any
 * @param now - Timestamp source for the prefix
 * @returns A filename of the form `YYYYMMDD-HHmmss-name.ext`
 */
export function safeUploadName(rawName: string, sniffedExt: string | null, now: Date): string {
  // basename first so a traversal attempt cannot survive as a path.
  let name = sanitize(basename(rawName ?? "")).trim();
  // Collapse whitespace, then drop anything outside the safe charset.
  name = name.replace(/\s+/g, "-").replace(/[^A-Za-z0-9._-]/g, "");
  // Leading dots would make the upload a hidden file (or "..").
  name = name.replace(/^\.+/, "");

  let stem = name ? name.slice(0, name.length - extname(name).length) : "";
  let ext = extname(name).replace(/^\./, "");
  if (sniffedExt) ext = sniffedExt;
  if (!stem) stem = "pasted";

  const prefix = timestampPrefix(now);
  const suffix = ext ? `.${ext}` : "";
  // Trim the stem (never the prefix or extension) to fit the name limit.
  const budget = MAX_NAME_BYTES - prefix.length - suffix.length;
  if (stem.length > budget) stem = stem.slice(0, Math.max(1, budget));
  return `${prefix}${stem}${suffix}`;
}

/**
 * Resolves a sanitized filename inside a workspace's uploads directory.
 *
 * Re-verifies containment after resolution: defense in depth behind
 * {@link safeUploadName}, so a sanitization gap can never write outside the
 * workspace.
 *
 * @param workspaceRealPath - Resolved absolute workspace directory
 * @param name - Already-sanitized filename
 * @returns Absolute path inside the uploads directory
 * @throws UploadError when the resolved path escapes the workspace
 */
export function resolveUploadPath(workspaceRealPath: string, name: string): string {
  if (!name || isAbsolute(name)) {
    throw new UploadError("escapes_workspace", "Upload name must be a bare filename");
  }
  const dir = uploadsDirFor(workspaceRealPath);
  const full = resolve(dir, name);
  if (full !== join(dir, basename(full)) || !full.startsWith(dir + sep)) {
    throw new UploadError("escapes_workspace", "Upload path escapes the workspace");
  }
  return full;
}

/**
 * Appends `.mote/` to the workspace's `.git/info/exclude` when missing.
 *
 * `info/exclude` rather than `.gitignore`: it is per-clone and untracked, so
 * Mote never modifies a file the user commits. Best-effort — an unwritable
 * git dir must not fail an upload.
 *
 * @param workspaceRealPath - Resolved absolute workspace directory
 */
export function ensureGitExcluded(workspaceRealPath: string): void {
  try {
    const gitDir = join(workspaceRealPath, ".git");
    if (!existsSync(gitDir)) return;
    const infoDir = join(gitDir, "info");
    if (!existsSync(infoDir)) mkdirSync(infoDir, { recursive: true });
    const excludeFile = join(infoDir, "exclude");
    const current = existsSync(excludeFile) ? readFileSync(excludeFile, "utf8") : "";
    if (current.split(/\r?\n/).some((line) => line.trim() === GIT_EXCLUDE_LINE)) return;
    const prefix = current.length === 0 || current.endsWith("\n") ? "" : "\n";
    appendFileSync(excludeFile, `${prefix}${GIT_EXCLUDE_LINE}\n`);
  } catch {
    // Never block an upload on git bookkeeping.
  }
}

/**
 * Stores an uploaded file in the workspace and returns its absolute path.
 *
 * @param args.workspaceRealPath - Resolved absolute workspace directory
 * @param args.file - The uploaded file
 * @param args.now - Timestamp source for the filename prefix (defaults to now)
 * @returns Path, final name, size and content type of the stored file
 * @throws UploadError when no safe path can be derived
 */
export async function writeUpload({
  workspaceRealPath,
  file,
  now = new Date(),
}: {
  workspaceRealPath: string;
  file: File;
  now?: Date;
}): Promise<UploadResult> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const sniffed = await fileTypeFromBuffer(bytes);
  const name = safeUploadName(file.name, sniffed?.ext ?? null, now);
  const dir = uploadsDirFor(workspaceRealPath);
  mkdirSync(dir, { recursive: true });
  const { path, finalName } = uniquePath(workspaceRealPath, name);
  await Bun.write(path, bytes);
  ensureGitExcluded(workspaceRealPath);
  return {
    path,
    name: finalName,
    size: bytes.byteLength,
    contentType: sniffed?.mime ?? file.type ?? "application/octet-stream",
  };
}

/** `YYYYMMDD-HHmmss-` in UTC. */
function timestampPrefix(now: Date): string {
  const iso = now.toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}-`;
}

/** Finds a free path, suffixing `-2`, `-3`, … before the extension. */
function uniquePath(workspaceRealPath: string, name: string): { path: string; finalName: string } {
  let candidate = name;
  let n = 1;
  for (;;) {
    const path = resolveUploadPath(workspaceRealPath, candidate);
    if (!existsSync(path)) return { path, finalName: candidate };
    n += 1;
    const ext = extname(name);
    candidate = `${name.slice(0, name.length - ext.length)}-${n}${ext}`;
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/backend && bun test src/services/__tests__/uploads.service.test.ts`
Expected: PASS, 19 tests. If the `CON.txt` case fails, `sanitize-filename` renames reserved names — assert on what it actually produces rather than weakening the test.

- [ ] **Step 6: Verify and commit**

```bash
bun run verify-types && bunx turbo run lint
git add apps/backend/src/services apps/backend/package.json bun.lock
git commit -m "feat(uploads): add workspace upload storage service"
```

---

### Task 4: `POST /api/sessions/:id/uploads`

**Files:**
- Create: `apps/backend/src/api/uploads.route.ts`
- Create: `apps/backend/src/api/__tests__/helpers/auth-tables.ts`
- Test: `apps/backend/src/api/__tests__/uploads-route.test.ts`
- Modify: `apps/backend/src/api/routes.ts`

**Interfaces:**
- Consumes: `writeUpload`, `UploadError` (Task 3); `authGuard` from `@/api/auth-guard.js`; `SessionsRepository` from `@/db/repositories/sessions.repository.js`; `validateWorkspacePath` from `@/services/session-manager.service.js`.
- Produces: `uploadsRoutes` (Elysia instance) registered in `routes.ts`; the endpoint `POST /api/sessions/:id/uploads` returning `{ path, name, size, contentType }`; `operationId: "uploadSessionFile"` which becomes `uploadSessionFile` in `@internal/backend-client`. Task 5 calls it over plain `fetch`, not the SDK.

**Note on the test helper:** `setupAuthTables` / `signIn` / `authedRequest` are currently copy-pasted in `rate-limit-route.test.ts`, `users-admin.test.ts` and `workspaces-admin.test.ts`. Extract them into the new helper and use it here **only**. Do not migrate the three existing files in this task: two of them contain currently-red tests, and mixing a refactor into that signal makes failures ambiguous. Migrating them is a clean follow-up.

- [ ] **Step 1: Extract the shared test helper**

Create `apps/backend/src/api/__tests__/helpers/auth-tables.ts`. Copy `AUTH_TABLES`, `setupAuthTables`, `signIn`, `authedRequest` and `deleteUserByEmailOrId` **verbatim** from `apps/backend/src/api/__tests__/workspaces-admin.test.ts` (lines ~19-165), with these changes:

- Drop `WORKSPACE_TABLES` / `ALL_TABLES`; iterate `AUTH_TABLES` only.
- Add a `sessions` branch to the table-creation `if` chain. Read the real column list from `apps/backend/src/db/migrations/` (the sessions migration) and mirror it exactly — do not invent columns.
- `export` each of: `type Cleanup`, `setupAuthTables`, `signIn`, `authedRequest`, `deleteUserByEmailOrId`.
- Add a file-level JSDoc explaining it exists so route tests do not each re-declare the auth schema.

- [ ] **Step 2: Write the failing route test**

`apps/backend/src/api/__tests__/uploads-route.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashPassword } from "better-auth/crypto";
import { uploadsRoutes } from "@/api/uploads.route.js";
import { db } from "@/db/index.js";
import { SessionsRepository } from "@/db/repositories/sessions.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import {
  authedRequest,
  type Cleanup,
  deleteUserByEmailOrId,
  setupAuthTables,
  signIn,
} from "./helpers/auth-tables.js";

/**
 * Route-level tests for session file uploads. The heavy sanitization and
 * containment logic is covered in uploads.service.test.ts; these assert the
 * HTTP contract: ownership, workspace state, and the success shape.
 */

const password = "upload-route-pass-1";
const workspaces: string[] = [];

/** Creates a throwaway workspace directory for a session row to point at. */
function tempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "mote-upload-route-"));
  workspaces.push(dir);
  return dir;
}

/** Builds a multipart request carrying one file. */
function uploadRequest(sessionId: string, token: string, file: File): Request {
  const body = new FormData();
  body.set("file", file);
  return authedRequest(`/api/sessions/${sessionId}/uploads`, token, { method: "POST", body });
}

describe("session uploads route", () => {
  let cleanup: Cleanup | null = null;
  let ownerId: string;
  let otherId: string;
  let ownerEmail: string;
  let otherEmail: string;
  let ownerToken: string;
  let otherToken: string;

  beforeAll(async () => {
    cleanup = await setupAuthTables();
    const users = new UsersRepository(db);
    ownerEmail = `upowner-${crypto.randomUUID()}@mote.local`;
    otherEmail = `upother-${crypto.randomUUID()}@mote.local`;
    ownerId = await users.createUser({ email: ownerEmail, passwordHash: await hashPassword(password), role: "user" });
    otherId = await users.createUser({ email: otherEmail, passwordHash: await hashPassword(password), role: "user" });
    ownerToken = await signIn(ownerEmail, password);
    otherToken = await signIn(otherEmail, password);
  });

  afterAll(async () => {
    await db.deleteFrom("userMeta").where("userId", "=", ownerId).execute();
    await db.deleteFrom("userMeta").where("userId", "=", otherId).execute();
    await deleteUserByEmailOrId(ownerEmail);
    await deleteUserByEmailOrId(otherEmail);
    for (const dir of workspaces.splice(0)) rmSync(dir, { recursive: true, force: true });
    await cleanup?.();
  });

  /** Inserts a session row owned by `userId` pointing at a real directory. */
  async function makeSession(userId: string, workspacePath: string): Promise<string> {
    const id = crypto.randomUUID();
    await new SessionsRepository(db).create({
      id,
      userId,
      name: "upload-test",
      workspacePath,
      harnessId: "claude-code",
      profileId: null,
      status: "running",
      tmuxSocket: `mote-upload-${id.slice(0, 8)}`,
    });
    return id;
  }

  it("anonymous -> 401", async () => {
    const id = await makeSession(ownerId, tempWorkspace());
    const body = new FormData();
    body.set("file", new File(["x"], "a.txt", { type: "text/plain" }));
    const res = await uploadsRoutes.fetch(
      new Request(`http://localhost:3080/api/sessions/${id}/uploads`, { method: "POST", body }),
    );
    expect(res.status).toBe(401);
  });

  it("stores the file in the workspace and returns its path", async () => {
    const ws = tempWorkspace();
    const id = await makeSession(ownerId, ws);
    const res = await uploadsRoutes.fetch(
      uploadRequest(id, ownerToken, new File(["hello"], "notes.txt", { type: "text/plain" })),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { path: string; name: string; size: number; contentType: string };
    expect(json.path.startsWith(join(ws, ".mote/uploads/"))).toBe(true);
    expect(json.name).toMatch(/^\d{8}-\d{6}-notes\.txt$/);
    expect(json.size).toBe(5);
    expect(readFileSync(json.path, "utf8")).toBe("hello");
  });

  it("git-excludes .mote so the workspace stays clean", async () => {
    const ws = tempWorkspace();
    const id = await makeSession(ownerId, ws);
    await Bun.$`git init -q`.cwd(ws).quiet();
    await uploadsRoutes.fetch(uploadRequest(id, ownerToken, new File(["x"], "a.txt", { type: "text/plain" })));
    const status = await Bun.$`git status --porcelain`.cwd(ws).text();
    expect(status.trim()).toBe("");
  });

  it("unknown session -> 404", async () => {
    const res = await uploadsRoutes.fetch(
      uploadRequest(crypto.randomUUID(), ownerToken, new File(["x"], "a.txt", { type: "text/plain" })),
    );
    expect(res.status).toBe(404);
  });

  it("another user's session -> 404 (does not leak existence)", async () => {
    const id = await makeSession(ownerId, tempWorkspace());
    const res = await uploadsRoutes.fetch(
      uploadRequest(id, otherToken, new File(["x"], "a.txt", { type: "text/plain" })),
    );
    expect(res.status).toBe(404);
  });

  it("missing workspace -> 409", async () => {
    const ws = tempWorkspace();
    const id = await makeSession(ownerId, ws);
    rmSync(ws, { recursive: true, force: true });
    const res = await uploadsRoutes.fetch(
      uploadRequest(id, ownerToken, new File(["x"], "a.txt", { type: "text/plain" })),
    );
    expect(res.status).toBe(409);
  });

  it("read-only workspace -> 409", async () => {
    const ws = tempWorkspace();
    const id = await makeSession(ownerId, ws);
    chmodSync(ws, 0o500);
    try {
      const res = await uploadsRoutes.fetch(
        uploadRequest(id, ownerToken, new File(["x"], "a.txt", { type: "text/plain" })),
      );
      expect(res.status).toBe(409);
      expect(existsSync(join(ws, ".mote"))).toBe(false);
    } finally {
      chmodSync(ws, 0o700);
    }
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd apps/backend && bun test src/api/__tests__/uploads-route.test.ts`
Expected: FAIL — `Cannot find module '@/api/uploads.route.js'`.

- [ ] **Step 4: Implement the route**

`apps/backend/src/api/uploads.route.ts`:

```ts
import { accessSync, constants, statSync } from "node:fs";
import { Elysia, t } from "elysia";
import { authGuard } from "@/api/auth-guard.js";
import { db } from "@/db/index.js";
import { SessionsRepository } from "@/db/repositories/sessions.repository.js";
import { UploadError, writeUpload } from "@/services/uploads.service.js";

/** Largest upload accepted, as an Elysia size string. */
const MAX_UPLOAD_SIZE = "25m";

/** Multipart body: exactly one file per request. */
const UploadBodySchema = t.Object({
  file: t.File({
    maxSize: MAX_UPLOAD_SIZE,
    description: "File to store in the session's workspace (max 25MB)",
  }),
});

/** Path parameters for the upload endpoint. */
const UploadParamsSchema = t.Object({
  id: t.String({ description: "Session id to upload into" }),
});

/** Shape returned after a file is stored. */
const UploadResponseSchema = t.Object({
  path: t.String({ description: "Absolute path the harness can read the file at" }),
  name: t.String({ description: "Final on-disk filename (sanitized, timestamp-prefixed)" }),
  size: t.Number({ description: "Stored size in bytes" }),
  contentType: t.String({ description: "MIME type, sniffed from content when possible" }),
});

/**
 * Session file uploads.
 *
 * Files land in `<workspace>/.mote/uploads/` — inside the harness's cwd, so
 * an agent can read them without a permission prompt, and on a read-write
 * host mount under Docker so they are visible from the host too. The client
 * then injects the returned path into the terminal.
 */
export const uploadsRoutes = new Elysia({ prefix: "/api/sessions" }).use(authGuard).post(
  "/:id/uploads",
  async ({ params, body, user, status }) => {
    const row = await new SessionsRepository(db).findById(params.id);
    // A session that is not the caller's is reported as missing rather than
    // forbidden, so the endpoint never confirms another user's session id.
    if (!row || row.userId !== user.id) {
      return status(404, { message: "Session not found" });
    }

    const workspacePath = row.workspacePath;
    try {
      if (!statSync(workspacePath).isDirectory()) {
        return status(409, { message: "Session workspace is not a directory" });
      }
      accessSync(workspacePath, constants.W_OK);
    } catch {
      return status(409, { message: "Session workspace is missing or not writable" });
    }

    try {
      return await writeUpload({ workspaceRealPath: workspacePath, file: body.file });
    } catch (err) {
      if (err instanceof UploadError) {
        return status(400, { message: err.message });
      }
      throw err;
    }
  },
  {
    params: UploadParamsSchema,
    body: UploadBodySchema,
    response: {
      200: UploadResponseSchema,
      400: t.Object({ message: t.String({ description: "Why the file could not be stored" }) }),
      404: t.Object({ message: t.String({ description: "Session not found" }) }),
      409: t.Object({ message: t.String({ description: "Workspace is unusable" }) }),
    },
    detail: {
      operationId: "uploadSessionFile",
      tags: ["sessions"],
      description: "Stores a file in the session's workspace and returns its absolute path",
    },
  },
);
```

Register it in `apps/backend/src/api/routes.ts` next to the existing session routes, following the `.use(...)` pattern already there.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/backend && bun test src/api/__tests__/uploads-route.test.ts`
Expected: PASS, 7 tests. If `SessionsRepository.create` rejects the field list, read `apps/backend/src/db/types/sessions.db-types.ts` and pass exactly the required columns.

- [ ] **Step 6: Regenerate the client and verify**

```bash
cd /Users/theo/projects/mote
bunx turbo build
bun run verify-types
bunx turbo run lint
cd apps/backend && bun test src
```

Expected: `@internal/backend-client` regenerates with `uploadSessionFile`; only the pre-existing failures remain.

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/api packages/backend-client
git commit -m "feat(uploads): add POST /api/sessions/:id/uploads"
```

---

### Task 5: Drop and paste in the terminal

**Files:**
- Create: `apps/frontend/src/lib/session-uploads.ts`
- Test: `apps/frontend/src/lib/__tests__/session-uploads.test.ts`
- Create: `apps/frontend/src/hooks/use-terminal-uploads.ts`
- Create: `apps/frontend/src/components/terminal-drop-overlay.tsx`
- Modify: `apps/frontend/src/routes/sessions_.$id.tsx`

**Interfaces:**
- Consumes: `injectText` (Task 2); `POST /api/sessions/:id/uploads` (Task 4).
- Produces:
  - `uploadSessionFile(sessionId: string, file: File): Promise<string>` — resolves to the stored absolute path
  - `insertionTextFor(paths: string[]): string`
  - `rejectionMessage(rejections: readonly { file: { name: string }; errors: readonly { message: string }[] }[]): string`
  - `useTerminalUploads({ sessionId, wsRef, termRef })` → `{ getRootProps, isDragActive, pending, error, dismissError }`
  - `<TerminalDropOverlay isDragActive pending error onDismiss />`

- [ ] **Step 1: Add react-dropzone**

```bash
cd apps/frontend && bun add react-dropzone
cd ../.. && bunx syncpack fix && bun install
```

Confirm `react-dropzone` is pinned to `20.1.1` with no `^`.

- [ ] **Step 2: Write the failing test for the pure helpers**

`apps/frontend/src/lib/__tests__/session-uploads.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { insertionTextFor, rejectionMessage } from "../session-uploads.js";

describe("insertionTextFor", () => {
  it("returns a single path with a trailing space", () => {
    expect(insertionTextFor(["/ws/.mote/uploads/a.png"])).toBe("/ws/.mote/uploads/a.png ");
  });

  it("space-joins several paths (sanitized names never contain spaces)", () => {
    expect(insertionTextFor(["/ws/a.png", "/ws/b.pdf"])).toBe("/ws/a.png /ws/b.pdf ");
  });

  it("returns an empty string for no paths", () => {
    expect(insertionTextFor([])).toBe("");
  });
});

describe("rejectionMessage", () => {
  it("names the file and reason", () => {
    const msg = rejectionMessage([{ file: { name: "huge.bin" }, errors: [{ message: "File is larger than 25 MB" }] }]);
    expect(msg).toContain("huge.bin");
    expect(msg).toContain("larger than 25 MB");
  });

  it("summarizes several rejections on one line", () => {
    const msg = rejectionMessage([
      { file: { name: "a.bin" }, errors: [{ message: "too big" }] },
      { file: { name: "b.bin" }, errors: [{ message: "too big" }] },
    ]);
    expect(msg).toContain("a.bin");
    expect(msg).toContain("b.bin");
    expect(msg.split("\n")).toHaveLength(1);
  });

  it("returns an empty string when nothing was rejected", () => {
    expect(rejectionMessage([])).toBe("");
  });
});
```

Also add, in the same file, coverage for Task 2's `injectText` wrapping (it is pure and DOM-free):

```ts
import { BRACKETED_PASTE_END, BRACKETED_PASTE_START } from "@internal/session-protocol";
import { injectText } from "../session-frames.js";

/** Minimal open-socket stub that records what was sent. */
function fakeWs() {
  const sent: string[] = [];
  return { ws: { readyState: 1, send: (d: string) => sent.push(d) } as unknown as WebSocket, sent };
}

describe("injectText", () => {
  it("wraps text in paste markers when the remote enabled bracketed paste", () => {
    const { ws, sent } = fakeWs();
    injectText(ws, "/ws/a.png ", true);
    expect(JSON.parse(sent[0])).toEqual({
      type: "input",
      data: `${BRACKETED_PASTE_START}/ws/a.png ${BRACKETED_PASTE_END}`,
    });
  });

  it("sends bare text when bracketed paste is off", () => {
    const { ws, sent } = fakeWs();
    injectText(ws, "/ws/a.png ", false);
    expect(JSON.parse(sent[0])).toEqual({ type: "input", data: "/ws/a.png " });
  });

  it("sends nothing for empty text", () => {
    const { ws, sent } = fakeWs();
    injectText(ws, "", true);
    expect(sent).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd apps/frontend && bun test src/lib`
Expected: FAIL — `Cannot find module '../session-uploads.js'`.

- [ ] **Step 4: Implement `session-uploads.ts`**

```ts
/** One file rejected by the dropzone, narrowed to what the message needs. */
interface UploadRejection {
  file: { name: string };
  errors: readonly { message: string }[];
}

/**
 * Uploads one file into a session's workspace.
 *
 * @param sessionId - Session to upload into
 * @param file - The file to store
 * @returns The absolute path the harness can read the file at
 * @throws Error carrying the API's message when the upload is refused
 */
export async function uploadSessionFile(sessionId: string, file: File): Promise<string> {
  const body = new FormData();
  body.set("file", file);
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/uploads`, {
    method: "POST",
    body,
    credentials: "include",
  });
  if (!res.ok) {
    const message = await res
      .json()
      .then((j: { message?: string }) => j.message)
      .catch(() => null);
    throw new Error(message ?? `Upload failed (${res.status})`);
  }
  const json = (await res.json()) as { path: string };
  return json.path;
}

/**
 * Builds the text injected into the terminal after an upload.
 *
 * Paths are space-joined with a trailing space. No quoting is applied or
 * needed: the server sanitizes filenames so none contains whitespace, and
 * the target is an agent prompt rather than a shell.
 *
 * @param paths - Absolute paths of the stored files
 * @returns Text to inject, or "" when there is nothing to insert
 */
export function insertionTextFor(paths: string[]): string {
  if (paths.length === 0) return "";
  return `${paths.join(" ")} `;
}

/**
 * Flattens dropzone rejections into one human-readable line.
 *
 * @param rejections - Rejections reported by react-dropzone
 * @returns A single-line summary, or "" when nothing was rejected
 */
export function rejectionMessage(rejections: readonly UploadRejection[]): string {
  if (rejections.length === 0) return "";
  return rejections
    .map((r) => `${r.file.name}: ${r.errors.map((e) => e.message).join(", ")}`)
    .join("; ");
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/frontend && bun test src/lib`
Expected: PASS, 9 tests.

- [ ] **Step 6: VERIFY THE KEY ASSUMPTION before building the hook**

react-dropzone handles paste by default. Confirm a **text** paste still reaches xterm with a dropzone root mounted around the terminal.

Add a temporary `getRootProps()` wrapper around the terminal container in `sessions_.$id.tsx` using `useDropzone({ noClick: true, noKeyboard: true, onDrop: () => {} })`, run the app, open a session, and paste multi-line text.

- If the text appears in the terminal → proceed to Step 7 as written.
- If it does **not** → set `noPaste: true` on the dropzone and add this to the hook instead of relying on the built-in handler:

```ts
  // Fallback path: react-dropzone's paste handler interfered with text paste,
  // so we intercept in the capture phase and only claim the event when the
  // clipboard actually carries files, letting text fall through to xterm.
  useEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? []);
      if (files.length === 0) return;
      e.preventDefault();
      void handleFiles(files);
    };
    node.addEventListener("paste", onPaste, true);
    return () => node.removeEventListener("paste", onPaste, true);
  }, [handleFiles]);
```

Record which branch you took in the commit message.

- [ ] **Step 7: Implement `use-terminal-uploads.ts`**

```ts
import type { Terminal } from "@xterm/xterm";
import { useCallback, useState } from "react";
import { type FileRejection, useDropzone } from "react-dropzone";
import { injectText } from "@/lib/session-frames.js";
import { insertionTextFor, rejectionMessage, uploadSessionFile } from "@/lib/session-uploads.js";

/** Client-side mirror of the server's cap, so oversize files fail instantly. */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * Drag-and-drop plus clipboard-file paste for the session terminal.
 *
 * Files are uploaded into the session's workspace and their paths injected
 * into the terminal in one batch. `noClick`/`noKeyboard` are essential: the
 * dropzone wraps the terminal, and without them a click or Space/Enter in
 * the terminal would open a file dialog.
 *
 * @param args.sessionId - Session receiving the files
 * @param args.wsRef - Live session socket (used to inject the paths)
 * @param args.termRef - The attached terminal (read for bracketed-paste mode)
 */
export function useTerminalUploads({
  sessionId,
  wsRef,
  termRef,
}: {
  sessionId: string;
  wsRef: { current: WebSocket | null };
  termRef: { current: Terminal | null };
}) {
  const [pending, setPending] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const handleFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      setError(null);
      setPending((n) => n + files.length);
      try {
        const paths = await Promise.all(files.map((file) => uploadSessionFile(sessionId, file)));
        const term = termRef.current;
        // One injection for the whole batch so multi-file drops land atomically.
        injectText(wsRef.current, insertionTextFor(paths), term?.modes.bracketedPasteMode ?? false);
        term?.focus();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Upload failed");
      } finally {
        setPending((n) => Math.max(0, n - files.length));
      }
    },
    [sessionId, termRef, wsRef],
  );

  const { getRootProps, isDragActive } = useDropzone({
    noClick: true,
    noKeyboard: true,
    maxSize: MAX_UPLOAD_BYTES,
    onDrop: (accepted: File[], rejected: FileRejection[]) => {
      if (rejected.length > 0) setError(rejectionMessage(rejected));
      void handleFiles(accepted);
    },
  });

  return {
    getRootProps,
    isDragActive,
    pending,
    error,
    dismissError: useCallback(() => setError(null), []),
  };
}
```

- [ ] **Step 8: Implement `terminal-drop-overlay.tsx`**

```tsx
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Non-interactive feedback layered over the terminal: a drop target outline
 * while dragging, an upload indicator, and a dismissible error.
 *
 * Everything is `pointer-events-none` except the error's dismiss button, so
 * the overlay never swallows terminal input.
 */
export function TerminalDropOverlay({
  isDragActive,
  pending,
  error,
  onDismiss,
}: {
  /** True while files are being dragged over the terminal */
  isDragActive: boolean;
  /** Number of uploads in flight */
  pending: number;
  /** Last upload error, or null */
  error: string | null;
  /** Clears the error */
  onDismiss: () => void;
}) {
  return (
    <>
      {isDragActive && (
        <div className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-lg border-2 border-primary/60 border-dashed bg-background/70 backdrop-blur-sm">
          <p className="text-sm">Drop files to upload into the workspace</p>
        </div>
      )}
      {pending > 0 && (
        <div className="pointer-events-none absolute top-3 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full border bg-background/90 px-3 py-1 text-muted-foreground text-xs shadow backdrop-blur">
          <span className="h-2 w-2 animate-pulse rounded-full bg-primary" aria-hidden />
          Uploading {pending} file{pending === 1 ? "" : "s"}…
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="absolute bottom-3 left-1/2 z-20 flex max-w-[80%] -translate-x-1/2 items-center gap-2 rounded-md border border-destructive/40 bg-background/95 px-3 py-1.5 text-destructive text-xs shadow backdrop-blur"
        >
          <span className="truncate">{error}</span>
          <Button variant="ghost" size="icon" className="h-5 w-5" onClick={onDismiss} aria-label="Dismiss upload error">
            <X className="h-3 w-3" />
          </Button>
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 9: Wire into the route**

In `apps/frontend/src/routes/sessions_.$id.tsx`:

1. Import `useTerminalUploads` and `TerminalDropOverlay`.
2. After the `useSessionWs` call (so `wsRef` exists), add:

```ts
  const uploads = useTerminalUploads({ sessionId: id, wsRef, termRef });
```

3. Nest the dropzone root **outside** the xterm container — react-dropzone's `getRootProps()` supplies its own `ref`, and xterm needs `containerRef`, so they must be separate elements:

```tsx
      <div className="relative flex-1 overflow-hidden bg-[#0f1216] p-0">
        {!exited && !closed && (
          <div {...uploads.getRootProps({ className: "h-full w-full" })}>
            <div ref={containerRef} className="h-full w-full" />
            <TerminalDropOverlay
              isDragActive={uploads.isDragActive}
              pending={uploads.pending}
              error={uploads.error}
              onDismiss={uploads.dismissError}
            />
          </div>
        )}
```

Leave the rest of the panel (`showPill`, `exited`, `closed`) untouched.

- [ ] **Step 10: Verify**

```bash
bun run verify-types && bunx turbo run lint && cd apps/frontend && bun test src
```

- [ ] **Step 11: Manually verify the feature**

With the stack running and a session open:
1. Drag a PNG onto the terminal → outline appears, then the path is inserted.
2. **The inserted path must not open Claude Code's slash-command palette.** If it does, `term.modes.bracketedPasteMode` was false — check the harness enabled DECSET 2004 before treating this as a bug in `injectText`.
3. Copy a screenshot to the clipboard, focus the terminal, ⌘V → `…-pasted.png` path inserted, and the agent can read the image.
4. Drop two files at once → one line with both paths.
5. Paste multi-line text → still lands as text, unchanged.
6. `git status` in the workspace stays clean.

- [ ] **Step 12: Commit**

```bash
git add apps/frontend/src apps/frontend/package.json bun.lock
git commit -m "feat(terminal): upload dropped and pasted files, inject their paths"
```

---

### Task 6: Replace the hand-rolled transcript and search with xterm addons

Serialize and search land together: removing `transcriptRef` removes the only data source the current search reads, so splitting them would ship a broken find.

**Files:**
- Modify: `apps/frontend/src/routes/sessions_.$id.tsx`
- Modify: `apps/frontend/src/lib/use-session-ws.ts`
- Rewrite: `apps/frontend/src/components/transcript-search.tsx`

**Interfaces:**
- Consumes: `sendInput` (Task 2).
- Produces: `TranscriptSearch` now takes `{ search: SearchAddon | null; defaultOpen?: boolean; defaultQuery?: string; onClose: () => void }` instead of `onFind`. The route no longer exposes `scrollToMatch`.

- [ ] **Step 1: Add the addons**

```bash
cd apps/frontend && bun add @xterm/addon-serialize @xterm/addon-search
cd ../.. && bunx syncpack fix && bun install
```

Confirm pinned `0.14.0` and `0.16.0`. Then `bun run verify-types` to prove both addons typecheck against `@xterm/xterm@6.0.0` **before** wiring them — neither declares peer deps, so this is the compatibility check.

- [ ] **Step 2: Load the addons and drop the accumulator**

In `sessions_.$id.tsx`:

1. Import `SerializeAddon` from `@xterm/addon-serialize` and `SearchAddon` from `@xterm/addon-search`.
2. Add refs beside `termRef`:

```ts
  const serializeRef = useRef<SerializeAddon | null>(null);
  const [search, setSearch] = useState<SearchAddon | null>(null);
```

3. In the mount effect, after `term.loadAddon(fit)`:

```ts
    const serialize = new SerializeAddon();
    term.loadAddon(serialize);
    serializeRef.current = serialize;
    const searchAddon = new SearchAddon();
    term.loadAddon(searchAddon);
    setSearch(searchAddon);
```

and null both out in the effect's cleanup alongside `termRef.current = null`.

4. Delete `transcriptRef`, the `const [, setTranscriptTick] = useState(0);` line, and `scrollToMatch` entirely.
5. In the `useSessionWs` options object, delete the `onReplay` and `onFrame` properties.
6. Point `/copy` at the buffer instead of the accumulator — in the `ctx` passed to `runCommand`:

```ts
      transcript: serializeRef.current?.serialize() ?? "",
```

7. Replace the `<TranscriptSearch .../>` props: drop `onFind`, pass `search={search}`.
8. Remove the now-unused `stripAnsi` import if nothing else in the file uses it.

- [ ] **Step 3: Remove the dead handler plumbing from the hook**

In `apps/frontend/src/lib/use-session-ws.ts`, delete the `onFrame` and `onReplay` fields from `TermWsHandlers` (and their JSDoc), and delete the two `handlersRef.current.onReplay?.()` / `handlersRef.current.onFrame?.(frame)` call sites in `ws.onmessage`. Keep `term.reset()` on the first replay — that is what stops the previous connection's screen persisting, and it is unrelated to the transcript copy.

- [ ] **Step 4: Rewrite `transcript-search.tsx`**

Replace `TranscriptSearchBar` with a `SearchAddon`-driven version. Keep the outer `TranscriptSearch` toggle component's structure; only its props and the bar change.

```tsx
import type { SearchAddon } from "@xterm/addon-search";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Search options for every call. `decorations` is not optional in practice:
 * SearchAddon only emits `onDidChangeResults` when decorations are enabled,
 * so the match counter goes silent without it. `matchOverviewRuler` and
 * `activeMatchColorOverviewRuler` are required fields of the decoration type.
 */
const SEARCH_OPTIONS = {
  decorations: {
    matchBackground: "#3b3b40",
    matchOverviewRuler: "#8b8b90",
    activeMatchBackground: "#5b5b64",
    activeMatchColorOverviewRuler: "#e4e4e7",
  },
} as const;

/**
 * Find-in-terminal, backed by SearchAddon: matches are highlighted in the
 * terminal itself and the counter comes from the addon's own result event.
 */
function TranscriptSearchBar({
  search,
  onClose,
  defaultQuery = "",
}: {
  /** The terminal's search addon (null until the terminal has mounted) */
  search: SearchAddon | null;
  onClose: () => void;
  /** Seeds the input, e.g. after "/find error" */
  defaultQuery?: string;
}) {
  const [q, setQ] = useState(defaultQuery);
  const [results, setResults] = useState({ resultIndex: -1, resultCount: 0 });

  useEffect(() => {
    if (!search) return;
    const disposable = search.onDidChangeResults(setResults);
    return () => disposable.dispose();
  }, [search]);

  // Clear highlights when the bar unmounts so they don't outlive the search.
  useEffect(() => () => search?.clearDecorations(), [search]);

  const find = useCallback(
    (term: string, direction: "next" | "prev") => {
      if (!search) return;
      if (!term) {
        search.clearDecorations();
        setResults({ resultIndex: -1, resultCount: 0 });
        return;
      }
      if (direction === "next") search.findNext(term, SEARCH_OPTIONS);
      else search.findPrevious(term, SEARCH_OPTIONS);
    },
    [search],
  );

  // Search the seeded query once on open.
  useEffect(() => {
    if (defaultQuery.trim()) find(defaultQuery.trim(), "next");
  }, [defaultQuery, find]);

  const total = results.resultCount;
  // resultIndex is -1 when the addon's highlight threshold is exceeded; show
  // the count alone rather than a misleading "0/N".
  const label = total === 0 ? "no matches" : results.resultIndex < 0 ? `${total} matches` : `${results.resultIndex + 1}/${total}`;

  return (
    <fieldset
      aria-label="Find in terminal"
      className="flex items-center gap-1.5 rounded-md border border-input bg-background p-1"
    >
      <Input
        autoFocus
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          find(e.target.value.trim(), "next");
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") find(q.trim(), e.shiftKey ? "prev" : "next");
          if (e.key === "Escape") onClose();
        }}
        placeholder="Find…"
        className="h-7 w-52 text-xs"
      />
      {q.trim() && (
        <span className="min-w-16 text-center text-muted-foreground text-xs" aria-live="polite">
          {label}
        </span>
      )}
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6"
        onClick={() => find(q.trim(), "prev")}
        disabled={!total}
        aria-label="Previous match"
        title="Previous match"
      >
        <ChevronUp className="h-3 w-3" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6"
        onClick={() => find(q.trim(), "next")}
        disabled={!total}
        aria-label="Next match"
        title="Next match"
      >
        <ChevronDown className="h-3 w-3" />
      </Button>
      <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onClose} aria-label="Close search">
        <X className="h-3 w-3" />
      </Button>
    </fieldset>
  );
}
```

Update the exported `TranscriptSearch` wrapper to accept and forward `search` in place of `onFind`, and **delete both stale comments** — `"xterm v6 has no search addon"` and `"xterm v6 exposes no search highlight API"` — which are false as of `addon-search@0.16.0`.

- [ ] **Step 5: Verify**

```bash
bun run verify-types && bunx turbo run lint && bun test
```

- [ ] **Step 6: Manually verify what the old code faked**

1. Type a term present many times in the terminal → matches highlight, and the counter shows a real total (previously always `1/1`).
2. Enter / Shift+Enter step forward and back through matches (previously both jumped to the last occurrence).
3. A term that is genuinely absent shows "no matches" (previously unreachable).
4. `/copy` still copies the terminal contents.
5. Reconnect (restart the backend) → `/copy` is not doubled, and the terminal rebuilds correctly.

- [ ] **Step 7: Commit**

```bash
git add apps/frontend/src apps/frontend/package.json bun.lock
git commit -m "refactor(terminal): use xterm serialize + search addons

Replaces the hand-rolled transcript accumulator and find. Fixes two live
bugs: the match counter matched the query against itself (always 1/1, and
'no matches' unreachable), and next/prev both jumped to the last occurrence
via lastIndexOf."
```

---

### Task 7: Documentation and final verification

**Files:**
- Modify: `docs/overview.md`

- [ ] **Step 1: Update `docs/overview.md`**

In the "Key decisions" table, change the Terminal row to mention the addon set (`fit/webgl/serialize/search`) and add two rows:

| Area | Choice |
|---|---|
| WS protocol | **All client frames JSON** (`{type:"input"\|"resize"}`) — see `packages/session-protocol` |
| Uploads | Dropped/pasted files → `<workspace>/.mote/uploads/`, workspace-scoped, git-excluded, paths injected via bracketed paste |

In the "Workspace layout" block, add:

```
packages/session-protocol    WS frame contract shared by backend + frontend
```

- [ ] **Step 2: Full verification**

```bash
cd /Users/theo/projects/mote
bunx turbo build
bun run verify-types
bunx turbo run lint
bun test
```

Confirm the **only** failures are the four pre-existing ones listed in Global Constraints. If anything else is red, fix it before continuing.

- [ ] **Step 3: Commit**

```bash
git add docs/overview.md
git commit -m "docs: record the JSON WS protocol and workspace uploads"
```

---

## Self-Review

**Spec coverage** — every spec section maps to a task:

| Spec section | Task |
|---|---|
| Decision 1 (workspace-scoped, never deleted) | 3 (`uploadsDirFor`), 4 (route uses `workspacePath`) |
| Decision 2 (inside workspace, git-excluded) | 3 (`ensureGitExcluded`), 4 (git-status test) |
| Decision 3 (all-JSON frames) | 1, 2 |
| Decision 4 (bracketed paste) | 1 (constants), 2 (`injectText`), 5 (mode read + manual check) |
| Decision 5 (no quoting needed) | 3 (`safeUploadName` whitespace rule), 5 (`insertionTextFor`) |
| `react-dropzone` | 5 |
| `sanitize-filename`, `file-type` | 3 |
| `addon-serialize`, `addon-search` | 6 |
| `@internal/session-protocol` | 1 |
| Upload endpoint + error codes | 4 |
| Pre-existing search bugs | 6 |
| Testing plan | 1, 3, 4, 5 (unit) + 2, 5, 6 (manual) |
| Docs | 7 |

**Placeholder scan** — no TBD/TODO; every code step carries real code. The one deliberately conditional step is Task 5 Step 6, which is a verification branch with both outcomes written out, not a placeholder.

**Type consistency** — checked across tasks: `parseClientFrame(raw: string | object)` (T1) matches `handleSessionMessage(ws, message: string | object)` (T2); `sendInput`/`injectText` signatures in T2 match their calls in T5/T6; `writeUpload({ workspaceRealPath, file, now? })` (T3) matches the route call (T4); `UploadResult` fields match `UploadResponseSchema` and the `{ path }` the client reads (T5); `TranscriptSearch`'s `search` prop (T6) matches the route's `search` state.
