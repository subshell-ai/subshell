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
import { useCardPreviews } from "@/hooks/use-card-previews";
import { useClockTick } from "@/hooks/use-clock-tick";
import { useLiveSubshells } from "@/hooks/useLiveSubshells";
import { filterSubshells, groupSubshells } from "@/lib/subshell-filter";
import { ACTIVITY_TICK_MS } from "@/lib/subshell-indicator";
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
 * acting on many subshells at once. Search applies to both.
 */
function SubshellsPage() {
  const navigate = useNavigate();
  // Both "New subshell" affordances raise the rail's launch dialog — the one
  // the sidebar, the phone drawer and `/new` all share.
  const { openLaunch } = useQuickAdd();
  const { view = "tiled" } = Route.useSearch();
  const { subshells, connected, isLoading, isError, refetch } = useLiveSubshells();
  const [query, setQuery] = useState("");
  // No needsSetup guard here on purpose: the root shell's gate owns that
  // redirect. While the shell is navigating to the lazy /setup route, the
  // router keeps the previous match mounted for a frame — a render-phase
  // navigate() in this window restarts the very navigation it waits for,
  // and the loop saturates the main thread (fresh-instance hang, 2026-09-03;
  // regression: e2e spec 01).

  const filtered = filterSubshells(subshells, query);
  // The cards are the only surface that renders a screen, so they are what
  // asks for one (spec 2026-09-19 §4.4).
  useCardPreviews(filtered.map((s) => s.id));
  // ONE tick for the whole list, never one per card: with the feed
  // event-driven, nothing arrives to mark the passage of time, so a subshell
  // that simply goes quiet needs a clock to be seen going idle.
  useClockTick(ACTIVITY_TICK_MS);
  const groups = groupSubshells(filtered);
  // Bell-on subshells waiting for the operator lead the Running section;
  // everything else keeps the order the feed gave it.
  groups.running = priorityRunning(groups.running);

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
          offer the retry, rather than the "No subshells yet" card — the SSE
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
        <p className="text-muted-foreground text-sm">No subshells match “{query}”.</p>
      )}

      {!isLoading && filtered.length > 0 && view === "list" && <SubshellManagerTable subshells={filtered} />}

      {!isLoading && filtered.length > 0 && view === "tiled" && (
        <>
          <TileSection title="Running" subshells={groups.running} />
          <TileSection title="Paused / exited" subshells={groups.exited} />
          <TileSection title="Completed" subshells={groups.terminated} />
        </>
      )}
    </main>
  );
}

/** One status group of subshell tiles; renders nothing when the group is empty. */
function TileSection({ title, subshells }: { title: string; subshells: SubshellView[] }) {
  if (subshells.length === 0) return null;
  return (
    <section>
      <h2 className="mb-3 font-strong text-muted-foreground text-sm uppercase">{title}</h2>
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
