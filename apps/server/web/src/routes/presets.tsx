import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Pencil, Plus, SlidersHorizontal, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { EmptyState } from "@/components/empty-state";
import { ErrorBanner } from "@/components/error-banner";
import { PageHeader } from "@/components/page-header";
import { CreatePresetDialog } from "@/components/presets/create-preset-dialog";
import { PresetListRow } from "@/components/presets/preset-list-row";
import { Button } from "@/components/ui/button";
import { useInstancePlugins } from "@/hooks/use-instance-plugins";
import { useInvalidatePresets, usePresets } from "@/hooks/use-presets";
import { apiFetch, errMessage } from "@/lib/api";
import { confirmAction } from "@/lib/confirm";
import type { PresetRow } from "@/types/preset";

export const Route = createFileRoute("/presets")({
  component: PresetsPage,
});

/** Presets under their agent's header, agents in catalog order. Rows whose
 *  harness is not (or no longer) in the catalog group last, keyed by id,
 *  rather than vanishing with the plugin view that failed to name them. */
function groupByHarness(presets: PresetRow[], pluginOrder: string[]): [string, PresetRow[]][] {
  const byHarness = new Map<string, PresetRow[]>();
  for (const p of presets) {
    const bucket = byHarness.get(p.harnessId);
    if (bucket) bucket.push(p);
    else byHarness.set(p.harnessId, [p]);
  }
  const ordered: [string, PresetRow[]][] = [];
  for (const id of pluginOrder) {
    const bucket = byHarness.get(id);
    if (bucket) {
      ordered.push([id, bucket]);
      byHarness.delete(id);
    }
  }
  for (const [id, bucket] of byHarness) ordered.push([id, bucket]);
  return ordered;
}

function PresetsPage() {
  const navigate = useNavigate();
  const invalidate = useInvalidatePresets();
  const { data: presets, isLoading, isError, refetch } = usePresets();
  const { data: pluginData } = useInstancePlugins();
  const plugins = pluginData?.plugins ?? [];

  const [showCreate, setShowCreate] = useState(false);
  // The delete failure belongs on the page — with the row menu closed and no
  // dialog up, anywhere else would render a failed delete nowhere at all.
  const [listError, setListError] = useState<string | null>(null);

  const groups = useMemo(
    () =>
      groupByHarness(
        presets ?? [],
        plugins.map((p) => p.id),
      ),
    [presets, plugins],
  );

  async function deletePreset(id: string) {
    const ok = await confirmAction({
      title: "Delete this preset?",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      setListError(null);
      await apiFetch(`/api/presets/${id}`, { method: "DELETE" });
      await invalidate();
    } catch (err) {
      setListError(errMessage(err, "Failed to delete preset"));
    }
  }

  return (
    <main className="mx-auto w-full max-w-4xl space-y-6 p-6">
      <PageHeader
        title="Presets"
        subtitle="Saved launch settings, per agent"
        action={
          <Button onClick={() => setShowCreate(true)}>
            <Plus /> New preset
          </Button>
        }
      />

      {listError && <p className="text-destructive text-sm">{listError}</p>}

      {/* A dialog rather than a card that pushes the list down the page
          (user report 2026-09-11): creating a preset is a decision with an
          end, and the list behind it is the thing being added to. Same shape
          as every other "new X" in the app — the launch dialog, the
          workspace dialog, Add a node. The create dialog and the inline one
          in the launch form are the SAME component, unlocked here. */}
      {showCreate && <CreatePresetDialog open onOpenChange={(next) => !next && setShowCreate(false)} />}

      {isLoading && <p className="text-muted-foreground text-sm">Loading…</p>}

      {/* A failed list load is not an empty account: say so, and offer the
          retry the old silent blank denied. */}
      {isError && (
        <ErrorBanner
          message="Couldn't load presets."
          className="rounded-md border"
          action={
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0 text-inherit text-xs underline"
              onClick={() => void refetch()}
            >
              Retry
            </Button>
          }
        />
      )}

      {!isLoading && !isError && presets?.length === 0 && !showCreate && (
        <EmptyState
          icon={SlidersHorizontal}
          title="No presets yet"
          description="A preset is saved launch settings for one agent: env vars, flags, and whether its subshells restart themselves. You can always start a subshell without one."
          actionLabel="Create your first preset"
          onAction={() => setShowCreate(true)}
        />
      )}

      {/* Rows grouped under their agent (icon + plugin name, fallback
          harnessId — the same reading grammar everywhere the catalog might
          not know a row's harness). The binary for the launch-command
          preview comes from the plugin row; an unknown harness falls back to
          its id so the row still renders something honest. */}
      {groups.length > 0 && (
        <div className="space-y-6">
          {groups.map(([harnessId, rows]) => {
            const plugin = plugins.find((p) => p.id === harnessId);
            return (
              <div key={harnessId} className="space-y-2">
                {/* A real heading, not styled text: the e2e group-header probe
                    queries by role because a presetless row's launch-command
                    preview renders the bare harness id — text matching would
                    collide. PageHeader carries the h1; these are the h2s. */}
                <div className="flex items-center gap-2">
                  <span aria-hidden className="text-base">
                    {plugin?.icon ?? "🤖"}
                  </span>
                  <h2 className="font-medium text-sm">{plugin?.name ?? harnessId}</h2>
                </div>
                {rows.map((p) => (
                  <PresetListRow
                    key={p.id}
                    preset={p}
                    binary={plugin?.binary ?? harnessId}
                    items={[
                      {
                        label: "Edit",
                        icon: Pencil,
                        onSelect: () => void navigate({ to: "/presets/$id", params: { id: p.id } }),
                      },
                      {
                        label: "Delete preset",
                        icon: Trash2,
                        destructive: true,
                        onSelect: () => void deletePreset(p.id),
                      },
                    ]}
                  />
                ))}
              </div>
            );
          })}
        </div>
      )}
    </main>
  );
}
