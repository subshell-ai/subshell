# Close keeps the row; the prompts page gets one New button

Date: 2026-09-29. Status: SUPERSEDED the same day, never implemented (operator: verb behavior stays as on main; the copy picker this fed is removed - see 2026-09-29-preset-launch-fields-design.md).

## Summary

Two UX fixes in one change. First, the menu verb "Close" stops being DELETE's
human name: it terminates the process and keeps the row, so a closed subshell
stays restartable, stays listed, and shows up under "Recently terminated" in
the launch form's copy picker. A new owner-only "Delete" verb appears on closed
rows and does what Close does today. Second, the Prompts page header replaces
its "New prompt" + "New stack" button pair with one "New" button that opens a
menu; the create dialogs themselves are untouched.

## Item 1: Close softens, Delete is born

**The defect, as observed.** The operator closed a subshell and it was absent
from "Copy settings from a subshell". On the live instance every listed row is
`running`: no UI verb produces a `terminated` row at all. "Close" is the
DELETE verb's human name (spec 2026-09-03, "Close subsumes Terminate"): it
terminates first, then removes the row and the pane log. A closed subshell
leaves nothing for the picker to list. The two-category copy picker shipped the
same day (operator ruling 2026-09-29) can only be fed by MCP
`terminate_subshell`.

**The rulings.** Close softens to terminate. Hard Delete exists again as its
own verb, offered only on already-closed rows.

**Verbs by row state.**

| Row state | Menu verbs | Endpoint | Gate |
| --- | --- | --- | --- |
| Running | Restart, **Close** (soft) | `POST /api/subshells/:id/terminate` (exists, mounted, unchanged) | `canEdit`, as terminate always has been |
| Closed (`terminated`) | **Start again**, **Delete** | `DELETE /api/subshells/:id` (unchanged) | Delete is owner-only; an `edit` grantee sees only Start again |

Delete keeps the share-rule posture (delete was always owner-only, admins
included). The DELETE route still terminates before removing; harmless and
kept as the ordering guarantee. No server change anywhere in this spec: the
terminate endpoint has been live the whole time for the MCP door.

**Surfaces that reroute.** Every human "Close" today calls `remove` in
`use-subshell-mutations.ts`; that hook gains a `close` (terminate) alongside
`remove` (now Delete), and every caller moves:

- `SubshellActionsMenu` (cards, rows, detail header, sidebar cells via the
  `sidebar: true` item set): running rows keep "Close", now soft; closed rows
  get "Delete" (destructive, owner-only).
- The terminal's exited/dead panel (`subshell-terminal.tsx` renders
  Restart/Close there): the second button becomes "Delete", since the row is
  already stopped.
- The workspace dock's tile close (`workspace-dock.tsx`): soft Close, plus the
  tile-removal it already does.
- Mobile detail sheet (`subshell-detail.tsx`): same mapping; `api.ts` gains a
  `terminate()` method (its "No terminate()" comment is retired with the
  ruling).

**Confirmations** (`lib/subshell-confirmations.ts`; title is the question,
description one sentence):

- Close (new copy, no longer `danger: true`; a soft close is recoverable):
  `Close subshell "name"?` / "The process stops. The subshell and its history
  stay here until you delete them."
- Delete (the permanent sentence Close used to say): `Delete subshell "name"?`
  / "This removes the subshell and its history permanently. It cannot be
  recovered." `danger: true`.
- Bulk close in `subshell-manager-table.tsx`: soft, new copy ("Their processes
  stop. They stay listed until you delete them."). No bulk Delete (YAGNI; row
  menus carry it).

**Downstream, free.** Closed rows reach every surface that already renders the
`terminated` state (hollow dot, cell grid, dead panel with log tail), the
"Recently terminated" group of the copy picker, and `launchTemplateFromList`
(terminated rows were always eligible). Pane-log retention already owns the
content's lifetime: local sweep after `SUBSHELL_LOG_RETENTION_DAYS` (default
30), node-side default 1 day; the row outlives its log, which is fine for a
settings source.

**Not doing.** No auto-forget of terminated rows (single-user instance;
manual Delete). No server/DB/schema change. No new endpoint.

**Docs and comments that become false, updated in the same change:** the
security-context bullet "`POST /:id/terminate` stays live at `edit` though the
button left the UI", the `use-subshell-mutations.ts` "Terminate is
deliberately absent" block, the confirmations header comment, and mobile
`api.ts`'s note.

## Item 2: one "New" button on the prompts page

**Today.** The `/prompts` header shows two buttons; each hides with the view
(Single drops "New stack", Stacked drops "New prompt"). The operator ruled the
pair should be one button. Two shapes were offered: a combined dialog with a
grouped Prompt/Stack tab, or one button opening a kind menu. The operator chose
the menu: `PromptFormDialog` and `StackFormDialog` stay as they are.

**Design.** The header's action becomes one primary button `<Plus /> New`
opening a dropdown menu (the app's existing menu primitive) with items "New
prompt" and "New stack". The per-view rule survives inside the menu: Single
lists only "New prompt", Stacked only "New stack", All lists both. The items
call the same handlers the buttons called (`setShowCreate` / `setStackDialog`)
and open the same dialogs. Create-only: the per-row "Edit" paths are untouched,
and the Shared tab already renders no create action. The launch form's "Add a
prompt" section and the inject dialog are unaffected: they never had two
buttons.

**Testing for both items.** Actions-menu behavior tests (Close posts terminate
and leaves the row; closed rows list Delete only for the owner; the dead panel
offers Delete), confirmation copy assertions, dock tile close and bulk close
routing, the prompts header (one button; menu contents per view; each item
opens its dialog), and the mobile detail-sheet verb swap. Existing tests pin
the old Close-as-DELETE posture and get updated, not deleted.
