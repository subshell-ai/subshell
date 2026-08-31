# Workspace Tiling — Design Spec (2026-08-28)

**Supersedes** `2026-08-27-workspaces-design.md`. That spec built a free-form canvas of draggable
windows; it shipped and works. This one replaces the canvas with **tmux-style tiling**, driven by a
mouse-first UI that assumes no tmux knowledge, on top of the
[`dockview-react`](https://www.npmjs.com/package/dockview-react) layout manager.

**Goal:** a workspace is a saved tiling layout of agent sessions. Panes divide the space; nothing
overlaps; nothing is positioned by hand. Adding a session and choosing where it goes is one action —
a split menu everywhere, or a drag onto the half of a pane you want it to take where a pointer
exists. It must work on a desktop, a tablet and a phone.

**No backwards compatibility.** Pre-release, local-first, no external consumers. Migration `0006` is
rewritten in place rather than superseded, and existing databases are recreated.

---

## Decisions taken up front

| Question | Decision | Why |
|---|---|---|
| Layout model | **Recursive tiling** (splits to any depth), not a free canvas | Chosen over the shipped canvas |
| Library | **`dockview-react` 8.2.0** | MIT, React 19, actively released; verified by spike (below) |
| Split affordance | **A visible split menu on every pane**, with drag-onto-a-pane as a pointer-only accelerator | Discoverable without tmux vocabulary, and drag cannot work on touch (§7) |
| Layout storage | **One `layout_json` on the workspace** | dockview owns the tree; we persist its serialization |
| Zoom / pan | **Neither** | Tiling has no off-screen space to pan to |
| Small screens | **Tabs, not tiles** — one session at a time below 1024px, and the layout is **read-only** there | A phone cannot usefully tile terminals, and a phone visit must not overwrite the desktop arrangement |

### The spike that settled the library

Documentation could not answer the only question that mattered: does moving a pane remount it? A
remount disposes the terminal, closes its socket and forces a full history replay — the bug class
that produced three Criticals in the canvas implementation.

A throwaway probe mounted three live `<SessionTerminal>`s in dockview and re-parented one into
another group (destroying its old group — the DOM operation a drag-split performs):

- mount/unmount events: **9 before, 9 after** — zero remounts
- WebSockets opened: **0**
- terminals kept streaming unbroken

With `renderer: 'always'`, dockview's documented guarantee — "the panel instance is only ever
destroyed when it is removed" — holds for React subtrees carrying xterm. **This is the property the
whole design rests on, and §8 makes it a standing check rather than a one-off result.**

Rejected: `flexlayout-react` (no documented external-drag support — the primary gesture),
`react-mosaic` (drags in `react-dnd@5`, `uuid@3`, `prop-types`), `rc-dock` (latest is a 4.0 alpha),
`@dnd-kit` (~20 months stale), `react-resizable-panels` (does not list React 19), `allotment`
(splits only, no drop zones).

---

## 1. What this deletes

The canvas machinery goes entirely. This is a **net reduction** of roughly 1,000 lines:

| File | Lines | Fate |
|---|---|---|
| `components/workspace-canvas.tsx` | 393 | **Delete** — dockview owns layout, pan, dividers |
| `components/workspace-pane.tsx` | 439 | **Delete** — replaced by a much smaller pane body (§5) |
| `hooks/use-pane-visibility.ts` | 129 | **Delete** — see below |
| `hooks/use-pane-layout.ts` | 163 | **Delete** — dockview holds layout state |
| `lib/canvas-geometry.ts` + its test | 178 | **Delete** — no coordinates to compute |
| `hooks/use-debounced-save.ts` | 82 | **Keep** — still debounces the layout save (§4) |
| `components/add-pane-menu.tsx` | 264 | **Rewrite** as a session list + split menu (§6) |

**Virtualization dissolves, and that is the point.** In a tiling layout every pane is on screen by
construction, so `paneIsVisible`, `VISIBILITY_MARGIN`, the 2s detach debounce and the per-pane timer
bookkeeping have nothing to decide. The `active` prop on `<SessionTerminal>` stays — it is still the
right lever — but it is now driven by dockview's `onDidVisibilityChange`, which is true for tiled
panes and false only for **background tabs in a tab group**. That is a genuinely simpler rule with
the same benefit: a background tab frees its socket and WebGL context.

Two of the canvas's Criticals lived in the code being deleted (the pan dead-zone, and the expanded
pane's own detach timer). Neither has an equivalent here.

## 2. What survives untouched

- **`<SessionTerminal>`** and its whole prop surface, including `active`, `showStatePanels`,
  `onReady`/`onDispose`. The extraction that was the hard part of the canvas work is the reason this
  redesign is cheap.
- `use-session-data.ts`, `use-session-actions.ts`, `command-bar.tsx`, `transcript-search.tsx`, and
  `/sessions/:id` in full.
- The entire backend except pane geometry: `workspaces` table identity, ownership rules
  (`findByIdForUser`, 404-never-403), FK cascades, the session-summary join, attach-existing and
  launch-new-session, restart repointing.
- `lib/session-confirmations.ts` — the destructive-action prompts.

## 3. Schema — migration `0006` rewritten in place

`workspaces` loses the canvas viewport and gains the layout:

| column | change |
|---|---|
| `canvas_x`, `canvas_y` | **removed** — nothing pans |
| `layout_json` | **added**, `text` null — dockview's `toJSON()` output; null means "no layout saved yet" |

`workspace_panes` keeps only identity and loses all geometry:

| column | change |
|---|---|
| `x`, `y`, `width`, `height`, `z_index`, `collapsed` | **removed** — dockview's tree owns all of it |
| `id`, `workspace_id`, `session_id`, `created_at`, `updated_at` | unchanged |

Both foreign keys keep `ON DELETE CASCADE`. That remains the entire dangling-pane strategy and its
two tests stay exactly as they are.

**`layout_json` and `workspace_panes` must agree.** dockview's serialized tree references panel ids;
those ids are `workspace_panes.id`. A pane row with no panel in the layout is an orphan, and a panel
id with no row is a dangling reference. §4 makes the server the arbiter.

## 4. Backend

`PUT /api/workspaces/:id/panes` — the bulk geometry save — is **replaced** by
`PUT /api/workspaces/:id/layout`, taking `{ layout: <dockview JSON> }` and writing `layout_json`.
`WorkspacePanesRepository.replaceGeometry` and its `PaneGeometry` type are deleted.

`GET /api/workspaces/:id` returns `{ workspace, panes }` as now, minus geometry, plus
`workspace.layout` (the parsed JSON, or null).

**Reconciliation on read, in the route.** Because a session delete cascades a pane away without
touching `layout_json`, `GET /:id` filters the stored layout against the surviving pane rows before
returning it: any panel id with no pane row is dropped. A pane row absent from the layout is
returned in `panes` and the client appends it as a new tab in the active group. This keeps the two
representations honest without a background sweep, and it is what makes the cascade continue to
work unchanged.

The debounced save (`use-debounced-save.ts`, ~800ms, flush on unmount and `visibilitychange`, drop
in-flight rather than queue) is kept as-is and now carries the layout rather than the geometry array.

Everything else in `workspaces.route.ts` is unchanged, including the ownership rule and the two
security tests.

## 5. The pane body

`components/workspace-pane.tsx` (439 lines) is replaced by `components/session-pane.tsx`, which is
only the *content* of a dockview panel — dockview supplies the frame, tab, title and close control:

```ts
interface SessionPaneProps {
  /** The pane row, joined with its session's summary fields */
  pane: WorkspacePaneRow;
  /** From dockview's onDidVisibilityChange; false for a background tab */
  active: boolean;
  /** Restart the pane's session (exited/terminated only) */
  onRestart: (sessionId: string) => void;
}
```

It renders `<SessionTerminal sessionId active showUploads showStatePanels={false} />` plus its own
compact exited/terminated panel with Restart and Remove pane, exactly as today. Gone with the frame:
drag handlers, resize handles, hover peek, pointer-capture logic, z-index, and the expanded-state
branch. **The pointer-capture bug and the drag-rescue fix both disappear with the code that had
them.**

`renderer: 'always'` is set on every panel. It is not optional — it is what keeps the DOM alive and
the terminal undisposed, and §7 tests it.

**Zoom replaces expand.** dockview ships `api.maximizeGroup()`, which is tmux's `prefix-z` and
covers what click-to-expand did. It needs no re-parenting, so the whole class of expand bugs is
gone. The expanded-only chrome (Terminate, Delete, transcript search) moves onto the maximized
group's header.

## 6. Adding a session

`components/session-list.tsx` (rewritten from `add-pane-menu.tsx`) is a sidebar list of the caller's
sessions not already in this workspace. Each row is `draggable`, setting the session id on the drag
event.

There are three ways in, and **drag is deliberately not the one everything depends on**:

1. **A per-pane split menu — the primary path.** A button in each panel's tab opens Split right /
   Split down / Open as tab, each with a session picker. It works with a mouse, a finger, or a
   keyboard, and it is the only path guaranteed on touch (§7). Everything else is an accelerator.
2. **Drag a session from the list onto a pane** — the fast path on pointer devices. dockview handles
   the drop: `onUnhandledDragOverEvent` accepts our drag type so the drop overlay appears, and
   `onDidDrop` gives the resolved position (the half of the pane that was hovered). Rows are made
   `draggable` only when `matchMedia("(pointer: fine)")` matches, so a touch device is never shown an
   affordance it cannot use.
3. **"New session here"** — the existing profile + mount dialog, adding into the focused group.

All three converge on the same handler: `POST /api/workspaces/:id/panes` to create the pane row, add
the dockview panel at the chosen position, save the layout.

If the pane `POST` fails after a session was created, the error surfaces and the session is left
alone — deleting it to "clean up" would destroy a session the user just launched.

## 7. Small screens — tablet and mobile

Mote is used from a tablet or phone, and **tiling is a desktop affordance**. A terminal needs width:
80 columns at the app's 13px font is roughly 640px, so a 390px phone tiles nothing usefully, and two
panes side by side on a portrait tablet gives neither enough room to read.

**Below 1024px the workspace renders as tabs, not tiles.** One session fills the viewport; a
horizontally scrollable tab strip switches between them. This is a second presentation of the same
data, not a second feature:

- **`<SessionTerminal>` is shared** — identical component, identical `active` contract. Only the
  chrome around it differs.
- **dockview is not mounted at all below the breakpoint.** Its drag model, dividers and drop overlays
  are pointer-first, and its own docs note touch and pen drags cannot bridge to external HTML5 drop
  zones. Rendering our own tab strip (a strip plus one pane, on the order of 60 lines) is less code
  than fighting it, keeps dockview out of the mobile bundle path, and gives full control over touch
  target sizes.
- **`active` is true only for the visible tab.** On a phone that is exactly right: one socket, one
  WebGL context, nothing draining battery in the background. The rule is the same one the wide
  presentation uses for background tabs.

**The narrow presentation never writes `layout_json`.** This is the important part. If a phone saved
its layout, one visit would flatten a carefully split desktop arrangement into a flat tab list, with
no undo. Below the breakpoint the layout is **read-only**: panes can be added, removed and switched,
but the split tree is left exactly as the desktop left it. Adding a pane from a phone appends a pane
row, and the desktop's reconciliation-on-read (§4) picks it up as a new tab on next load.

Other touch specifics:

- Split-menu and tab-strip hit areas are at least 44px; the desktop's dense icon rows are not reused.
- Tab switching is a tap on the strip. No swipe gesture — xterm owns horizontal touch-drag for
  selection, and stealing it would break text selection in the terminal.
- The terminal keeps the app's existing font size. Mobile column count is genuinely tight, and
  choosing a per-breakpoint font is a real decision with real tradeoffs (smaller text vs. wrapped
  agent output) — it is **deliberately out of scope here** and noted as a follow-up, so this spec does
  not smuggle in a typography change disguised as a layout one.

The breakpoint is a single shared constant so the two presentations cannot disagree about where it
sits.

## 8. Testing

**Backend**, all existing suites keep passing with geometry assertions removed:
- migration test: both cascades, unchanged — they remain the load-bearing ones.
- route test: the ownership pair (404-never-403) unchanged; the `PUT /panes` geometry test is
  rewritten against `PUT /layout`, asserting a layout round-trips and that a foreign caller gets 404.
- **new**: `GET /:id` drops panel ids whose pane row no longer exists (the cascade-reconciliation
  rule in §4), and returns a pane row missing from the layout.

**Frontend** — pure functions only, per this repo's convention:
- `lib/__tests__/workspace-layout.test.ts` for the reconciliation helper shared with the server view:
  given a stored layout and a set of surviving pane ids, drop dangling panels and report additions.

**The no-remount property gets a standing check, not a one-off.** The spike proved it once against
dockview 8.2.0; a dependency bump could silently regress it. The implementation plan carries a
documented manual probe — mount panels, move one between groups, assert zero new WebSockets — to be
re-run on any `dockview-react` upgrade, recorded in `AGENTS.md` next to the migration note.

Then the full gate: `bun run verify-types`, `bun run lint:check`, `bun run test`, `turbo build`.

## 9. Risks

1. **The remount guarantee is a dependency's behaviour, not ours.** Verified at 8.2.0; mitigated by
   `renderer: 'always'` and the standing probe in §7. If a future version breaks it, the fallback is
   pinning — the version is pinned anyway per project rules.
2. **Bundle size.** `dockview-core` is ~5 MB unpacked. It tree-shakes and the package advertises
   itself as side-effect-free, but the frontend's session chunk is already 531 KB. The plan should
   record the chunk size before and after and flag a regression beyond ~150 KB gzipped.
3. **The two presentations can drift.** A pane added on mobile must appear on desktop and vice
   versa. Mitigated by both reading the same `GET /:id` and by reconciliation-on-read (§4); the
   breakpoint constant is shared so neither can disagree about which presentation is active. The
   risk that remains is behavioural divergence in the pane chrome, which is why both render the same
   `<SessionTerminal>` rather than two copies of it.
4. **dockview's styling must be themed.** It ships `dockview.css` with a dark theme
   (`dockview-theme-dark`); matching it to the app's palette is real work, and an unstyled dock is
   conspicuous. Scoped as its own task rather than absorbed elsewhere.
5. **Layout and pane rows drift.** Mitigated by reconciliation-on-read (§4) rather than a sweep, and
   tested both server- and client-side.
