# Needs Attention section (2026-09-24)

## The problem

The unseen-push state (spec 2026-09-23) is visible only as a bell replacing a
row's dot, somewhere inside that pane's machine group. A person with several
machines has to scan every group to find the panes that pushed and are still
waiting. The want: one place that gathers exactly those panes, at the top,
and that is absent entirely when there is nothing to gather.

## Decisions taken in the design conversation

- **Two surfaces, one rule**: the sidebar rail gets a section above the
  machine groups, and the home page gets a section above "Running". A
  dedicated /notifications page was considered and rejected as more than the
  ask (operator call 2026-09-24).
- **Spotlight, not extraction**: an unseen pane appears in the new section
  AND in its machine group; group counts stay true and no row visibly jumps
  between groups (operator call 2026-09-24).
- **Client-side selector over the live list**: `unseenPush` already rides
  every subshell view and the `/ws/live` feed announces every write to the
  column (2026-09-23 work). No server change, no new endpoint.

## The mechanism

### The shared rule

One pure export, `needsAttention(rows)` in
`apps/server/web/src/lib/subshell-node-groups.ts`: takes the rail's
status-ordered rows, returns those with `subshell.unseenPush &&
subshell.access === "owner"`, order preserved, no cap.

The owner filter is load-bearing: every clear site for `last_push_urgency`
requires the owner's cookie, so a shared row would sit in a grantee's Needs
Attention forever — permanent noise from state that is not theirs. A row the
feed delivered before any snapshot stamped its `access` is skipped, never
guessed (the feed rule already established in `apps/server/web/AGENTS.md`).

A pane whose bell is off, or whose owner muted everything, is absent by the
same rule: it pushed nothing unseen, and "shown if there is a notification"
is literal — the signal is a delivered-unseen push, not a waiting chip.

### The rail

Between the filter box and the first `SubshellNodeGroup` (the
`item.to === "/" && !collapsed` region of `app-sidebar.tsx`), render:

- a header — the node-group header's idiom minus its chevron: `text-label
  font-strong`, muted, count right-aligned like the group count — reading
  "Needs Attention";
- the matching rows, each the same `SubshellRecentRow` the groups render
  (the row's `SubshellDot` is already a bell here, by 2026-09-23's swap).

The header carries **no chevron and does not collapse**. The section is
bounded by how many panes hold an unanswered push and each visit shrinks it;
a stored collapse preference would outlive its subject and resurrect as a
closed group for a future unseen push the user chose never to see.

While the filter box has text, the section filters like everything else:
matching rows only, and it renders nothing when its filtered set is empty
(the "No matches." line logic is untouched — it is driven by `listedCount`,
which already counts across groups).

### The home page

`routes/index.tsx` renders `<TileSection title="Needs Attention" ...>`
before the "Running" section, fed by the same selector over the page's
already-filtered, already-`priorityRunning` list. `TileSection` already
renders nothing when its group is empty — the hide-when-empty rule is
shared, not re-decided.

### Self-clearing (asserted, not built)

Opening a pane clears `last_push_urgency` server-side (detail GET, log GET,
or terminal attach) and announces `subshell.changed`; the feed flips
`unseenPush` false in every row copy. The row therefore leaves the section
in both surfaces the moment it is opened — clicking a Needs-Attention row IS
the dismiss, with no dismiss affordance of its own.

### Edge cases

- **Offline node, unseen push** — still listed. The push happened; the pane
  may still be waiting. Opening it clears even while the node is offline
  (the clear precedes the log read — established 2026-09-23).
- **Terminated row with an unseen exit/crash push** — listed; "you missed
  that it died" is attention the section exists to ask for.
- **No unseen rows anywhere** — neither surface renders anything; there is
  no empty-state, no disabled chrome.

## What does NOT change

`groupSubshellsByNode`, the collapse preference module, `SubshellNodeGroup`,
`RECENT_LIMIT`, the waiting-chip paths, the server, the feed protocol, and
the mobile app. The new section is a sibling above the groups, not a group
among them.

## Tests

- `needsAttention()` table: unseen/seen × owner/viewer; order preserved;
  `access` undefined skipped.
- Rail (component test beside the existing sidebar suite): header + rows
  appear above the first node group when any row qualifies; section absent
  when none do; filter text narrows it and empties it.
- Home: "Needs Attention" precedes "Running"; empty list renders no section.

## Surfaces this ships through

`@internal/server-web` is changeset-ignored — the SPA rides
`@internal/server` (minor, user-visible). No changeset for any other
workspace.
