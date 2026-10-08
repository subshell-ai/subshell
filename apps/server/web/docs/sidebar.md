# The rail: sidebar rows, node groups, the Needs Attention spotlight

Deep dive for `apps/server/web`, moved verbatim out of `AGENTS.md`.
This file carries the full history behind the summary; the routing line in
`AGENTS.md` names when to read it.

**The sidebar (`components/app-sidebar.tsx` + `components/sidebar/`) is more
than nav.** Recent subshell rows carry a status dot and are the drag source of
"drag a session into a workspace" (targets: `workspace-dock.tsx`'s tiles
wrapper and the `/workspaces` cards; the payload contract is
`lib/subshell-dnd.ts`: handlers react ONLY to its MIME, which is what keeps
xterm's file-drop and dockview's tab-drag untouched). Status words/precedence
live once in `lib/subshell-indicator.ts`, and `SubshellDot`
(`components/subshell-dot.tsx`, moved out of `components/sidebar/` on
2026-09-24 because it is no longer sidebar-only) is its only renderer: the
rail's rows, the subshell page header, the home cards' corner and the list
rows' name cell. The text chips (`StatusChip`/`WaitingChip`, kept in
`subshell-status.tsx`) now survive only in the add-subshell picker, where
`RowStatusBadges` still spells the state out. Subshell lists everywhere are kept current by ONE
live socket (`hooks/use-live-subshells-feed.tsx`, mounted in `__root.tsx`
signed-in-only), which writes `/ws/live`'s frames into `SUBSHELLS_QUERY_KEY`;
read via `useSubshellsList`/`useLiveSubshells`, never by opening a second one.
It is a WebSocket rather than the `EventSource` it replaced (spec 2026-09-19)
because an SSE stream holds one of the browser's six per-origin HTTP/1.1
connections for the life of the tab, and the instance is plain http, so three
dashboard tabs spent half the pool before any fetch.

**The recent list is GROUPED by the machine each subshell runs on** (spec
2026-09-20, `lib/subshell-node-groups.ts`). Three rules ride the grouping and
each can be gotten wrong quietly. **The cap is PER NODE**: `RECENT_LIMIT` rows
per group, so the rail can be 8×N rows deep (the `nav`'s `overflow-y-auto`
scrolls that; the liveliest-member sort keeps the group needing attention at
the top, and the group's rank is the MINIMUM across its rows because activity
re-derives against the clock while the input's sort ran once). **A collapsed
group is a per-DEVICE preference** (`lib/sidebar-node-group-pref.ts`,
localStorage, keyed by node ID so an admin's rename moves every label and
reopens nothing). **While the filter box has text every group forces open AND
its header goes inert**: a live chevron there would write the collapse behind
a screen that moves nothing and shut the group the moment the filter cleared.
Header labels read `node.name`, never the id, and the unresolved ladder is
"never succeeded (in flight, or failed with nothing cached) → short id, with
the full one as the hover title; answered-without-the-id → `unknown node`",
NOT "deleted node"; a revoked share is indistinguishable from deletion, and
this header labels `local` too (the retired card pill could dodge by
returning null; a section header cannot). The flag is `nodeData === undefined`, not `isError`: TanStack reports
`isError` on a failed BACKGROUND refresh while keeping the cache, and
relabeling resolved names on a blip is the bug that shape caused once. A
row's tooltip carries Name/Node/Agent/(Preset, only when the launch has
one)/Status/Directory, the asked-for facts framed by the two strings the
rail truncates, which the PRE-grouping title existed to reveal. It is a `ui/tooltip` popup (the shadcn Base UI split
form, `TooltipTrigger render={...}`) merged onto the row's own `Link` rather
than a native `title` (2026-09-24 reversal: the browser paints native
tooltips at the SYSTEM font size, so page zoom grew the rail and left the
reveal behind; `render` composes the fourth consumer without the wrapper
that used to be the reason not to). Base `ui/tooltip` text is `text-body`,
one step up from `detail`, same day's call.
**Above the groups sits a `Needs Attention` spotlight** (spec 2026-09-24,
`needsAttention()` in the same lib): the owner's rows whose push has not been
opened since, filtered by the same rule as the bell. It is a sibling, never a
group: no chevron, no collapse pref, and an unseen row stays in its machine
group too (spotlight, not extraction: group counts stay true and no row jumps
when a pane is opened). It filters with the box and vanishes entirely when
nothing is unseen; the home page's identically-named `TileSection` is the same
selector over its own list.

**The selection is a SET for ordering, a single FOCUS for marking.** The set
is the viewed `/subshells/:id` PLUS every pane of the `/workspaces/:id` you
are standing in; the rail reads the SAME `useWorkspace` query the route runs
(a cache hit, `enabled` off a workspace page so it never fetches elsewhere),
and the grouped shapes (rows and headed cells) PROMOTE a whole machine group
whose visible rows contain a selected pane to the top. On the ROWS the set
fills with the accent and focus adds the ring. On the CELLS (final ruling
2026-09-27) only the focused pane marks: a full-white `ring-1 ring-foreground`
with the frame dropped, over a grid whose every other cell wears a DIM white
`border-foreground/25`. Two levels of one white. The set-wide cell ring was
the FIRST design and was rejected the same day: "when in a workspace, ALL
items have a white border." The five forms that day, in order: `/70` over the
dark border read as no ring; `ring-2` read heavy; a focus corner bead read as
a status dot; both orchids (`--primary`, `--ring`) lost to the green fills;
a dim-set/full-focus ring over a dim-white grid is what stood. Set membership
still decides which cells click-to-focus; `SubshellCellGrid` takes
`selectedIds` AND `focusedId`. Deliberate asymmetry, not drift: the cell ring
is full ink where the ROW's focus ring stays `ring-foreground/70`. The row's
fill already carries its selection; the bare cell needed the louder mark.

**The whole section lives in `components/sidebar/rail-subshells.tsx`**
(extracted from `app-sidebar.tsx` 2026-09-25) and renders in three shapes
behind one per-device toggle (`lib/sidebar-rail-view-pref.ts`): `rows` (the
default, and the fallback for a corrupt pref), `cells` (the machine groups,
every row a status square), and `cells-flat` (one headerless grid in FOUR bands:
Needs Attention, then machine clusters holding a selected pane, then the other
machines, then cross-agent comms). All modes read the SAME
derivation pipeline, so a switch changes shape only, never the caps, and
never the set once every group is open (a collapsed group is grouped mode's
privilege; parity-pinned by tests). **A cell is the dot's language at grid
size, never a second encoding**: fills from `DOT_CLASS`, the bell from
`BELL_TONE`/`showsBell` (exported for this), the row's gestures whole on one
element, and the same reveal tooltip, opened BELOW the cell (a right-side
popup lands on the next cell in the rail), labels bolded by
`TooltipLabelledLines`. Its working blink pulses the FILL only, the
half-green idle tile fading in and out behind a constant WHITE initial (the
solid-green beat and its dark knockout letter were retired 2026-09-27). On
the empty half the square stays there: an un-ringed working cell carries the
shared dim-white `border-foreground/25` frame the fill pulses inside, while a
focused one needs no frame under its ring. Cells wear their PANE's initial, a
hint never a key, and the flat plates are FNV-1a over the machine NAME into
eight theme-tuned `--node-tint-*` tokens (278–332, the canvas hue is 296):
pure function, no per-machine state, a rename can move a colour, two
machines may share a plate (the tooltip's Node line is the truth). Cluster
rank is the grouped headers' own liveliest-member rule, over the rows each
view can see (a capped or comms-led machine may order differently between
the two, accepted, order is a scan hint). `Segmented`
grew `tooltip` and `dense` as opt-ins with byte-identity pinned for every
other caller; the ONE clock tick still lives in `AppSidebar`.

**Two groups sit under the pages** (spec 2026-10-07): Nodes, Presets and
Prompts live in a personal `Settings` group beside the admin-only `Server
Settings` group. The grouping is chrome; routes and access rules did not
move. The account card that used to sit in the rail's footer moved into the
header, into the slot the instance-name line used: the browser rail renders
no footer at all, and the server version plus instance name ride the menu's
detail line. An admin with a newer server published gets an amber dot on the
avatar and an "Update available" row leading to `/settings/updates`. Only
the Subshell Server desktop keeps the footer rows (server pill,
app-update line): they describe the server connection and the app bundle,
not an account. The Subshell Client window takes the browser branch, so it
renders no footer at all.
