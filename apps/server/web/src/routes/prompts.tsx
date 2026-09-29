import { Button, confirmAction, errMessage, Input } from "@internal/node-admin";
import { createFileRoute } from "@tanstack/react-router";
import { Copy, MessageSquareText, Pencil, Plus, Share2, ShieldOff, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { EmptyState } from "@/components/empty-state";
import { ErrorBanner } from "@/components/error-banner";
import { PageHeader } from "@/components/page-header";
import { PromptFormDialog } from "@/components/prompts/prompt-form-dialog";
import { PromptPageRow } from "@/components/prompts/prompt-page-row";
import { Segmented } from "@/components/ui/segmented";
import { useDeletePrompt, usePrompts, useUpdatePrompt } from "@/hooks/use-prompts";
import { promptDraftFromRow, suggestCloneDescription } from "@/lib/prompt-form";
import { matchesPromptQuery, type OwnPromptRow, type PromptsView, type SharedPromptRow } from "@/lib/prompts";

/**
 * Prompts (spec 2026-09-28): the saved-prompt library. Two tabs because the
 * list answers two different questions (what do I have, what did others hand
 * me); the URL carries the tab so a link lands where it names (the nodes
 * page's rule). Search is client-side: these are small per-user lists, the
 * accepted no-pagination posture.
 */

const PROMPTS_TABS = [
  { value: "own", label: "Your prompts" },
  { value: "shared", label: "Shared with you" },
] as const;

type PromptsTab = (typeof PROMPTS_TABS)[number]["value"];

export const Route = createFileRoute("/prompts")({
  component: PromptsPage,
  validateSearch: (search: Record<string, unknown>): { tab?: PromptsTab } =>
    search.tab === "shared" ? { tab: "shared" } : {},
});

function PromptsPage() {
  const navigate = Route.useNavigate();
  const { tab } = Route.useSearch();
  const active: PromptsTab = tab ?? "own";
  const { data, isLoading, isError, refetch } = usePrompts();
  const update = useUpdatePrompt();
  const remove = useDeletePrompt();

  const [query, setQuery] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  // One dialog state covers edit and clone (the clone dialog re-seeds on
  // mount, so a stale draft cannot ride into the next open).
  const [editSource, setEditSource] = useState<{ row: OwnPromptRow; clone: boolean } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const view: PromptsView = data ?? { own: [], shared: [] };

  const goTab = (next: PromptsTab) => void navigate({ search: next === "own" ? {} : { tab: next } });

  const own = useMemo(() => view.own.filter((p) => matchesPromptQuery(p, query)), [view.own, query]);
  const shared = useMemo(() => view.shared.filter((p) => matchesPromptQuery(p, query)), [view.shared, query]);

  async function copyBody(body: string) {
    // Silent-but-honest (spec §Error handling): a denied clipboard simply
    // does nothing; it must not strand an unhandled rejection behind `void`.
    await navigator.clipboard.writeText(body).catch(() => {});
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
    const ok = await confirmAction({
      title: `Delete prompt "${row.description}"?`,
      description: "Nothing already launched is affected. This cannot be undone.",
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

  const emptyList = active === "own" ? view.own.length === 0 : view.shared.length === 0;
  // The "no matches" line belongs to a list that HAS rows and hides them all;
  // with a zero library the "No prompts yet" card already answers the screen,
  // and the spec wants the two states to distinguish each other (review fix).
  const emptyFiltered = !emptyList && (active === "own" ? own : shared).length === 0 && query.trim() !== "";

  return (
    <main className="mx-auto w-full max-w-4xl space-y-6 p-6">
      <PageHeader
        title="Prompts"
        subtitle="Saved prompts you can drop into any subshell"
        action={
          active === "own" ? (
            <Button onClick={() => setShowCreate(true)}>
              <Plus /> New prompt
            </Button>
          ) : undefined
        }
      />

      <Segmented
        ariaLabel="Prompts tab"
        options={PROMPTS_TABS.map((t) => ({
          value: t.value,
          label: `${t.label} (${t.value === "own" ? view.own.length : view.shared.length})`,
        }))}
        value={active}
        onChange={goTab}
        fill={false}
      />

      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search prompts"
        aria-label="Search prompts"
        className="max-w-sm"
      />

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

      {isLoading && <p className="text-muted-foreground text-sm">Loading…</p>}
      {isError && (
        <ErrorBanner
          message="Couldn't load prompts."
          className="rounded-md border"
          action={
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0 text-detail text-inherit underline"
              onClick={() => void refetch()}
            >
              Retry
            </Button>
          }
        />
      )}

      {!isLoading && !isError && emptyList && active === "own" && (
        <EmptyState
          icon={MessageSquareText}
          title="No prompts yet"
          description="A prompt is saved text you can type into a new subshell or inject into a running one. The description is required; it is what the list shows."
          actionLabel="Create your first prompt"
          onAction={() => setShowCreate(true)}
        />
      )}
      {!isLoading && !isError && emptyList && active === "shared" && (
        <EmptyState
          icon={Share2}
          title="Nothing shared yet"
          description="Prompts other accounts share with everyone land here."
        />
      )}
      {!isLoading && emptyFiltered && <p className="text-detail text-muted-foreground">No prompts match the search.</p>}

      <div className="space-y-2">
        {active === "own" &&
          own.map((p) => (
            <PromptPageRow
              key={p.id}
              description={p.description}
              body={p.body}
              updatedAt={p.updatedAt}
              badge={p.shared ? "shared" : undefined}
              items={[
                { label: "Copy", icon: Copy, onSelect: () => void copyBody(p.body) },
                { label: "Edit", icon: Pencil, onSelect: () => setEditSource({ row: p, clone: false }) },
                { label: "Clone", icon: Copy, onSelect: () => setEditSource({ row: p, clone: true }) },
                p.shared
                  ? { label: "Stop sharing", icon: ShieldOff, onSelect: () => void toggleShared(p) }
                  : { label: "Share with everyone", icon: Share2, onSelect: () => void toggleShared(p) },
                { label: "Delete", icon: Trash2, destructive: true, onSelect: () => void removePrompt(p) },
              ]}
            />
          ))}
        {active === "shared" &&
          shared.map((p: SharedPromptRow) => (
            <PromptPageRow
              key={p.id}
              description={p.description}
              body={p.body}
              updatedAt={p.updatedAt}
              badge={p.ownerName}
              items={[{ label: "Copy", icon: Copy, onSelect: () => void copyBody(p.body) }]}
            />
          ))}
      </div>
    </main>
  );
}
