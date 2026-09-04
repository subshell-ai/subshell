# Close vocabulary + per-user terminal history — design

Date: 2026-09-03
Status: approved by the operator in brainstorming (four scope questions + one shape question)

## Purpose

Simplify the subshell action menu to what the operator actually uses, and move the
one surviving knob from a per-subshell dialog to a per-user setting:

1. **"Delete subshell" → "Close"** everywhere humans see it. Behavior is unchanged
   (`DELETE /api/subshells/:id` already terminates the process first, then removes
   the row and its log); only the vocabulary changes.
2. **Terminal history moves per-user.** The per-subshell "Terminal history…" dialog
   is removed; a new **Account** card ("Terminal history lines") stores one cap per
   user that applies to every terminal they attach to.
3. **Title pinning becomes implicit.** A manual rename already locks the name in the
   backend (`renameSubshell` sets `nameLocked: 1`), so the explicit
   "Pin this title" / "Resume auto title" menu items are removed, together with the
   `autoTitle` API escape hatch.
4. **Terminate leaves every human surface.** Delete (now: Close) subsumes it — it
   terminates first and removes the row; a stop-without-delete flow had no use-case.
   The HTTP endpoint stays because the agents' MCP tool `terminate_subshell` and the
   delete/restart internals use the same service path.

Everything here is browser/mobile vocabulary and menu surgery plus one setting —
the wire API keeps `DELETE /api/subshells/:id` and `POST /api/subshells/:id/terminate`.

## Decisions taken in brainstorming

| Question | Decision |
| --- | --- |
| Terminate removal blast radius | All human UI (web menu, dock pane header, bulk bar, mobile); keep the endpoint |
| History setting home | New card on `/account`; per-subshell override **dropped** entirely |
| "Resume auto title" escape hatch | Dropped too — a rename is a permanent opt-out of auto-naming |
| "Close" wording | Everywhere humans see it, confirm dialogs included |
| Setting storage | Dedicated typed `userMeta` column + dedicated cookie-gated endpoint (Approach A), not a JSON bag, not localStorage |

## 1. "Close" vocabulary

Wording rule (unchanged from `lib/subshell-confirmations.ts`): title is the question
with the name in it; description is the one-sentence consequence.

- `components/subshell-actions-menu.tsx`: `"Delete subshell"` → `"Close"`; swap the
  `Trash2` icon for `X`; keep `destructive: true` and the sidebar variant.
- `lib/subshell-confirmations.ts`: rename `confirmDeleteSubshell(s)` →
  `confirmCloseSubshell(s)`. Copy:
  - single: `Close subshell "X"?` / "This stops the process and removes the subshell
    and its history permanently. It cannot be recovered." / confirm label `Close`
  - bulk: `Close N subshells?` / same consequence in plural / `Close`
- `components/workspace-dock/group-header-actions.tsx`: pane-header `"Delete"` →
  `"Close"` (button keeps `Trash2` → `X` for consistency; `onTerminate` plumbing is
  removed by §4, leaving Close + the transcript finder).
- `components/subshell-manager-table.tsx`: bulk-bar `"Delete"` → `"Close"`.
- `components/subshell-terminal.tsx` exited-state panel: `"Delete"` → `"Close"`.
- `apps/mobile/src/components/subshell-detail.tsx`: the Delete action (label +
  confirm copy) → Close.

Server-side vocabulary (`deleteSubshell`, route file names, DELETE) is **not**
renamed — this is human-facing copy only.

## 2. Per-user "Terminal history lines"

### Storage + API

- Migration `0020-user-meta-replay-lines.ts` adds `userMeta.terminalReplayLines`
  — nullable integer (`Generated<number | null>` in `UserMetaTable`), registered in
  the provider map in `src/db/migrate.ts` (file name = map key).
- `UserMetaRepository`: `getTerminalReplayLines(userId)` /
  `setTerminalReplayLines(userId, lines)` (explicit `null` = "no preference").
- Endpoint: `GET /api/settings/terminal-history` → `{ lines: number | null }` and
  `PATCH` with `{ lines: t.Nullable(t.Number({ minimum: 1, maximum: 200 })) }` —
  same bounds as today's per-subshell route. **Fold into the existing
  `settings.route.ts` module** rather than creating a new route module: a fresh
  `.use()` layer has repeatedly tripped the `App`-type depth ceiling (TS2589) in
  this codebase. The handler is gated with `requireCookieActor` (self-service,
  operates on `user.id` — the notifications-settings precedent); the admin
  instance-settings endpoints in the same module keep their `requireAdmin`.

### Attach resolution

`replayLineCap` (`services/nodes/log-tail.ts`) keeps the pure math
(`stored ?? env ?? 100`); only its *input* changes at both call sites:

- `ws/subshell-ws.ts` (local attach) and `ws/remote-subshell-ws.ts` (remote relay)
  stop passing `row.terminalReplayLines` and instead read the subshell **owner's**
  `userMeta.terminalReplayLines` (the row already carries `ownerId`).

Precedence: user setting → `SUBSHELL_TERMINAL_REPLAY_LINES` → 100. A shared viewer
gets the **owner's** cap (the attach replays from the owner's pane; simplest
rule, and the viewer's own card governs panes they own).

### Removals

- `PATCH /api/subshells/:id/replay` (`update-subshell-replay.route.ts`) + its tests,
  `subshells.service.setSubshellReplayLines`, `ReplayLinesDialog`, and the
  "Terminal history…" menu item.
- `terminalReplayLines` disappears from `SubshellView` / server view models.
- The `subshells.terminalReplayLines` **column stays** but is read/written by
  nothing — dropping a column is a one-way migration for zero user benefit
  (rollback safety); the db-types field gains a deprecation comment.

### UI

New card on `/account` (between `TerminalFontCard` and `NotificationsCard` —
it is server-stored, unlike the per-device font size, but reads as terminal
neighborhood): title "Terminal history", select with
Default(100) / 25 / 50 / 100 / 150 / 200 — same option set the dialog had —
built from the `notifications-master-card` query/mutation pattern.

## 3. Title pinning becomes implicit

- Menu loses both `{Pin,PinOff}` items; `useSubshellMutations.toggleTitleLock`
  and the `Pin`/`PinOff` imports go away.
- `PATCH /api/subshells/:id/name` drops the `autoTitle` body flag and
  `subshells.service.setSubshellAutoTitle`; the route keeps
  name-rename (which locks) only. The `autoTitle`-specific tests go with it.
- Unchanged: rename → `nameLocked: 1`; the harness titling sweep and the
  `subshellName` handed to the harness (both key off `nameLocked`).

Accepted consequences (operator's call, "drop both halves"):

- A manual rename is a **permanent** opt-out of auto-naming — no UI or API path
  returns a named subshell to the sweep.
- Rows previously pinned via the old "Pin this title" button *without* a rename
  keep their lock with no way to release it. (No migration: they are normal
  locked rows.)

## 4. Terminate leaves human UI

Removed (web):

- overflow-menu item + sidebar variant (`subshell-actions-menu.tsx`),
- dock pane-header button and `onTerminate` through
  `workspace-dock/context.tsx` + `workspace-dock.tsx`,
- bulk-bar Terminate button + `confirmTerminateSubshells` /
  `confirmTerminateSubshell` (`lib/subshell-confirmations.ts`),
- the `terminate` mutation from `useSubshellMutations` (the exited panel uses only
  restart/delete — verified), and `busy` shrinks to restart+delete.

Removed (mobile): the Terminate action in `subshell-detail.tsx` and
`api.terminate()` in `lib/api.ts`.

Kept:

- `POST /api/subshells/:id/terminate` — consumed by the MCP tool
  `terminate_subshell` (agents) and behaviorally identical to what delete/restart
  do internally via the service layer.
- "Restart" / "Start again" menu items, and the `terminated` **status** word (state
  vocabulary, not an action).

## Error handling

- PATCH terminal-history: validation 400s via the existing error handler (bounds in
  the schema); non-cookie actors get the notifications-style 403. The card shows
  `errMessage` inline, exactly like the replay dialog did.
- Everything else is removal — no new failure modes.

## Testing

- **Frontend**: update `subshell-actions-menu.test.tsx` (no Terminate / no
  Terminal-history / no Pin items; Close item), manager-table and
  dock/`subshell-tab` tests (bulk/header labels, no Terminate), confirmations
  copy, a new card test for the account setting, mobile label updates.
- **Server**: migration applies (existing migrate coverage pattern),
  repo get/set incl. explicit null, `settings-route.test.ts` gains
  GET/PATCH terminal-history (owner round-trip, null, out-of-bounds 400, bearer
  403), name-route tests lose `autoTitle` cases, replay-route tests deleted,
  ws attach tests assert the cap comes from the owner's `userMeta`.
- **E2E**: grep the suite for "Terminate" / "Delete subshell" / "Terminal history"
  labels and follow any spec that drives them (none matched at design time —
  re-verify during the plan).
- Docs: refresh any AGENTS.md/spec mentions of the replay dialog or pin menu item;
  changeset bump (user-visible server change: new `/api/settings/terminal-history`,
  removed `PATCH /:id/replay`).

## Out of scope

- Any change to delete/terminate **semantics** (delete still terminates first).
- Instance-admin defaults UI (the env var stays the fallback; no admin page for it).
- The uncommitted harness-session WIP on `fix/keep-panes-and-session-refresh` —
  this work branches from `main` **after** that WIP is committed, to keep the
  overlapping files (`subshells.service.ts`, `models.ts`, `subshells/index.ts`)
  from forking twice.
