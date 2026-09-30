import { Button, confirmAction, errMessage, Input } from "@internal/node-admin";
import { createFileRoute } from "@tanstack/react-router";
import { Copy, Layers, MessageSquareText, Pencil, Plus, Share2, ShieldOff, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { type ActionItem, ActionsMenu } from "@/components/actions-menu";
import { CopyButton } from "@/components/copy-button";
import { EmptyState } from "@/components/empty-state";
import { ErrorBanner } from "@/components/error-banner";
import { PageHeader } from "@/components/page-header";
import { PromptFormDialog } from "@/components/prompts/prompt-form-dialog";
import { PromptPageRow } from "@/components/prompts/prompt-page-row";
import { StackFormDialog } from "@/components/prompts/stack-form-dialog";
import { StackPageRow } from "@/components/prompts/stack-page-row";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Segmented } from "@/components/ui/segmented";
import {
  useDeletePrompt,
  useDeletePromptStack,
  usePromptStacks,
  usePrompts,
  useUpdatePrompt,
  useUpdatePromptStack,
} from "@/hooks/use-prompts";
import { promptDraftFromRow, suggestCloneDescription } from "@/lib/prompt-form";
import type { PromptBlock } from "@/lib/prompt-stack";
import { stackBlocksFromItems } from "@/lib/prompt-stack-form";
import {
  matchesStackQuery,
  type StackItemRow,
  type StackRow,
  type StacksView,
  stackJoinedText,
  stacksWithPrompt,
} from "@/lib/prompt-stacks";
import { matchesPromptQuery, type OwnPromptRow, type PromptsView, type SharedPromptRow } from "@/lib/prompts";

/**
 * Prompts (spec 2026-09-28) and prompt stacks (spec 2026-09-29). The tabbed
 * group is the shape of the page: ALL is the combined overview (the caller's
 * stacks over their singles, one search, the picker's "they appear the same"
 * posture); SINGLE carries the saved singles exactly as they shipped; STACKED
 * lists the ordered collections plus the empty-state filter the delete cascade
 * makes necessary. The URL carries every view choice so a link lands where it
 * names (the nodes page's rule); `?focus=` is the cross-link arrival from a
 * prompt row's "In N stacks".
 *
 * Search is client-side and shared across every view (small per-user lists,
 * the accepted no-pagination posture); "In N stacks" counts are derived from
 * the stacks payload, so a stack the caller cannot see never counts, exactly
 * the API's disclosure rule.
 */

type PageView = "all" | "single" | "stacked";
type PromptsTab = "own" | "shared";

export const Route = createFileRoute("/prompts")({
  component: PromptsPage,
  validateSearch: (search: Record<string, unknown>): { view?: PageView; tab?: PromptsTab; focus?: string } => {
    const out: { view?: PageView; tab?: PromptsTab; focus?: string } = {};
    // "all" is the default (an absent param); only the narrower views are named.
    if (search.view === "single") out.view = "single";
    if (search.view === "stacked") out.view = "stacked";
    if (search.tab === "shared") out.tab = "shared";
    // focus only means anything where the arrival can land (the effect early-
    // returns elsewhere), so a `?view=single&focus=…` link drops it at the
    // gate instead of carrying a param the page will never consume.
    if (out.view === "stacked" && typeof search.focus === "string" && search.focus !== "") {
      out.focus = search.focus;
    }
    return out;
  },
});

/** The stack editor's open state: which row (absent id = create) and seed. */
interface StackDialogState {
  editingId?: string;
  initial?: { label: string; blocks: PromptBlock[]; shared: boolean };
}

function PromptsPage() {
  const navigate = Route.useNavigate();
  const { view: viewParam, tab: tabParam, focus } = Route.useSearch();
  const activeView: PageView = viewParam ?? "all";
  const activeTab: PromptsTab = tabParam ?? "own";
  const prompts = usePrompts();
  const stacksQ = usePromptStacks();
  const update = useUpdatePrompt();
  const remove = useDeletePrompt();
  const stackUpdate = useUpdatePromptStack();
  const stackRemove = useDeletePromptStack();

  const [query, setQuery] = useState("");
  const [stackFilter, setStackFilter] = useState<"all" | "empty">("all");
  const [showCreate, setShowCreate] = useState(false);
  const [stackDialog, setStackDialog] = useState<StackDialogState | null>(null);
  // One dialog state covers edit and clone (the clone dialog re-seeds on
  // mount, so a stale draft cannot ride into the next open).
  const [editSource, setEditSource] = useState<{ row: OwnPromptRow; clone: boolean } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // The cross-link: which prompt row shows its stacks disclosure, and which
  // stack row carries the one-shot arrival ring. The ring's clear timer lives
  // in a ref: the URL focus id is CONSUMED on arrival (below), and an effect
  // cleanup keyed to that param would otherwise cancel the clear and leave
  // the ring stuck.
  const [stacksPanel, setStacksPanel] = useState<string | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const ringTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const view: PromptsView = prompts.data ?? { own: [], shared: [] };
  const stacksView: StacksView = stacksQ.data ?? { own: [], shared: [] };

  const go = (next: Partial<{ view: PageView; tab: PromptsTab }>) =>
    void navigate({
      search: (s) => ({
        ...s,
        ...(next.view !== undefined ? { view: next.view === "all" ? undefined : next.view } : {}),
        ...(next.tab !== undefined ? { tab: next.tab === "own" ? undefined : next.tab } : {}),
      }),
    });

  const own = useMemo(() => view.own.filter((p) => matchesPromptQuery(p, query)), [view.own, query]);
  const shared = useMemo(() => view.shared.filter((p) => matchesPromptQuery(p, query)), [view.shared, query]);
  // The All|Empty filter is a Stacked-only affordance (it is about MY
  // recoverable empty stacks), so it trims this list ONLY there; in All the
  // stacks show every match, and a filter left set from Stacked cannot
  // silently hide rows in the overview.
  const ownStacks = useMemo(
    () =>
      stacksView.own
        .filter((s) => matchesStackQuery(s, query))
        .filter((s) => !(activeView === "stacked" && stackFilter === "empty") || s.items.length === 0),
    [stacksView.own, query, stackFilter, activeView],
  );
  const sharedStacks = useMemo(
    () => stacksView.shared.filter((s) => matchesStackQuery(s, query)),
    [stacksView.shared, query],
  );

  /** The prompt-to-stacks cross-link, client-side by design: the payload
   *  holds only stacks the caller can see, so an invisible stack never
   *  counts. Small lists; the helper scans per row (the same one the lib
   *  tests pin). */
  const allStacks = useMemo(() => [...stacksView.own, ...stacksView.shared], [stacksView]);
  const stacksForPrompt = (id: string): StackRow[] => stacksWithPrompt(allStacks, id);

  // The arrival: a cross-link jump lands on Stacked with the search and the
  // empty filter cleared, scrolls the row into view, and rings it once. The
  // arrival CONSUMES `?focus=` (the timer rides a ref, in the scroll effect
  // below, so consuming it cannot cancel its own clear): a stale focus left in
  // the URL would clear a typed search and re-ring on every later
  // Single→Stacked toggle, and the page can point but never nags. A re-jump
  // to the same stack re-arms the param (undefined → id is a real change), so
  // it still scrolls and rings.
  useEffect(() => {
    if (activeView !== "stacked" || !focus) return;
    setQuery("");
    setStackFilter("all");
    setHighlightId(focus);
    void navigate({ search: (s) => ({ ...s, focus: undefined }), replace: true });
  }, [activeView, focus, navigate]);

  useEffect(() => () => clearTimeout(ringTimer.current), []);

  // Scroll AND ring: the triggers are the highlight landing, a RE-jump to the
  // id already ringing (`focus` flips undefined→id→undefined while
  // highlightId no-ops), and the payload arriving. The clear timer ARMS HERE,
  // where the row is proven on screen - not at the URL arrival (round-7
  // review): a cold arrival over a slow uplink used to spend its whole 2.5 s
  // budget while the stacks payload was still in flight, landing on a list
  // where nothing identified the target. `query`/`stackFilter` are NOT
  // triggers: keyed on them, every keystroke during the ring yanked the page
  // back to the ringing row. A settled payload WITHOUT the row (a stale or
  // foreign id) clears the highlight so it cannot re-arm later.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps re-run the scroll after the row renders
  useEffect(() => {
    if (highlightId === null) return;
    const row = document.querySelector(`[data-stack-id="${cssEscape(highlightId)}"]`);
    if (row === null) {
      if (stacksQ.data !== undefined) setHighlightId(null);
      return;
    }
    row.scrollIntoView({ block: "center" });
    clearTimeout(ringTimer.current);
    ringTimer.current = setTimeout(() => setHighlightId(null), 2500);
  }, [highlightId, focus, stacksQ.data]);

  function jumpToStack(s: StackRow) {
    setStacksPanel(null);
    const isOwn = stacksView.own.some((x) => x.id === s.id);
    // ONE navigate with the full landing: Stacked, the tab that holds the
    // row, and the focus id the arrival effect reads (and then consumes).
    void navigate({ search: { view: "stacked", tab: isOwn ? undefined : "shared", focus: s.id } });
  }

  async function toggleShared(row: OwnPromptRow) {
    setActionError(null);
    try {
      await update.mutateAsync({ id: row.id, draft: { ...promptDraftFromRow(row), shared: !row.shared } });
    } catch (err) {
      setActionError(errMessage(err, "The share setting could not be changed"));
    }
  }

  async function removePrompt(row: OwnPromptRow) {
    setActionError(null);
    const inStacks = stacksForPrompt(row.id).length;
    const ok = await confirmAction({
      title: `Delete prompt "${row.description}"?`,
      description:
        inStacks > 0
          ? `It leaves the ${inStacks} ${inStacks === 1 ? "stack" : "stacks"} it is in. Nothing already launched is affected, and this cannot be undone.`
          : "Nothing already launched is affected, and this cannot be undone.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await remove.mutateAsync(row.id);
    } catch (err) {
      setActionError(errMessage(err, "Failed to delete prompt"));
    }
  }

  async function toggleStackShared(stack: StackRow) {
    setActionError(null);
    try {
      // The flag ALONE rides the PUT: a share flip is not a membership edit,
      // and re-sending the visible members would rewrite the set (members the
      // caller cannot see are absent from that copy - a rewrite would drop
      // rows the re-share rule promises to keep).
      await stackUpdate.mutateAsync({ id: stack.id, patch: { shared: !("shared" in stack && stack.shared) } });
    } catch (err) {
      setActionError(errMessage(err, "The share setting could not be changed"));
    }
  }

  async function removeStack(stack: StackRow) {
    setActionError(null);
    const ok = await confirmAction({
      title: `Delete stack "${stack.label}"?`,
      description: "The prompts themselves are kept. This cannot be undone.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await stackRemove.mutateAsync(stack.id);
    } catch (err) {
      setActionError(errMessage(err, "Failed to delete stack"));
    }
  }

  const openStackEdit = (stack: StackRow) =>
    setStackDialog({
      editingId: stack.id,
      initial: {
        label: stack.label,
        blocks: stackBlocksFromItems(stack.items),
        shared: "shared" in stack ? stack.shared : false,
      },
    });

  /** A member's Edit (spec 2026-09-29): a reference opens the prompt editor
   *  (stacks reference live rows, the edit shows through here); the stack's
   *  own inline text has no row to edit, so the stack editor opens instead. */
  const editMember = (item: StackItemRow) => {
    if (item.promptId) {
      const row = view.own.find((p) => p.id === item.promptId);
      if (row) setEditSource({ row, clone: false });
      return;
    }
    const parent = stacksView.own.find((s) => s.items.some((i) => i.id === item.id));
    if (parent) openStackEdit(parent);
  };
  const canEditMember = (item: StackItemRow): boolean =>
    item.promptId ? view.own.some((p) => p.id === item.promptId) : activeTab === "own";

  /** The stack's NON-copy actions, by ownership: a reader gets nothing here
   *  (Copy is the inline icon button, which can flash); the owner edits, shares
   *  and deletes. ONE definition so the Stacked row's menu and the "In N
   *  stacks" disclosure's menu can never drift. */
  const stackMenuItems = (s: StackRow): ActionItem[] => {
    const isOwn = stacksView.own.some((x) => x.id === s.id);
    if (!isOwn) return [];
    const shared = "shared" in s && s.shared;
    return [
      { label: "Edit", icon: Pencil, onSelect: () => openStackEdit(s) },
      shared
        ? { label: "Stop sharing", icon: ShieldOff, onSelect: () => void toggleStackShared(s) }
        : { label: "Share with everyone", icon: Share2, onSelect: () => void toggleStackShared(s) },
      { label: "Delete", icon: Trash2, destructive: true, onSelect: () => void removeStack(s) },
    ];
  };

  // Which of the two kinds the active view shows. All shows both; Single and
  // Stacked show one. Loading/error/empty are then the union over what shows.
  const showPrompts = activeView !== "stacked";
  const showStacks = activeView !== "single";

  const isLoading = (showPrompts && prompts.isLoading) || (showStacks && stacksQ.isLoading);
  // The banner names the feed that ACTUALLY failed, not the view's nominal
  // kind: in All with only the stacks fetch down, "Couldn't load prompts."
  // blamed the list that loaded fine while the vanished stacks went unexplained
  // (round-3 review). Retry re-asks just the failed ones (the third nit).
  const shownPromptsFailed = showPrompts && prompts.isError;
  const shownStacksFailed = showStacks && stacksQ.isError;
  const isError = shownPromptsFailed || shownStacksFailed;
  const errorText =
    shownPromptsFailed && shownStacksFailed
      ? "Couldn't load prompts or stacks."
      : shownStacksFailed
        ? "Couldn't load stacks."
        : "Couldn't load prompts.";
  const retry = () => {
    if (prompts.isError) void prompts.refetch();
    if (stacksQ.isError) void stacksQ.refetch();
  };
  // "Empty library" is about the UNFILTERED counts of the kinds this view
  // shows; the "no matches" line is about the filtered ones it hides.
  const promptsShown = activeTab === "own" ? own : shared;
  const stacksShown = activeTab === "own" ? ownStacks : sharedStacks;
  // The member-Edit degradation is not a tab question (round-6 review):
  // canEditMember offers member Edit on ANY tab for a reference pointing at
  // one of MY prompts, and that gate reads the prompts feed - so when the
  // feed is down, a SHOWN reference member on either tab may have lost its
  // Edit, and Stacked renders no prompts banner to say why. Where no
  // reference is on screen there is nothing the failure could have taken,
  // and the sentence stays off (the round-5 over-correction kept it off even
  // where it had taken something).
  const refetchFailed =
    activeView === "stacked" &&
    prompts.isError &&
    stacksShown.some((s) => s.items.some((i) => i.promptId !== undefined));
  // In Single the stacks query feeds only the rows' "In N stacks" chips, so
  // its failure renders no banner (the view shows prompts) - but the counts
  // would silently vanish. One honest line says so.
  const chipsFeedMissing = activeView === "single" && stacksQ.isError;
  const promptsTotal = activeTab === "own" ? view.own.length : view.shared.length;
  const stacksTotal = activeTab === "own" ? stacksView.own.length : stacksView.shared.length;
  const emptyList = (showPrompts ? promptsTotal : 0) + (showStacks ? stacksTotal : 0) === 0;
  // The "no matches" line belongs to a list that HAS rows and hides them all;
  // with a zero library the "No ... yet" card already answers the screen,
  // and the spec wants the two states to distinguish each other (review fix).
  const shownCount = (showPrompts ? promptsShown.length : 0) + (showStacks ? stacksShown.length : 0);
  // The Empty filter belongs to Stacked/own only (it is about MY recoverable
  // empty stacks); the shared tab never reads it, even if the state survived
  // from the own tab.
  const emptyByFilter = activeView === "stacked" && activeTab === "own" && stackFilter === "empty";
  const emptyFiltered = !emptyList && shownCount === 0 && (query.trim() !== "" || emptyByFilter);

  /** The stack list the row's count chip opens, rendered UNDER the row on BOTH
   *  tabs (an affordance that opens nothing is the dead-control class the
   *  round-1 review closed on the empty-stack sentence). */
  const stacksDisclosure = (promptId: string, inStacks: StackRow[]) =>
    stacksPanel === promptId && inStacks.length > 0 ? (
      // The id the row's count chip names in aria-controls; the panel is
      // mounted only while open, the same posture as the row body expander.
      <div id={`prompt-stacks-${promptId}`} className="rounded-md border bg-muted/40 px-3 py-2">
        <p className="text-detail text-muted-foreground">
          This prompt is a member of {inStacks.length} stack{inStacks.length === 1 ? "" : "s"} you can see:
        </p>
        <ul className="mt-1 space-y-1">
          {inStacks.map((s) => (
            <li key={s.id} className="flex items-center gap-1">
              <button
                type="button"
                className="min-w-0 flex-1 truncate rounded-sm text-left font-strong text-label underline-offset-2 hover:underline"
                onClick={() => jumpToStack(s)}
              >
                {s.label}
              </button>
              <CopyButton text={stackJoinedText(s)} label={s.label} />
              {/* The bare label, like the row's own menu: ActionsMenu supplies
                  the "Actions for" prefix, so naming it "X actions" here would
                  announce "Actions for X actions" (round-4 review). */}
              {stackMenuItems(s).length > 0 && <ActionsMenu label={s.label} items={stackMenuItems(s)} />}
            </li>
          ))}
        </ul>
      </div>
    ) : null;

  const promptRows = (
    <div className="space-y-2">
      {activeTab === "own" &&
        own.map((p) => {
          const inStacks = stacksForPrompt(p.id);
          return (
            <div key={p.id} className="space-y-1">
              <PromptPageRow
                description={p.description}
                body={p.body}
                updatedAt={p.updatedAt}
                badge={p.shared ? "shared" : undefined}
                stacks={{
                  count: inStacks.length,
                  open: stacksPanel === p.id,
                  onToggle: () => setStacksPanel(stacksPanel === p.id ? null : p.id),
                  panelId: `prompt-stacks-${p.id}`,
                }}
                items={[
                  { label: "Edit", icon: Pencil, onSelect: () => setEditSource({ row: p, clone: false }) },
                  { label: "Clone", icon: Copy, onSelect: () => setEditSource({ row: p, clone: true }) },
                  p.shared
                    ? { label: "Stop sharing", icon: ShieldOff, onSelect: () => void toggleShared(p) }
                    : { label: "Share with everyone", icon: Share2, onSelect: () => void toggleShared(p) },
                  { label: "Delete", icon: Trash2, destructive: true, onSelect: () => void removePrompt(p) },
                ]}
              />
              {stacksDisclosure(p.id, inStacks)}
            </div>
          );
        })}
      {activeTab === "shared" &&
        shared.map((p: SharedPromptRow) => {
          const inStacks = stacksForPrompt(p.id);
          return (
            <div key={p.id} className="space-y-1">
              <PromptPageRow
                description={p.description}
                body={p.body}
                updatedAt={p.updatedAt}
                badge={p.ownerName}
                stacks={{
                  count: inStacks.length,
                  open: stacksPanel === p.id,
                  onToggle: () => setStacksPanel(stacksPanel === p.id ? null : p.id),
                  panelId: `prompt-stacks-${p.id}`,
                }}
                items={[]}
              />
              {stacksDisclosure(p.id, inStacks)}
            </div>
          );
        })}
    </div>
  );

  const stackRows = (
    <div className="space-y-2">
      {(activeTab === "own" ? ownStacks : sharedStacks).map((s) => (
        <StackPageRow
          key={s.id}
          stack={s}
          badge={"shared" in s && s.shared ? "shared" : "ownerName" in s ? s.ownerName : undefined}
          highlight={highlightId === s.id}
          canEditStack={activeTab === "own"}
          canEditMember={canEditMember}
          onEditMember={editMember}
          items={stackMenuItems(s)}
        />
      ))}
    </div>
  );

  return (
    <main className="mx-auto w-full max-w-4xl space-y-6 p-6">
      <PageHeader
        title="Prompts"
        subtitle="Saved prompts for subshell injection"
        action={
          // One "New" (operator ruling 2026-09-29: the two-button pair read
          // as clutter). The dropdown carries the KIND choice; the per-view
          // rule survives inside it, and both create dialogs are untouched.
          // Shared tab renders no create action, as before.
          activeTab === "own" ? (
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button />}>
                <Plus /> New
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {activeView !== "stacked" && (
                  <DropdownMenuItem onSelect={() => setShowCreate(true)}>
                    <MessageSquareText className="h-4 w-4" /> New prompt
                  </DropdownMenuItem>
                )}
                {activeView !== "single" && (
                  <DropdownMenuItem onSelect={() => setStackDialog({})}>
                    <Layers className="h-4 w-4" /> New stack
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : undefined
        }
      />

      <Segmented
        ariaLabel="Prompts or stacks"
        options={[
          { value: "all", label: "All" },
          { value: "single", label: "Single" },
          { value: "stacked", label: "Stacked" },
        ]}
        value={activeView}
        onChange={(v) => go({ view: v as PageView })}
        fill={false}
      />

      <Segmented
        ariaLabel="Prompts tab"
        options={[
          {
            value: "own",
            label:
              activeView === "all"
                ? `Yours (${view.own.length + stacksView.own.length})`
                : activeView === "stacked"
                  ? `Your stacks (${stacksView.own.length})`
                  : `Your prompts (${view.own.length})`,
          },
          {
            value: "shared",
            label:
              activeView === "all"
                ? `Shared with you (${view.shared.length + stacksView.shared.length})`
                : activeView === "stacked"
                  ? `Shared with you (${stacksView.shared.length})`
                  : `Shared with you (${view.shared.length})`,
          },
        ]}
        value={activeTab}
        onChange={(v) => go({ tab: v as PromptsTab })}
        fill={false}
      />

      <div className="flex flex-wrap items-center gap-3">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={
            activeView === "all"
              ? "Search prompts and stacks"
              : activeView === "stacked"
                ? "Search stacks"
                : "Search prompts"
          }
          aria-label={
            activeView === "all"
              ? "Search prompts and stacks"
              : activeView === "stacked"
                ? "Search stacks"
                : "Search prompts"
          }
          className="max-w-sm"
        />
        {activeView === "stacked" && activeTab === "own" && (
          <Segmented
            ariaLabel="Stack filter"
            options={[
              { value: "all", label: "All" },
              { value: "empty", label: "Empty" },
            ]}
            value={stackFilter}
            onChange={(v) => setStackFilter(v as "all" | "empty")}
            fill={false}
          />
        )}
      </div>

      {actionError && (
        <p role="alert" className="text-destructive text-detail">
          {actionError}
        </p>
      )}

      {showCreate && <PromptFormDialog open onOpenChange={(next) => !next && setShowCreate(false)} />}
      {editSource && (
        <PromptFormDialog
          key={editSource.row.id + String(editSource.clone)}
          open
          onOpenChange={(next) => !next && setEditSource(null)}
          editingId={editSource.clone ? undefined : editSource.row.id}
          initial={{
            ...promptDraftFromRow(editSource.row),
            // A clone is always born unshared: sharing is its own decision.
            ...(editSource.clone
              ? { shared: false, description: suggestCloneDescription(view.own, editSource.row) }
              : {}),
          }}
        />
      )}
      {stackDialog && (
        <StackFormDialog
          key={stackDialog.editingId ?? "new"}
          open
          onOpenChange={(next) => !next && setStackDialog(null)}
          editingId={stackDialog.editingId}
          initial={stackDialog.initial}
        />
      )}

      {isLoading && <p className="text-muted-foreground text-sm">Loading…</p>}
      {isError && (
        <ErrorBanner
          message={errorText}
          className="rounded-md border"
          action={
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0 text-detail text-inherit underline"
              onClick={() => void retry()}
            >
              Retry
            </Button>
          }
        />
      )}
      {refetchFailed && !isLoading && !isError && (
        <p role="alert" className="text-destructive text-detail">
          The prompts list could not be loaded, so editing a stack member that points at one is unavailable.
        </p>
      )}
      {chipsFeedMissing && !isLoading && !isError && (
        <p className="text-detail text-muted-foreground">
          The stacks list could not be loaded, so membership counts are hidden.
        </p>
      )}

      {!isLoading && !isError && emptyList && activeTab === "own" && (
        <EmptyState
          icon={activeView === "stacked" ? Layers : MessageSquareText}
          title={
            activeView === "stacked"
              ? "No stacks yet"
              : activeView === "single"
                ? "No prompts yet"
                : "No prompts or stacks yet"
          }
          description={
            activeView === "stacked"
              ? "A stack is a named, ordered set of prompts a subshell receives as one text. Deleting a prompt later removes it from the stacks it is in."
              : activeView === "all"
                ? undefined
                : "A prompt is saved text you can type into a new subshell or inject into a running one. The description is required; it is what the list shows."
          }
          actionLabel={activeView === "stacked" ? "Create your first stack" : "Create your first prompt"}
          onAction={() => (activeView === "stacked" ? setStackDialog({}) : setShowCreate(true))}
        />
      )}
      {!isLoading && !isError && emptyList && activeTab === "shared" && (
        <EmptyState
          icon={Share2}
          title="Nothing shared yet"
          description={
            activeView === "all"
              ? "Prompts and stacks other accounts share with everyone land here."
              : activeView === "stacked"
                ? "Stacks other accounts share with everyone land here."
                : "Prompts other accounts share with everyone land here."
          }
        />
      )}
      {!isLoading && emptyFiltered && (
        <p className="text-detail text-muted-foreground">
          {emptyByFilter
            ? query.trim() !== ""
              ? "No empty stacks match the search."
              : "No empty stacks right now."
            : activeView === "all"
              ? "No prompts or stacks match the search."
              : activeView === "stacked"
                ? "No stacks match the search."
                : "No prompts match the search."}
        </p>
      )}

      {/* All is the combined overview: the caller's stacks over their singles,
          each kind its own spaced group so the two never blur into one run. */}
      {activeView === "all" ? (
        <div className="space-y-6">
          {stacksShown.length > 0 && stackRows}
          {promptsShown.length > 0 && promptRows}
        </div>
      ) : activeView === "stacked" ? (
        stackRows
      ) : (
        promptRows
      )}
    </main>
  );
}

/** The stack ids are uuids (safe selectors), but the focus param is a URL
 *  string: escape before interpolating it into a selector. */
function cssEscape(value: string): string {
  return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, "");
}
