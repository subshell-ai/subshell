# The live feed: no cadence, and the cache rules it owns

Deep dive for `apps/server/web`, moved verbatim out of `AGENTS.md`.
This file carries the full history behind the summary; the routing line in
`AGENTS.md` names when to read it.

**There is no cadence, and that is the design.** One snapshot at connect, then
a frame only when something changed: the server publishes domain events to Bun
pub/sub topics, and the socket subscribes to the ones its viewer may see. What
the old 1.5 s beat re-sent was almost entirely static (`alive`, `startedAt`,
the auto-title `name` and local `lastOutputAt` are written by the 60 s
reconcile sweep, everything else by a user action), and each rebuild captured
every running pane's screen server-side. Three consequences the client owns:

- **A snapshot must not clobber a newer event.** The socket subscribes BEFORE
  the list read, so the read may predate an event delivered first; the client
  keeps any row it has received an event for since this connect and lets the
  snapshot decide the rest, including which rows exist. No sequence numbers.
- **A broadcast carries no `access`**: one payload reaches every subscriber,
  so the per-viewer stamp cannot ride it. The client keeps the access it holds;
  a row arriving before any snapshot is skipped rather than guessed at.
- **Previews are PULLED** (`hooks/use-card-previews.ts`). The snapshot carries
  no screens, because capturing a pane costs a `capture-pane` spawn each and
  the home cards are the only surface that draws one. They ask for what they
  show, and re-ask when a change arrives for one of them.

**Which caches the feed writes, exactly**, because a reader that this page
missed is invisible until somebody notices a screen that never changes:
`SUBSHELLS_QUERY_KEY` always, and `["subshell", id]` (the per-id entry
`use-subshell-data.ts` reads), WHEN that entry already exists, never creating
one. Those are different keys, and for one review cycle only the first was
written: `/subshells/$id` then learned nothing after mount, its own pane dying
included, while workspace panes were fine because `use-subshell-row.ts` is a
selector over the list. A removal or an access change INVALIDATES the per-id
entry instead, so an active page refetches to the honest answer (including the
404 it renders as not-found) and an inactive one costs nothing. Any new reader
of a subshell should be a selector over the list, or it needs a line here.

**The feed is not the only writer of that cache, and the page must follow the
CACHE rather than the feed's own copy.** Every mutation's
`invalidateQueries` refetches the list and writes the same key. `useLiveSubshells`
used to return `feed.lastList ?? rest.data`, which shadowed exactly that, and
Close does both at once: the refetch removed the row, then `subshell-gone`
arrived, found nothing left to drop, returned early, and left `lastList`
holding a subshell that no longer existed. The card outlived it until the tab
reloaded. The old 1.5 s cadence hid this by re-sending the whole list; nothing
corrects it now. `lastList` answers ONE question (has the socket ever
delivered), which is what keeps a failed REST fallback from being reported as
an error on a page that has live data.

**Quiet frames still cost nothing**: the write is structurally shared (an
unchanged row keeps its object, an unchanged list keeps the array, and
`lastList` is set from the cache read-back, so the provider re-renders only on
real change), and a consumer that needs ONE row uses
`hooks/use-subshell-row.ts`.

**Activity is derived from a clock, not from a frame.** `deriveActivity`
answers active/idle from `lastOutputAt` against `Date.now()`, because with no
cadence nothing arrives to mark elapsed time and a subshell that simply went
quiet would read as working forever. `hooks/use-clock-tick.ts` re-renders the
surfaces that show it: ONE tick each for the home list and the rail, never one
per row. Any NEW surface rendering `subshellIndicator` needs its own tick.
