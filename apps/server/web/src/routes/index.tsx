import { Button } from "@internal/node-admin";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { LayoutGrid, List, Plus, TerminalSquare } from "lucide-react";
import { useState } from "react";
import { EmptyState } from "@/components/empty-state";
import { ErrorBanner } from "@/components/error-banner";
import { LiveStatus } from "@/components/live-status";
import { useQuickAdd } from "@/components/quick-add";
import { SubshellCard } from "@/components/subshell-card";
import { SubshellManagerTable } from "@/components/subshell-manager-table";
import { SubshellSearch } from "@/components/subshell-search";
import { Segmented } from "@/components/ui/segmented";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCardPreviews } from "@/hooks/use-card-previews";
import { useClockTick } from "@/hooks/use-clock-tick";
import { useNodes } from "@/hooks/use-nodes";
import { useLiveSubshells } from "@/hooks/useLiveSubshells";
import { filterByNode, filterSubshells, machineIds, showMachineFilter } from "@/lib/subshell-filter";
import { ACTIVITY_TICK_MS, sortByStatus } from "@/lib/subshell-indicator";
import { groupSubshellsByNode, needsAttention, nodeLabelFor } from "@/lib/subshell-node-groups";
import { priorityRunning } from "@/lib/subshell-order";
import type { SubshellView } from "@/types/subshell";

/** How the subshell list is presented. */
type SubshellsView = "tiled" | "list";

export const Route = createFileRoute("/")({
  component: SubshellsPage,
  // The view lives in the URL rather than component state so it survives a
  // reload and can be linked to — and so an end-to-end check can name the
  // view it wants instead of clicking to reach it.
  //
  // Optional, and tiled is the *absence* of the param rather than
  // `?view=tiled`: a required search param would make every `to="/"` link in
  // the app supply one, which is a lot of ceremony for a display preference.
  validateSearch: (search: Record<string, unknown>): { view?: SubshellsView } =>
    search.view === "list" ? { view: "list" } : {},
});

/**
 * Subshells: every subshell, as tiles or as a list.
 *
 * These were two pages — a card grid at `/` and a "Manager" table at
 * `/subshells` — showing the same subshells with different affordances, which
 * left the same question ("where do I go to do X?") on both. One page with a
 * view switch answers it: tiles for reading state at a glance, the list for
 * acting on many subshells at once. Search and the machine filter apply to
 * both; since 2026-09-24 the tiles are segmented by machine (the sidebar's
 * grouping) and status reads as the dot on every card and row.
 */
function SubshellsPage() {
  const navigate = useNavigate();
  // Both "New subshell" affordances raise the rail's launch dialog — the one
  // the sidebar, the phone drawer and `/new` all share.
  const { openLaunch } = useQuickAdd();
  const { view = "tiled" } = Route.useSearch();
  const { subshells, connected, isLoading, isError, refetch } = useLiveSubshells();
  const [query, setQuery] = useState("");
  // The machine filter is page-level: it narrows BOTH views. It lives in
  // component state (not the URL) for the same reason the search box does —
  // it is a viewing preference, not a destination.
  const [machine, setMachine] = useState("all");
  // No needsSetup guard here on purpose: the root shell's gate owns that
  // redirect. While the shell is navigating to the lazy /setup route, the
  // router keeps the previous match mounted for a frame — a render-phase
  // navigate() in this window restarts the very navigation it waits for,
  // and the loop saturates the main thread (fresh-instance hang, 2026-09-03;
  // regression: e2e spec 01).

  const searched = filterSubshells(subshells, query);
  const filtered = machine === "all" ? searched : filterByNode(searched, machine);
  // The cards are the only surface that renders a screen, so they are what
  // asks for one (spec 2026-09-19 §4.4).
  useCardPreviews(filtered.map((s) => s.id));
  // ONE tick for the whole list, never one per card: with the feed
  // event-driven, nothing arrives to mark the passage of time, so a subshell
  // that simply goes quiet needs a clock to be seen going idle.
  useClockTick(ACTIVITY_TICK_MS);
  // The owner's unanswered pushes, gathered above the machine sections
  // (spec 2026-09-24). `filtered` (not `subshells`) so the page's own search
  // and machine filter narrow it exactly as they narrow the groups; the
  // selector is owner-only, so a shared unseen pane is not listed here any
  // more than in the rail. `TileSection` renders nothing when the list is
  // empty, so the whole section disappears with the last unseen push — no
  // empty heading. It stays ABOVE the machine sections rather than folded
  // into them: the grouping answers "where is it", this answers "who has my
  // attention", and the unseen cards also reappear inside their own machine
  // group (the 2026-09-24 rail design's duplication, kept: a card listed only
  // at the top would vanish from its machine's count-in-context).
  const attention = needsAttention(filtered);
  // The tiles are segmented by MACHINE (2026-09-24, operator request) the way
  // the sidebar's recents are: the same grouping and the same label ladder
  // from lib/subshell-node-groups.ts, so "which section is this" reads
  // identically in the rail and on the page, and a rename moves both. Status
  // is what the dots say now — the cards' corner and the list rows' name cell
  // carry it — so the old Running/Paused/Completed bands left with the chips.
  // No per-group cap here: the rail caps a group at 8 rows because it is a
  // rail; the page shows what it has.
  const { data: nodeData } = useNodes();
  // Unanswered is `nodeData === undefined`, not `isError` — the ladder's own
  // rule: a failed BACKGROUND refresh keeps the cache, and relabeling resolved
  // names on a blip is the bug that shape caused once in the sidebar.
  const unanswered = nodeData === undefined;
  // Rail order in, exactly as the sidebar's grouping expects it: status band
  // first (waiting → working → idle → offline → exited → ended), groups then
  // ranked by their liveliest member. `priorityRunning` first because the
  // sort is stable: unanswered pushes lead WITHIN their band, which is the
  // 2026-09-24 attention rule surviving the machine segmentation (it used to
  // lead the flat Running list). No memo — `filtered` is a fresh array every
  // render, so there would be nothing to hit.
  const machineGroups = groupSubshellsByNode(sortByStatus(priorityRunning(filtered)), nodeData?.nodes, {
    unanswered,
  });
  // Filter options are the machines with rows (the page cannot meaningfully
  // filter to a machine with nothing on it); a STALE selection is kept in the
  // list so the control never blanks itself out from under its own value.
  const machines = machineIds(subshells);
  const machineOptions = (machine !== "all" && !machines.includes(machine) ? [...machines, machine] : machines).map(
    (id) => ({ id, label: nodeLabelFor(id, nodeData?.nodes, unanswered).label }),
  );
  // Base UI's Value prints the RAW value without this map, and here the value
  // is a node id while the reader needs a machine name. Labels must match the
  // SelectItem texts below exactly.
  const machineItems = [
    { value: "all", label: "All machines" },
    ...machineOptions.map((m) => ({ value: m.id, label: m.label })),
  ];
  const machineWord = machineOptions.find((m) => m.id === machine)?.label ?? machine;

  /** Switches view. Tiled clears the param rather than spelling out the default. */
  function setView(next: SubshellsView) {
    void navigate({ to: "/", search: next === "list" ? { view: "list" } : {} });
  }

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="font-strong text-heading">Subshells</h1>
          <p className="text-muted-foreground text-sm">Agent harness subshells</p>
        </div>
        <Button onClick={openLaunch}>
          <Plus /> New subshell
        </Button>
      </header>

      <div className="flex flex-wrap items-center justify-between gap-4">
        <SubshellSearch value={query} onChange={setQuery} />
        <div className="flex items-center gap-3">
          {/* The machine filter appears once the distinction is real (more
              than one machine, or a lone non-`local` node); a one-choice
              dropdown whose only option is "All" is a control with no choice.
              It narrows BOTH views. Default is All. */}
          {showMachineFilter(machines, machine) && (
            <div className="w-40 shrink-0">
              <Select value={machine} onValueChange={(v) => v !== null && setMachine(v)} items={machineItems}>
                <SelectTrigger aria-label="Filter by machine" className="text-muted-foreground">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All machines</SelectItem>
                  {machineOptions.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <LiveStatus connected={connected} />
          <Segmented
            ariaLabel="Subshells view"
            options={[
              { value: "tiled", label: "Tiles", icon: <LayoutGrid className="h-4 w-4" />, ariaLabel: "Tiled view" },
              { value: "list", label: "List", icon: <List className="h-4 w-4" />, ariaLabel: "List view" },
            ]}
            value={view}
            onChange={setView}
          />
        </div>
      </div>

      {isLoading && <p className="text-muted-foreground text-sm">Loading subshells…</p>}

      {/* A failed list fetch is not an empty account: say what broke and
          offer the retry, rather than the "No subshells yet" card — the live
          stream may never have delivered either, so this is the only truth
          the page has. Network failures now also self-heal via the query
          retry loop (and the global offline banner); the button remains for
          HTTP failures and the impatient. */}
      {isError && (
        <ErrorBanner
          message="Couldn't load subshells, retrying…"
          action={
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0 text-destructive underline"
              onClick={() => void refetch()}
            >
              Try again
            </Button>
          }
        />
      )}

      {!isLoading && !isError && subshells.length === 0 && (
        <EmptyState
          icon={TerminalSquare}
          title="No subshells yet"
          description="Start an agent harness subshell to get going."
          actionLabel="Create your first subshell"
          onAction={openLaunch}
        />
      )}

      {!isLoading && subshells.length > 0 && filtered.length === 0 && (
        <p className="text-muted-foreground text-sm">
          {query ? (
            <>No subshells match “{query}”.</>
          ) : (
            // The machine filter narrowed everything away — say WHICH machine
            // came up empty, since its name is what the dropdown now reads.
            <>No subshells on “{machineWord}”.</>
          )}
        </p>
      )}

      {!isLoading && filtered.length > 0 && view === "list" && <SubshellManagerTable subshells={filtered} />}

      {!isLoading && filtered.length > 0 && view === "tiled" && (
        <>
          {/* The attention heading is a fixed string, and its hover text
              would say the same thing — same-value title is the honest no-id
              case for a section that is not a machine. */}
          <TileSection label="Needs Attention" title="Needs Attention" subshells={attention} />
          {machineGroups.map((g) => (
            <TileSection key={g.nodeId} label={g.label} title={g.title} subshells={g.subshells} />
          ))}
        </>
      )}
    </main>
  );
}

/**
 * One MACHINE's group of subshell tiles — the tile view's segmentation since
 * 2026-09-24, on the same grouping/labels the sidebar rail uses (see
 * lib/subshell-node-groups.ts). Renders nothing when the group is empty. The
 * heading is the node's NAME (a rename moves it), never uppercased: it is a
 * proper noun the operator chose, not a status band. Its hover text reveals
 * the full node id whenever the registry could not resolve a name.
 */
function TileSection({ label, title, subshells }: { label: string; title: string; subshells: SubshellView[] }) {
  if (subshells.length === 0) return null;
  return (
    <section>
      <h2 className="mb-3 truncate font-strong text-muted-foreground text-sm" title={title}>
        {label}
      </h2>
      {/* Track count follows the container; the card width does not. 240px is
          the floor AND the ceiling, so a tile is the same size on every page
          at every window width and only the number of them per row changes.

          A stretching track is what made a wider window shrink a card: the
          columns divide the row, so crossing into a second column halved the
          single card that was there. Nothing stretches now, so nothing can.
          `min(100%, …)` is the one concession — a container narrower than a
          card gets a narrower card rather than a horizontal scrollbar.

          The cost is up to one card's width of empty space at the right edge,
          which is the honest trade for a grid that never resizes its
          contents. `auto-fit` keeps that space at the end of the row instead
          of holding it in phantom columns between the cards. */}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,240px),240px))] gap-3">
        {subshells.map((s) => (
          <SubshellCard key={s.id} subshell={s} />
        ))}
      </div>
    </section>
  );
}
