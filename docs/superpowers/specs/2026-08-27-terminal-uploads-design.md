# Terminal Paste & File Drop — Design Spec (2026-08-27)

**Deployment model:** local-first (bare-metal) + single-container Docker. A session's harness runs
under tmux in the **same filesystem namespace as the backend** (host process, or the single `mote`
container). There is therefore no host↔container path translation to do: a file the backend writes
is a file the harness can read at the same absolute path.

**Goal:** make the session terminal accept content the way a native terminal does — paste text,
paste an image from the clipboard, and drag/drop files onto it. Dropped and pasted *files* are
uploaded to a directory inside the session's workspace and their absolute paths are injected into
the terminal, which is exactly how an agent harness consumes a file reference.

**Prerequisite (already landed):** the WS input path is a byte-exact pipe
(`TmuxRunner.sendInput` via `send-keys -l --`, no appended `Enter`). Text paste already works
end-to-end as a result, including the bracketed-paste markers xterm emits. This round covers
image paste and file drop.

**Out of scope (deferred):**
- Downloads (terminal → browser). This is upload-only.
- ZMODEM / trzsz-style interactive transfer (see "Rejected" below).
- Inline image rendering in the terminal (`@xterm/addon-image`).
- Directory drops (`webkitGetAsEntry` recursion) — files only; a dropped folder is rejected with a
  clear message.
- Any UI for browsing or clearing past uploads. `.mote/uploads/` is a plain git-excluded folder.
- Frontend component tests (no vitest — see "Testing" for why and what replaces it).

---

## Core architectural decisions

### 1. Uploads are workspace-scoped and never auto-deleted

Files land in `<workspace>/.mote/uploads/`, keyed by **workspace, not session id**, and nothing
deletes them.

This is driven by resumability. `POST /api/sessions/:id/restart` mints a **new session id** for the
same workspace, and a transcript may be read back weeks later. If uploads were keyed by session id
and reaped on delete, every path in an old transcript would 404 exactly when someone resumes the
work the files were for. Keying by workspace means any session — original, restarted, or newly
created on that workspace — resolves every path any prior session produced.

Consequences accepted:
- `deleteSession` does **not** touch uploads (`sessionLogPath` unlink stays as-is).
- Disk growth is unbounded. Acceptable for a local-first tool where the folder is visible, plainly
  named, and removable with `rm -rf`.

### 2. Uploads live inside the workspace, not the data dir

`<workspace>/.mote/uploads/` rather than `<dataDir>/uploads/`:
- The path is **inside the agent's cwd**, so Claude Code reads it without a permission prompt.
  A path under `/data` is outside cwd and would prompt or be refused.
- Workspaces are RW **host mounts** under Docker, so the file also appears on the host — the user
  can open the screenshot they just pasted.
- `<dataDir>` is the `mote-data` named volume: invisible from the host.

To keep this from dirtying the repo, `.mote/` is appended to `<workspace>/.git/info/exclude`
(idempotent, only when `.git` exists). `info/exclude` rather than `.gitignore` because it is
per-clone and untracked — we never modify a file the user commits.

### 3. All client→server WS frames become JSON (breaking change, authorized)

Today a frame is terminal input unless it starts with `{`, in which case it is a control message.
That heuristic silently swallows any pasted JSON object. Since nothing is deployed, the protocol
becomes uniform instead:

```ts
type ClientFrame =
  | { type: "input"; data: string }                       // raw terminal bytes, verbatim
  | { type: "resize"; cols: number; rows: number };
```

Server→client frames (`replay`, `output`) are unchanged. Control bytes need no encoding: `\x04` and
`\x1b` are legal in JSON strings as `\u0004` / `\u001b`, so `data` carries raw bytes as-is and
Elysia's auto-parse becomes an asset rather than a hazard.

### 4. Injected paths are wrapped in bracketed paste

**Every injected path starts with `/`, and Claude Code treats a leading `/` in an empty prompt as a
slash command.** Sending a path as plain input would open the command palette instead of entering
the path.

So the injected text is wrapped in bracketed-paste markers — `ESC[200~` … `ESC[201~` — which makes
the TUI treat it as pasted content rather than keystrokes, and makes a multi-file drop land
atomically. xterm exposes the remote's own mode state as `term.modes.bracketedPasteMode`
(`@xterm/xterm@6.0.0` `typings/xterm.d.ts:1919`), so we wrap **only when the harness has actually
enabled DECSET 2004** and send the bare path otherwise. Never assume the mode.

### 5. Sanitization guarantees paths need no quoting

The agent's prompt is not a shell, so shell quoting would be wrong there. Instead, filenames are
normalized server-side so that **no filename ever contains a space**, which makes a space-joined
list of paths unambiguous with no quoting at all.

---

## Third-party libraries

Researched 2026-08-27; all actively maintained.

| Adopted | Version | Replaces | Rationale |
|---|---|---|---|
| `react-dropzone` | `20.1.1` | hand-rolled drag/drop **and** paste interception | Paste-to-upload is on by default and fires when "a focused child, e.g. a `<textarea>`" has focus — precisely xterm's hidden textarea. One library covers both entry points and supplies `accept` / `maxSize` / `validator` / `fileRejections` for client-side pre-validation mirroring the server cap. React ≥18. |
| `sanitize-filename` | `1.6.4` | a hand-written charset regex | Strips directory components, control characters, Windows reserved names (`CON`, `PRN`, …), truncates to 255 bytes. ~1440 dependents. |
| `file-type` | `22.0.2` | trusting the client `Content-Type` | Sniffs the true extension from magic bytes. Keeps `pasted-<ts>.png` honest and stops a mislabeled binary landing with an image extension. ESM, Bun-compatible. |
| `@xterm/addon-serialize` | `0.14.0` | the `transcriptRef` accumulator | Reads the terminal buffer directly. Deletes the accumulator, the `onFrame`/`onReplay` callbacks that exist only to feed it, the `setTranscriptTick` re-render churn, and its unbounded memory growth. |
| `@xterm/addon-search` | `0.16.0` | hand-rolled `scrollToMatch` + the match counter | Real highlight-all, next/prev, and result counts. Also **required** once `addon-serialize` lands, because removing `transcriptRef` removes the only thing the current search reads. |

### Rejected

- **`trzsz` / `zmodem.js`** — the established way to move files through a browser terminal, and what
  `ttyd` uses. Wrong fit twice: it needs a `trz`/`rz` binary present in the container, and it needs
  the remote side sitting at a **shell prompt** to invoke it. Our remote is Claude Code's TUI, so
  there is nowhere to type `trz`. `TrzszAddon` also substitutes for `AttachAddon`, which would
  displace our replay/reconnect/ws-token logic.
- **`filenamify`** — wraps `sanitize-filename` with transliteration/extras we do not need.
- **Any multipart middleware (`multer` etc.)** — Elysia's `t.File({ maxSize: "25m" })` parses *and*
  validates natively.
- **`@xterm/addon-image`** — inline thumbnails are decoration; the drop overlay and the injected
  path already confirm the upload.

---

## Pre-existing bugs this round fixes

Both are in code the round necessarily rewrites, and both are currently user-visible.

1. **`transcript-search.tsx:69` searches the query against itself.** `[...q.matchAll(re)]` runs the
   pattern over `q`, not over the transcript. The transcript is never searched: the counter reads
   `1/1` for essentially every query, `"no matches"` is unreachable, and `step()` cycles an index
   over a fabricated total. `addon-search`'s `onDidChangeResults` replaces the whole computation.
2. **`scrollToMatch` always jumps to the last occurrence.** It uses `transcriptRef.lastIndexOf(q)`
   and ignores the active match index, so next/prev never navigate. `findNext`/`findPrevious`
   replace it.

Two stale comments are removed with them: `"xterm v6 has no search addon"` and `"xterm v6 exposes no
search highlight API"` (both false as of `addon-search@0.16.0`).

---

## New package: `@internal/session-protocol`

`packages/session-protocol/` — the WS frame contract, shared by the two apps that speak it. Config
cloned from `packages/backend-errors` (`tsdown` build, `hash-runner` build:dev, biome lint,
`tsc --noEmit` verify-types, `exports` → `dist/index.js`).

`src/frames.ts`:
- `ClientFrame` — the union in decision 3, each member and property JSDoc'd per the interface-docs
  rule.
- `ServerFrame` — `{ type: "replay" | "output"; data?: string }`, formalizing what the backend
  already sends and the frontend already parses inline.
- `parseClientFrame(raw: string | object): ClientFrame | null` — the single validator. Returns
  `null` for malformed JSON, a non-object, a missing/unknown `type`, or a member whose fields are
  the wrong type. Accepts an already-parsed object so Elysia's auto-parse needs no re-stringify.
- `BRACKETED_PASTE_START` / `BRACKETED_PASTE_END` constants.

Registered as `"@internal/session-protocol": "workspace:*"` in both apps.

---

## Backend

### 1. `apps/backend/src/services/uploads.service.ts` (new)

Pure-ish helpers, each independently testable:

- `uploadsDirFor(workspaceRealPath: string): string` → `<workspace>/.mote/uploads`.
- `safeUploadName(rawName: string, sniffedExt: string | null, now: Date): string`
  1. `sanitize-filename` on the raw name.
  2. Collapse whitespace runs → `-`; strip any remaining char outside `[A-Za-z0-9._-]`.
  3. Empty/extension-only result → `pasted`.
  4. Prefer `sniffedExt` over the client-supplied extension when they disagree.
  5. Prefix `YYYYMMDD-HHmmss-`.
  Result: `20260827-143210-screenshot.png`, guaranteed space-free.
- `resolveUploadPath(workspaceRealPath, name)` → joins, then **re-verifies** the resolved result is
  inside `workspaceRealPath` (defense in depth behind sanitization) and throws otherwise.
- `ensureGitExcluded(workspaceRealPath)` → if `<workspace>/.git` exists and
  `.git/info/exclude` lacks a `.mote/` line, append one. Creates `info/` if absent. Best-effort:
  a failure here never fails an upload.
- `writeUpload({ workspaceRealPath, file })` → orchestrates the above, `mkdir -p`s the dir, sniffs
  via `file-type`, writes with `Bun.write`, returns `{ path, name, size, contentType }`.
  Collision: if the path exists, suffix `-2`, `-3`, … before the extension.

### 2. `apps/backend/src/api/uploads.route.ts` (new)

`POST /api/sessions/:id/uploads`, `.use(authGuard)`, one file per request (the client parallelizes
a multi-file drop so each file gets its own error).

- Body: `t.Object({ file: t.File({ maxSize: "25m" }) })` with descriptions per the Elysia-schema
  rule. No `type` restriction — any file an agent might be handed.
- Loads the session via `SessionsRepository`; **404** if missing or `row.userId !== user.id`
  (same ownership shape as the WS attach, which must not leak existence).
- **409** if the session's `workspacePath` no longer resolves, is not a directory, or is not
  writable.
- **400** if sanitization cannot produce a usable name, or the resolved path escapes the workspace.
- Response: `t.Object({ path, name, size, contentType })`, all described.
- `detail: { operationId: "uploadSessionFile", tags: ["sessions"] }` — regenerates
  `@internal/backend-client`, so `turbo build` is required.

Registered in `apps/backend/src/api/routes.ts`.

### 3. `apps/backend/src/ws/session-ws.ts` + `ws.plugin.ts`

`handleSessionMessage` takes `string | object`, runs `parseClientFrame`, and switches on `type`:
`"input"` → `tmux.sendInput(...)` (empty `data` ignored); `"resize"` → `resizeWindow` when both
dimensions are positive. `null` (unparseable) and unknown `type` are logged at `warn` and dropped.
`ws.plugin.ts` stops re-stringifying and hands the value straight through. The `{`-prefix branch and
its comment are deleted.

---

## Frontend

`sessions_.$id.tsx` is already 444 lines, so per the React-organization rule the new work lands in
hooks and components, not the route.

### 4. `apps/frontend/src/lib/session-frames.ts` (new)

Thin senders over a `WebSocket` ref, so no component hand-builds a frame:
`sendInput(ws, data)`, `sendResize(ws, cols, rows)`, and
`injectText(ws, text, bracketed: boolean)` — which applies decision 4's wrapping. All are
guarded on `readyState === OPEN`.

### 5. `apps/frontend/src/lib/session-uploads.ts` (new)

- `uploadSessionFile(sessionId, file, signal?)` → `POST` a `FormData` to the endpoint, returns the
  response's `path`. Rejects with the API's error message.
- `insertionTextFor(paths: string[]): string` — space-joined plus one trailing space. **Pure.**
- `rejectionMessage(fileRejections): string` — flattens react-dropzone rejections into one line.
  **Pure.**

### 6. `apps/frontend/src/hooks/use-terminal-uploads.ts` (new)

Wraps `useDropzone({ noClick: true, noKeyboard: true, maxSize: 25 * 1024 * 1024, onDrop, onError })`.
`noClick`/`noKeyboard` are essential: without them a click or Space/Enter in the terminal opens a
file dialog.

`onDrop` uploads all accepted files in parallel, then calls
`injectText(ws, insertionTextFor(paths), term.modes.bracketedPasteMode)` **once** for the whole
batch. Returns `{ getRootProps, isDragActive, pending, error, dismissError }`.

Paste is left to react-dropzone's built-in handler. It only acts when `clipboardData` carries
files, so a text paste must fall through to xterm untouched — **verified before building on it**
(see Testing). Fallback if it does interfere: `noPaste: true` plus a hand-rolled capture-phase
`paste` listener on the container that inspects `clipboardData.files` and calls `preventDefault()`
only when files are present.

### 7. `apps/frontend/src/components/terminal-drop-overlay.tsx` (new)

Dashed-border overlay while `isDragActive`, an "Uploading…" pill while `pending > 0`, and a
dismissible error line. `pointer-events-none` throughout so it never intercepts terminal input.

### 8. `apps/frontend/src/lib/use-session-ws.ts` (changed)

`term.onData` / `term.onResize` now send frames via `session-frames.ts`. The `onFrame` and
`onReplay` handlers and the `TermWsHandlers` fields for them are **deleted** — with
`addon-serialize` nothing consumes them. Server frames are typed as `ServerFrame`. Reconnect,
`term.reset()`-on-first-replay, and the stale-socket guard are untouched.

### 9. `apps/frontend/src/routes/sessions_.$id.tsx` (changed)

- Loads `SerializeAddon` and `SearchAddon` alongside fit/webgl.
- Deletes `transcriptRef`, `setTranscriptTick`, `scrollToMatch`, and the `onFrame`/`onReplay` wiring.
- `/copy` uses `serialize.serialize()`; `/exit` uses `sendInput(ws, "\x04")` instead of a raw
  `ws.send`.
- Wires `getRootProps()` onto the terminal container and renders the overlay.

### 10. `apps/frontend/src/components/transcript-search.tsx` (rewritten)

Driven by `SearchAddon`: query changes call `findNext(term, opts)`, the arrows call
`findNext`/`findPrevious`, and the counter subscribes to `onDidChangeResults`.

Two API details that must not be missed:
- `onDidChangeResults` **only fires when `decorations` is supplied**, so search options always
  include a `decorations` object — the counter silently dies otherwise.
- `matchOverviewRuler` and `activeMatchColorOverviewRuler` are **required** (non-optional) fields of
  `ISearchDecorationOptions`.
- `resultIndex` is `-1` when the highlight threshold is exceeded; render that as a count with no
  index rather than `0/N`.

Colors come from the existing terminal theme block in the route.

---

## Testing

Per `testing.md`, tests live in `__tests__/` beside the code.

### Backend (carries the real coverage)

`services/tmux/__tests__/` and `ws/__tests__/session-ws.test.ts` already cover the byte-exact input
pipe from the prerequisite work; the WS tests are updated to the JSON frame shape and keep the
regression case that a **JSON object pasted as terminal input arrives verbatim**.

- `packages/session-protocol/src/__tests__/frames.test.ts` — `parseClientFrame` over: both valid
  members, an already-parsed object, malformed JSON, a JSON array, unknown `type`, wrong field
  types, and a missing `data`.
- `services/__tests__/uploads.service.test.ts` — `safeUploadName` (spaces → `-`, control chars,
  `CON.txt`, a 300-char name, extension-only, `pasted` fallback, sniffed extension overriding a
  lying client one); `resolveUploadPath` rejecting `../../etc/passwd` and an absolute-path name;
  collision suffixing; `ensureGitExcluded` creating, being idempotent, and no-op'ing without `.git`.
- `api/__tests__/uploads-route.test.ts` — happy path writes into the workspace and returns the path;
  oversize → 4xx; unknown session → 404; **another user's session → 404**; read-only workspace →
  409; escaping filename → 400.

### Frontend

The `vitest.config.ts` present in `apps/frontend` is **vestigial** — vitest is not installed and the
`test` script is `bun test --pass-with-no-tests`. Rather than adopt a test runner as a side effect of
this feature, the logic worth testing is kept pure and DOM-free so the existing `bun test` runs it:
`insertionTextFor`, `rejectionMessage`, and `injectText`'s bracketed-paste wrapping (both modes),
using Bun's built-in `File`. React wiring stays thin and is verified by hand.

### Manual verification (the assumptions that must be checked, not assumed)

1. **Text paste still reaches xterm with react-dropzone mounted** — the fallback in §6 exists for
   this. Check before building the rest of the frontend on it.
2. **A path injected into an empty Claude Code prompt does not open the slash-command palette** —
   the whole justification for decision 4.
3. Drop of multiple files injects one space-joined line.
4. A pasted screenshot lands as `pasted-<ts>.png` and the agent can read it.
5. `git status` in the workspace stays clean after an upload.

### Verification gate

`bun run verify-types`, `bunx turbo run lint`, `bun test`, and `turbo build` (the new route changes
the OpenAPI spec, so `@internal/backend-client` must regenerate).

Three failures **pre-exist on `main`** and are not caused by this work — do not treat them as
regressions, and do not fix them as a side effect:
- `TmuxRunner > streams output to a pipe-pane file` — the test attaches `pipe-pane` after the
  pane's `echo` has already run, and `pipe-pane` only captures output produced after attach.
- `SessionManagerService > restartSession clones profile/workspace with a (2) name`.
- `workspaces route > admin creates a workspace (POST) and lists it (GET)`.
- `@internal/frontend#verify-types` fails on `Cannot find module 'vitest/config'` from the vestigial
  config above.

---

## Risks

| Risk | Mitigation |
|---|---|
| react-dropzone's paste handler interferes with text paste | Manual check #1 before building on it; documented fallback in §6. |
| `addon-search` / `addon-serialize` versions mismatch `@xterm/xterm@6.0.0` | Neither declares peer deps. Both were published alongside the current xterm line; install and `verify-types` before wiring. |
| Bracketed paste unsupported by a future harness | We gate on `term.modes.bracketedPasteMode` and degrade to raw input rather than assuming. |
| Unbounded upload growth in a workspace | Accepted per decision 1; folder is discoverable and git-excluded. |
| 25MB in one request blocks the event loop | Bun streams the multipart body; the cap keeps worst case small. Revisit only if a larger cap is wanted. |
