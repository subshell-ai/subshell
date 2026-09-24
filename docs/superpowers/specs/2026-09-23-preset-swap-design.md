# Swap the preset on an existing subshell — design (2026-09-23)

A subshell's preset is today fixed at creation; changing it means editing the
preset definition (or the row's presetless state) and pressing Start again,
and it only works while the pane is dead. This adds a direct gesture: a menu
item that asks *which preset this pane should use next* and restarts the
session with it — usable on a running pane too. Decisions recorded here were
made by the operator this session: the selector offers only presets of the
subshell's own harness, "None" is a selectable target, and the API is an
optional body on the existing restart route rather than a new endpoint.

## 1. Why the restart route is the whole feature

`subshells.presetId` is a live column, not a launch-time snapshot: the manager
writes a swap at what its write-side comment names the swap point, and the
revive step re-reads the row fresh after it (`restartSubshell` in
`apps/server/api/src/services/subshell-manager.service.ts` — the comment that
names the swap point sits on that write, not in `#reviveRow`). A restart
therefore *is* "compose the launch from whatever presetId says now".
Swapping is: validate a new preset, write the column at
that point, continue. Everything downstream is untouched machinery — env/argv
layering locally, the full plane-built launch frame (argv + preset + env +
mcp + resolve) re-sent to the node for remote panes, MCP token rotation,
`publishLive({kind:"subshell.changed"})`, the `restartInFlight` lease joining
concurrent restarts (plain ones — a swap arriving mid-restart is refused, see
§4's amendment).

## 2. Server

**Route** (`apps/server/api/src/api/subshells/restart-subshell.route.ts`):
`POST /api/subshells/:id/restart` gains an optional body
`{ presetId: string | null }`, described with Elysia `t` descriptions. A
missing body means a plain restart, exactly as today — existing callers
(the SPA's Restart item, the MCP `restart_subshell` tool) send no body and are
untouched. The response schema is unchanged (`CreateSubshellResponseSchema`).
`presetId: null` means "swap to presetless"; omission means "no swap". An
explicit `null` and an omission are different payloads and must stay so.

**Authorization** is unchanged and stays the `#gate(…, "edit")` grant that
restart already enforces — a `view` grantee is refused as today, a foreign row
404s as today.

**Preset validation**, in `subshells.service.restartSubshell`, after the gate
and the maintenance refusal and before anything is killed:
`presetId` must be `null`, or a preset that **belongs to the calling viewer**
(`presets.userId === viewer.id`) and whose `harnessId` equals the row's. This
mirrors the create-time rule the clone comment documents (presets are strictly
per-user; a harness is immutable on a preset). Any failure refuses
`400 INVALID_PRESET` naming the refusal, and the preset of the row stays
exactly as it was — the write happens only at the swap point, which sits after
every refusal path. (Consequence, accepted: an `edit` grantee on a shared pane
can only swap in *their own* presets, and the row's `presetId` may then point
at another user's preset. Typing into the pane already runs as the owner's
OS user, so preset env carries no new power; the delete-a-preset path already
survives dangling references by nulling them.)

**The write** rides into `subshell-manager.service.restartSubshell` as an
optional `swapPresetTo` argument: `null` / string / undefined (no swap). The
manager writes the column at the swap point, and the fresh re-read of the row
that follows feeds `#reviveRow`, then the existing revive proceeds. If revive fails mid-flight, the row rolls
back to `terminated` **keeping the new preset** — that is the honest state:
the pane is dead and the next Start again uses the preset that was chosen.

**Audit**: one new event, `subshell.preset_switch`, metadata
`{ name, presetId }` (the new value, `null` included), recorded at the swap;
the existing `subshell.restart` row is emitted by the unchanged restart path.
Two rows for the act follows the `server.update` precedent (start + completing
boot). `docs/security.md` §10 and the `.claude/rules/security-context.md`
Subshells event line gain `subshell.preset_switch`.

**Announce**: the swap rides the restart pipeline's existing
`publishLive` (AGENTS: "every subshell mutation adds its announce" — here the
announce exists in the same pipeline and lands after both changes; a refusal
before the swap writes nothing and needs none).

## 3. Web

**Menu item** (`apps/server/web/src/components/subshell-actions-menu.tsx`):
"Switch preset…", icon `ArrowLeftRight`, `sidebar: true`, gated by the same
`canEdit` as Restart, placed beside it (after Restart / Start again, before
Clone). It offers on dead panes too — there it means "switch and start". The
menu already owns its dialog state, so this wires once for cards, table rows,
the detail header, and the sidebar right-click. The existing "Edit preset
…" item (which navigates to the preset's *definition* editor, dead panes
only) stays; it is a different act.

**Dialog** (`apps/server/web/src/components/switch-preset-dialog.tsx`),
composed like `CloneSubshellDialog` and mounted only while open:

- `DialogHeader`: title "Switch preset" (`heading` role), one-sentence
  description: the session restarts with the new preset's settings. UI copy
  carries no em dashes (design-system rule).
- The selector is the launch form's grammar — `Select` from
  `components/ui/select.tsx` with `items={[{value,label}]}` on the Root —
  "None" first, then `usePresets()` filtered to
  `p.harnessId === subshell.harnessId`. Default selection:
  `subshell.presetId ?? "none"`. A `presetId` that is not in the viewer's
  list (a grantee's foreign preset, or one deleted under us) renders as
  "None"; that is the same fallback the preset row already shows.
- Confirm button **Switch and restart**, disabled while the mutation is in
  flight. Confirming with an unchanged selection is legal and is exactly a
  restart — no special case, the server accepts it.
- The dialog owns its mutation (the clone dialog's pattern, not
  `useSubshellMutations`): POST the restart route with
  `{ presetId: "none" was chosen ? null : id }`, on success invalidate
  `SUBSHELLS_QUERY_KEY` + `SUBSHELL_QUERY_KEY` and close; on failure the
  dialog stays open and renders the server's message inline
  (`text-destructive`, "on the thing that failed" — this SPA has no toasts).

No client type changes: `SubshellView.presetId` and `PresetRow.harnessId`
already exist.

## 4. Error taxonomy

| condition | answer |
|---|---|
| row not visible to viewer | 404 (unchanged) |
| `view` access | refused by the gate (unchanged) |
| node offline / maintenance | 409, preset untouched — refused before the manager (maintenance always was; offline since the amendment below) |
| preset unknown, not the caller's, or wrong harness | 400 `INVALID_PRESET`, nothing written |
| a swap arrives while a restart is in flight | 409 `RESTART_IN_FLIGHT`, nothing written — refused, not joined (amendment below) |
| revive fails after the swap | row ends `terminated` with the new preset kept |

**Amendment 2026-09-24 (final review).** The offline row originally leaned on
the manager's kill, which sits before the swap point only for an ALIVE row: a
dead row skipped the kill, committed the swap, and `#reviveRow`'s first node
RPC was what threw — a 409 answering for a restart whose preset had already
moved. The service now refuses a swap-carrying restart before the manager when
the row's agent node has no live connection, so the table above is what
ships; a plain no-swap restart keeps its pre-existing path untouched.

The same review closed the lease hole the implementation had documented rather
than fixed: a swap that arrives while the `restartInFlight` lease is held is
now REFUSED (409 `RESTART_IN_FLIGHT`) instead of joining — the running revival
composes the first caller's preset, and a joined 200 would have promised a
swap that never lands. Plain restarts keep joining (that is the lease's
purpose). The refusal is keyed to the BODY, not the value: a swap-carrying
body whose target equals the current preset is refused during a held lease
too, even though §3's unchanged-target rule would have made it a no-op write —
one shape rule beats a caller-inspecting one at the lease. The audit rows of
the act (both `subshell.restart` and `subshell.preset_switch`) now name the
ACTING viewer, not the row's owner — moved together, the final review's
condition.

## 5. Tests

Server (`__tests__` beside the restart route/service): a no-body restart
behaves exactly as before (pins the MCP path); swap to the caller's
same-harness preset writes the column and the revive composes from it (assert
the env the launcher receives); swap to `null` clears; each refusal returns
400/404/409 and leaves `presetId` byte-identical; a `view` grantee is refused;
the two audit rows land with the right metadata.

Web (`bun test`, component suites): `switch-preset-dialog.test.tsx` covers
default = current, "None" first, harness filtering, the payload for None vs a
preset, unchanged-selection still submits, inline error on refusal; the
existing `subshell-actions-menu.test.tsx` pins the item's presence under
`canEdit` and its absence for a viewer (the menu's no-menu path is unchanged).

## 6. Docs, changeset, verification

- Update the two places that state "a subshell's preset is fixed at creation":
  the comment block in `subshell-actions-menu.tsx` and any `apps/server/web`
  AGENTS.md line with the same claim (check at implementation time).
- `@internal/server` minor changeset (the SPA ships embedded in the server —
  an ignored package's change rides its shipping app).
- Verify: `bun run verify-types`, `bun run lint:check`, `bun run test`,
  `bun run lint:design`. No Rust, no new dependencies.

## 7. Out of scope

- Changing the harness of a live or dead subshell (would silently become a
  fresh conversation in a different agent; the preset selector filters to the
  row's harness for exactly this reason).
- An MCP surface for the swap — `restart_subshell` keeps taking `{ id }` only.
- Swapping without restarting ("takes effect at some future restart" is the
  footgun this shape avoids).
- A generic `PATCH /:id/preset`; if one is ever wanted it can share the
  validation added here.
