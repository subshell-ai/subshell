# Failed-session diagnostics: error log tail, profile shortcut, working dir in lists

Date: 2026-08-29
Status: approved by Theo in chat ("build it as described")

## Problem

When a harness process exits immediately (wrong API key, bad MCP path, missing
binary), the operator sees a dead session with no explanation: `preview` is
empty for dead sessions, the WS refuses to attach, and the pane log — the only
record of the error text — is written to disk but exposed by no endpoint.
Recovery also requires leaving the session page to find the profile.

## Agreed behavior

1. A crashed session's detail page shows the tail of its pane log (the error
   text), its exit code, and two shortcuts: **Start again** and **Edit
   profile** (link to the session's profile).
2. An empty log is reported honestly: "exited before producing output".
3. Retry semantics = the existing restart flow: a NEW session row from the
   same profile + working dir (audited `session.restart`); the failed row
   remains as history. No in-place relaunch.
4. The sessions list (cards + manager table) shows each session's working
   directory.
5. Crash representation is unchanged: `status='running', alive=false` +
   `exitCode` (there is deliberately no "failed" status).

## Design

### Backend — `GET /api/sessions/:id/log`

- New `SessionLogTailSchema` in `api/models.ts`:
  `{ lines: string[], truncated: boolean }`, full `t.*` descriptions.
- `readSessionLogTail(sessionId)` exported next to `sessionLogPath` in
  `services/session-manager.service.ts`: reads at most the last 256 KB of
  `<SESSION_DATA_DIR>/sessions/<id>.log`, keeps the last 200 lines,
  `truncated = window was clipped (by bytes or by lines)`, missing file →
  `{ lines: [], truncated: false }`. Never throws on read races.
- Route mirrors `GET /:id`'s visibility guard (owner or admin; 404 otherwise).
  Works for running and dead sessions alike.

### Frontend

- `use-session-log.ts`: fetch on demand (`enabled: !alive`), returns
  `{ lines, truncated }`.
- `session-terminal.tsx` exited panel: monospace scrollable log block (last
  ~40 lines rendered), exit-code line unchanged; empty log → "exited before
  producing output (code N)". Action row: Start again, Edit profile →,
  Delete. New props `profileId` + `profileName` (name resolved by the route
  from the cached `useProfiles()`; link via `navigate /profiles/$id`).
- `session-card.tsx`: working dir line (mono `text-xs`, dir-basename +
  full path in `title` to survive narrow cards).
- `session-manager-table.tsx`: "Working dir" column (same title trick).
- `session-actions-menu.tsx`: optional `onEditProfile` callback → menu item
  "Edit profile" after "Start again" when provided.

### Tests

- Backend route test (boot-DB recipe): log tail returns file lines; missing
  log → empty; foreign user's session → 404; truncated flag on >200-line log.
- Verification: `bun run verify-types`, `lint:check`, `test`, `turbo build`.

### Out of scope

Log pagination/streaming, inline profile editing, a "failed" DB status,
auto-restart backoff changes.
