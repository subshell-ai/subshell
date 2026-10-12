import { apiFetch, Button, Card, CardContent, CardHeader, confirmAction, errMessage } from "@internal/node-admin";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Copy, Pencil, Plus, SlidersHorizontal, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { DashboardPage } from "@/components/dashboard-page";
import { EmptyState } from "@/components/empty-state";
import { ErrorBanner } from "@/components/error-banner";
import { PageHeader } from "@/components/page-header";
import { PluginIcon } from "@/components/plugin-icon";
import { CreatePresetDialog } from "@/components/presets/create-preset-dialog";
import { PresetTableRow } from "@/components/presets/preset-table-row";
import { useInstancePlugins } from "@/hooks/use-instance-plugins";
import { useInvalidatePresets, usePresets } from "@/hooks/use-presets";
import { presetFormFromRow, suggestCloneName } from "@/lib/preset-form";
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
  // The row whose Clone dialog is open; the dialog mounts only while set
  // (clone-dialog posture), so every open re-seeds from the then-current row.
  const [cloneSource, setCloneSource] = useState<PresetRow | null>(null);
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
    <DashboardPage>
      <PageHeader
        title="Presets"
        subtitle="Saved launch settings, per agent"
        action={
          <Button onClick={() => setShowCreate(true)}>
            <Plus /> New preset
          </Button>
        }
      />

      {listError && <p className="text-destructive text-detail">{listError}</p>}

      {/* A dialog rather than a card that pushes the list down the page
          (user report 2026-09-11): creating a preset is a decision with an
          end, and the list behind it is the thing being added to. Same shape
          as every other "new X" in the app — the launch dialog, the
          workspace dialog, Add a node. The create dialog and the inline one
          in the launch form are the SAME component, unlocked here. */}
      {showCreate && <CreatePresetDialog open onOpenChange={(next) => !next && setShowCreate(false)} />}

      {cloneSource && (
        <CreatePresetDialog
          open
          onOpenChange={(next) => !next && setCloneSource(null)}
          initialForm={{
            ...presetFormFromRow(cloneSource),
            name: suggestCloneName(presets ?? [], cloneSource),
          }}
        />
      )}

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
              className="h-auto p-0 text-detail text-inherit underline"
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
        <div className="flex flex-col gap-6">
          {groups.map(([harnessId, rows]) => {
            const plugin = plugins.find((p) => p.id === harnessId);
            return (
              <Card key={harnessId} className="min-w-0">
                {/* A real heading, not styled text: the e2e group-header probe
                    queries by role because a presetless row's launch-command
                    preview renders the bare harness id — text matching would
                    collide. PageHeader carries the h1; these are the h2s. */}
                <CardHeader className="flex-row items-center gap-2 space-y-0">
                  <PluginIcon pluginId={harnessId} name={plugin?.name} />
                  <h2 className="font-strong text-sm">{plugin?.name ?? harnessId}</h2>
                </CardHeader>
                <CardContent>
                  <div className="@container overflow-x-auto">
                    <table className="w-full text-sm" aria-label={`${plugin?.name ?? harnessId} presets`}>
                      <thead>
                        <tr className="border-b text-left text-muted-foreground">
                          <th scope="col" className="pr-4 pb-2 font-strong">
                            Name
                          </th>
                          <th scope="col" className="@sm:table-cell hidden whitespace-nowrap pr-4 pb-2 font-strong">
                            Auto-restart
                          </th>
                          <th scope="col" className="@lg:table-cell hidden whitespace-nowrap pr-4 pb-2 font-strong">
                            Cross-agent use
                          </th>
                          <th scope="col" className="pb-2 text-right font-strong">
                            <span className="sr-only">Actions</span>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((p) => (
                          <PresetTableRow
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
                                label: "Clone preset",
                                icon: Copy,
                                onSelect: () => setCloneSource(p),
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
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </DashboardPage>
  );
}
