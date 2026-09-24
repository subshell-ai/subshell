import { Button } from "@internal/node-admin";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { LayoutGrid, List, Plus, TerminalSquare } from "lucide-react";
import type { JSX } from "react";
import { useState } from "react";
import { EmptyState } from "@/components/empty-state";
import { ErrorBanner } from "@/components/error-banner";
import { useQuickAdd } from "@/components/quick-add";
import { SubshellCard } from "@/components/subshell-card";
import { SubshellManagerTable } from "@/components/subshell-manager-table";
import { SubshellSearch } from "@/components/subshell-search";
import { SearchableSelect } from "@/components/ui/combobox";
import { Segmented } from "@/components/ui/segmented";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useCardPreviews } from "@/hooks/use-card-previews";
import { useClockTick } from "@/hooks/use-clock-tick";
import { useNodes } from "@/hooks/use-nodes";
import { usePublicSettings } from "@/hooks/use-public-settings";
import { useLiveSubshells } from "@/hooks/useLiveSubshells";
import { launchGuidance } from "@/lib/launch-guidance";
import { canAddNode } from "@/lib/node-enrollment";
import { filterByNode, filterSubshells, machineIds } from "@/lib/subshell-filter";
import { ACTIVITY_TICK_MS, sortByStatus } from "@/lib/subshell-indicator";
import { groupSubshellsByNode, needsAttention, nodeLabelFor } from "@/lib/subshell-node-groups";
import { priorityRunning } from "@/lib/subshell-order";
import { sectionsByNode, sectionsByStatus } from "@/lib/subshell-sections";
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
  const { subshells, isLoading, isError, refetch } = useLiveSubshells();
  const [query, setQuery] = useState("");
  // The machine filter is page-level: it narrows BOTH views. It lives in
  // component state (not the URL) for the same reason the search box does —
  // it is a viewing preference, not a destination.
  const [machine, setMachine] = useState("all");
  // Which axis the page segments by (operator ask, 2026-09-24): MACHINE
  // groups by where subshells run (the rail's label ladder), STATUS by what
  // they are doing (the dots' own bands). A viewing preference, not a
  // destination, so it lives here like the filter rather than in the URL.
  const [groupBy, setGroupBy] = useState<"machine" | "status" | "none">("machine");
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
  // sort is stable: its ranked rows — bell-on AND currently-waiting — lead
  // WITHIN their band, the rule that led the flat Running list surviving the
  // machine segmentation. Distinct from the spotlight above, which selects on
  // the UNSEEN-PUSH signal: a resumed row clears the waiting stamp without
  // clearing the bell, so the two lists read different fields (the confusion
  // `needsAttention`'s own docblock warns about, named here so the ordering
  // comment is not a second source for it). No memo — `filtered` is a fresh
  // array every render, so there would be nothing to hit.
  const sorted = sortByStatus(priorityRunning(filtered));
  // `null` is the no-grouping answer, and it is what the flat renderers
  // already mean: the table drops its bands, the tiles one heading-less grid.
  const sections =
    groupBy === "machine"
      ? sectionsByNode(groupSubshellsByNode(sorted, nodeData?.nodes, { unanswered }))
      : groupBy === "status"
        ? sectionsByStatus(sorted)
        : null;
  // The "nothing can run subshells" empty state (operator ask 2026-09-24):
  // needs the Server-as-node flag and the enrollment rule, both from the
  // shared public read every signed-in page already holds, and the agent
  // count from the same nodes read the grouping uses. `launchGuidance` is
  // silent until the nodes read has ANSWERED, so a fresh page shows the
  // ordinary empty state for a beat rather than a card that may retract.
  const { data: publicSettings } = usePublicSettings();
  const guidance = launchGuidance({
    nodesLoaded: nodeData !== undefined,
    agentNodeCount: (nodeData?.nodes ?? []).filter((n) => n.kind === "agent").length,
    settings: publicSettings,
    canAdd: canAddNode(publicSettings),
  });
  // Filter options are the machines with rows (the page cannot meaningfully
  // filter to a machine with nothing on it); a STALE selection is kept in the
  // list so the control never blanks itself out from under its own value.
  const machines = machineIds(subshells);
  const machineOptions = (machine !== "all" && !machines.includes(machine) ? [...machines, machine] : machines).map(
    (id) => ({ id, label: nodeLabelFor(id, nodeData?.nodes, unanswered).label }),
  );
  // The combobox closed state and the list both print the OPTION LABEL, and
  // the value is a node id while the reader needs a machine name — the id→
  // name ladder answer is baked in here, once. "All machines" leads as the
  // default pick: the combobox has no clear affordance, so returning to the
  // unfiltered view is a pick, not an erasure.
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

      {/* Two deliberate rows (operator ask, 2026-09-24): the search spans the
          content width and the row under it does too — the machine combobox
          takes the remaining space beside the view toggle, so the columns
          line up instead of the bottom row floating half-width. */}
      <div className="space-y-4">
        <SubshellSearch value={query} onChange={setQuery} className="w-full max-w-full" />
        <div className="flex items-center gap-4">
          {/* Always rendered (operator ruling, 2026-09-24): the old gate hid
              it until a second machine had rows, which read as the feature
              being missing on exactly the instances where people decide to
              add a machine. It narrows BOTH views. Default is All. */}
          <div className="min-w-0 flex-1">
            {/* The same searchable combobox the launch pickers use: type-to-
                  filter is what a machine list earns when a fleet grows past
                  what a click-through enumerates. The sr-only label keeps the
                  accessible name the old `aria-label` carried. */}
            <label htmlFor="subshells-machine-filter" className="sr-only">
              Filter by machine
            </label>
            <SearchableSelect
              id="subshells-machine-filter"
              value={machine}
              placeholder="All machines"
              options={machineItems}
              onValueChange={(v) => setMachine(v === "" ? "all" : v)}
            />
          </div>
          <div className="w-36 shrink-0">
            <Select
              value={groupBy}
              onValueChange={(v) => {
                if (v === "machine" || v === "status" || v === "none") setGroupBy(v);
              }}
              items={[
                { value: "machine", label: "By machine" },
                { value: "status", label: "By status" },
                { value: "none", label: "No grouping" },
              ]}
            >
              <SelectTrigger aria-label="Group by" className="text-muted-foreground">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="machine">By machine</SelectItem>
                <SelectItem value="status">By status</SelectItem>
                <SelectItem value="none">No grouping</SelectItem>
              </SelectContent>
            </Select>
          </div>
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

      {!isLoading &&
        !isError &&
        subshells.length === 0 &&
        (guidance ? (
          // No machine can run subshells at all (Server switched off as a
          // node AND no agent rows) — say so and point at the remedy,
          // instead of a "Create your first subshell" button whose dialog
          // would just answer with the empty-target screen (2026-09-24
          // operator ask; the branches and the copy rule live in
          // `lib/launch-guidance.ts`).
          <EmptyState
            icon={TerminalSquare}
            title={guidance.headline}
            description={guidance.description}
            actionLabel={guidance.actionLabel}
            onAction={() => void navigate({ to: guidance.actionTo })}
          />
        ) : (
          <EmptyState
            icon={TerminalSquare}
            title="No subshells yet"
            description="Start an agent harness subshell to get going."
            actionLabel="Create your first subshell"
            onAction={openLaunch}
          />
        ))}

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

      {!isLoading && filtered.length > 0 && view === "list" && (
        // `sorted`, not `filtered`: in the no-grouping mode these ARE the
        // rows, and flat tiles render the same order — one axis, one order,
        // both views. (Grouped, the rows come from `sections` anyway, and
        // `subshells` only scopes the selection, which is id-based.)
        <SubshellManagerTable subshells={sorted} sections={sections ?? undefined} />
      )}

      {!isLoading && filtered.length > 0 && view === "tiled" && (
        <>
          {/* Not a machine, so there is no id to reveal: label and title are
              one string, and TileSection's equal-title branch renders this
              heading with no tooltip at all. */}
          <TileSection label="Needs Attention" title="Needs Attention" subshells={attention} />
          {sections ? (
            sections.map((sec) => (
              <TileSection key={sec.key} label={sec.label} title={sec.title} subshells={sec.subshells} />
            ))
          ) : (
            // No grouping: one grid, no headings — the spotlight above is
            // unaffected, since it is a different question from grouping.
            <TileGrid subshells={sorted} />
          )}
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
 * proper noun the operator chose, not a status band. Its hover reveal is the
 * full node id whenever the registry could not resolve a name — a `ui/tooltip`
 * popup, not a native `title` (same 2026-09-24 zoom reason as the rail rows),
 * and absent entirely when the title would only repeat the heading.
 */
function TileSection({ label, title, subshells }: { label: string; title: string; subshells: SubshellView[] }) {
  if (subshells.length === 0) return null;
  const heading = <h2 className="mb-3 truncate font-strong text-detail text-muted-foreground">{label}</h2>;
  return (
    <section>
      {title === label ? (
        heading
      ) : (
        <TooltipProvider delay={300}>
          <Tooltip>
            {/* The label rides the RENDER element rather than the trigger's
                children — biome's heading-content rule reads the `h2`
                itself, and Base UI keeps the element's own children. */}
            <TooltipTrigger
              render={<h2 className="mb-3 truncate font-strong text-detail text-muted-foreground">{label}</h2>}
            />
            <TooltipContent>{title}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
      <TileGrid subshells={subshells} />
    </section>
  );
}

/**
 * The tile grid itself, shared by the sectioned view and the no-grouping
 * flat view (2026-09-24), so the size rules are one definition.
 */
function TileGrid({ subshells }: { subshells: SubshellView[] }): JSX.Element {
  return (
    /* Track count follows the container; the card width does not. 240px is
       the floor AND the ceiling, so a tile is the same size on every page at
       every window width and only the number of them per row changes.

       A stretching track is what made a wider window shrink a card: the
       columns divide the row, so crossing into a second column halved the
       single card that was there. Nothing stretches now, so nothing can.
       `min(100%, …)` is the one concession — a container narrower than a
       card gets a narrower card rather than a horizontal scrollbar.

       The cost is up to one card's width of empty space at the right edge,
       which is the honest trade for a grid that never resizes its
       contents. `auto-fit` keeps that space at the end of the row instead
       of holding it in phantom columns between the cards. */
    <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,240px),240px))] gap-3">
      {subshells.map((s) => (
        <SubshellCard key={s.id} subshell={s} />
      ))}
    </div>
  );
}
