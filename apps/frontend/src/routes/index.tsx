import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { LayoutGrid, List, Plus, TerminalSquare } from "lucide-react";
import { useState } from "react";
import { EmptyState } from "@/components/empty-state";
import { ErrorBanner } from "@/components/error-banner";
import { LiveStatus } from "@/components/live-status";
import { SessionCard } from "@/components/session-card";
import { SessionManagerTable } from "@/components/session-manager-table";
import { SessionSearch } from "@/components/session-search";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import { useLiveSessions } from "@/hooks/useLiveSessions";
import { apiFetch } from "@/lib/api";
import { filterSessions, groupSessions } from "@/lib/session-filter";
import { priorityRunning } from "@/lib/session-order";
import type { SessionView } from "@/types/session";

/** How the session list is presented. */
type SessionsView = "tiled" | "list";

export const Route = createFileRoute("/")({
  component: SessionsPage,
  // The view lives in the URL rather than component state so it survives a
  // reload and can be linked to — and so an end-to-end check can name the
  // view it wants instead of clicking to reach it.
  //
  // Optional, and tiled is the *absence* of the param rather than
  // `?view=tiled`: a required search param would make every `to="/"` link in
  // the app supply one, which is a lot of ceremony for a display preference.
  validateSearch: (search: Record<string, unknown>): { view?: SessionsView } =>
    search.view === "list" ? { view: "list" } : {},
});

/**
 * Sessions: every session, as tiles or as a list.
 *
 * These were two pages — a card grid at `/` and a "Manager" table at
 * `/sessions` — showing the same sessions with different affordances, which
 * left the same question ("where do I go to do X?") on both. One page with a
 * view switch answers it: tiles for reading state at a glance, the list for
 * acting on many sessions at once. Search applies to both.
 */
function SessionsPage() {
  const navigate = useNavigate();
  const { view = "tiled" } = Route.useSearch();
  const { sessions, connected, isLoading, isError, refetch } = useLiveSessions();
  const [query, setQuery] = useState("");
  const { data: setup } = useQuery({
    queryKey: ["setup-status"],
    queryFn: () => apiFetch<{ needsSetup: boolean }>("/api/setup/status"),
  });

  if (setup?.needsSetup) {
    navigate({ to: "/setup" });
    return null;
  }

  const filtered = filterSessions(sessions, query);
  const groups = groupSessions(filtered);
  // Bell-on sessions waiting for the operator lead the Running section;
  // everything else keeps the order the feed gave it.
  groups.running = priorityRunning(groups.running);

  /** Switches view. Tiled clears the param rather than spelling out the default. */
  function setView(next: SessionsView) {
    void navigate({ to: "/", search: next === "list" ? { view: "list" } : {} });
  }

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="font-bold text-2xl">Sessions</h1>
          <p className="text-muted-foreground text-sm">Agent harness sessions</p>
        </div>
        <Button onClick={() => navigate({ to: "/new" })}>
          <Plus /> New session
        </Button>
      </header>

      <div className="flex flex-wrap items-center justify-between gap-4">
        <SessionSearch value={query} onChange={setQuery} />
        <div className="flex items-center gap-3">
          <LiveStatus connected={connected} />
          <Segmented
            ariaLabel="Sessions view"
            options={[
              { value: "tiled", label: "Tiles", icon: <LayoutGrid className="h-4 w-4" />, ariaLabel: "Tiled view" },
              { value: "list", label: "List", icon: <List className="h-4 w-4" />, ariaLabel: "List view" },
            ]}
            value={view}
            onChange={setView}
          />
        </div>
      </div>

      {isLoading && <p className="text-muted-foreground text-sm">Loading sessions…</p>}

      {/* A failed list fetch is not an empty account: say what broke and
          offer the retry, rather than the "No sessions yet" card — the SSE
          stream may never have delivered either, so this is the only truth
          the page has. Network failures now also self-heal via the query
          retry loop (and the global offline banner); the button remains for
          HTTP failures and the impatient. */}
      {isError && (
        <ErrorBanner
          message="Couldn't load sessions — retrying…"
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

      {!isLoading && !isError && sessions.length === 0 && (
        <EmptyState
          icon={TerminalSquare}
          title="No sessions yet"
          description="Start an agent harness session to get going."
          actionLabel="Create your first session"
          onAction={() => void navigate({ to: "/new" })}
        />
      )}

      {!isLoading && sessions.length > 0 && filtered.length === 0 && (
        <p className="text-muted-foreground text-sm">No sessions match “{query}”.</p>
      )}

      {!isLoading && filtered.length > 0 && view === "list" && <SessionManagerTable sessions={filtered} />}

      {!isLoading && filtered.length > 0 && view === "tiled" && (
        <>
          <TileSection title="Running" sessions={groups.running} />
          <TileSection title="Paused / exited" sessions={groups.exited} />
          <TileSection title="Completed" sessions={groups.terminated} />
        </>
      )}
    </main>
  );
}

/** One status group of session tiles; renders nothing when the group is empty. */
function TileSection({ title, sessions }: { title: string; sessions: SessionView[] }) {
  if (sessions.length === 0) return null;
  return (
    <section>
      <h2 className="mb-3 font-semibold text-muted-foreground text-sm uppercase">{title}</h2>
      {/* Track count follows the container, but each card keeps a sane width:
          a fixed column count stretches one lone card across the screen on a
          wide window and starves it on a narrow one. */}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,240px),1fr))] gap-3">
        {sessions.map((s) => (
          <SessionCard key={s.id} session={s} />
        ))}
      </div>
    </section>
  );
}
