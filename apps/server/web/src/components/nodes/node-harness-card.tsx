import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { nodePluginErrorMessage, useHarnesses, useNodeHarnesses, useSetNodePlugin } from "@/hooks/use-harnesses";
import { checkedAtLabel } from "@/lib/checked-at";

/** The row's one-word verdict: not usable, ready, or its program is missing. */
function badgeLabel(h: { installed: boolean; broken?: string; reason?: string }): string {
  if (h.broken) return "not usable";
  return h.installed || h.reason === "no-binary" ? "ready" : "program not found";
}

/** The tone that verdict carries. */
function badgeVariant(h: { installed: boolean; broken?: string; reason?: string }): "success" | "warning" | "muted" {
  if (h.broken) return "warning";
  return h.installed || h.reason === "no-binary" ? "success" : "muted";
}

/**
 * The plugins one node has installed (spec 2026-09-09 §6).
 *
 * The rows are the NODE's own declaration, not this control plane's idea of
 * what exists: a node can offer a plugin this build has never heard of, and a
 * node that has never reported shows nothing rather than a list invented here.
 *
 * There is no enable switch, because there is no enable. A plugin being
 * installed on the node IS it being offered there, so the actions are Install
 * and Remove. Both are OWNER-only and both are sent to a live node: an offline
 * one is refused rather than queued, so this page can never show a plugin the
 * node is not actually running.
 *
 * Two different facts share each row and must stay legible apart: the node has
 * the PLUGIN, and the plugin's BINARY was detected there. A node can have the
 * claude-code plugin and no `claude` on its PATH.
 */
export function NodeHarnessCard({ nodeId, canManage }: { nodeId: string; canManage: boolean }) {
  const { harnesses, data, isLoading } = useNodeHarnesses(nodeId);
  // The catalog this build knows about, used only to offer installs and to
  // name a row. A row whose id is absent from it still renders, by id.
  const { data: catalog } = useHarnesses();
  const setPlugin = useSetNodePlugin(nodeId);
  const [errors, setErrors] = useState<Record<string, string>>({});

  function change(pluginId: string, installed: boolean) {
    setErrors((prev) => ({ ...prev, [pluginId]: "" }));
    setPlugin.mutate(
      { pluginId, installed },
      { onError: (err) => setErrors((prev) => ({ ...prev, [pluginId]: nodePluginErrorMessage(err) })) },
    );
  }

  if (isLoading) return <p className="text-muted-foreground text-sm">Loading…</p>;

  const installedIds = new Set(harnesses.map((h) => h.harnessId));
  const available = (catalog ?? []).filter((c) => !installedIds.has(c.id));
  // `local` included. It has its own plugins directory now and this same route
  // installs to it (spec 2026-09-09 §11), so suppressing the controls here
  // left the host's own page saying "install one below" with nothing below.
  const actionable = canManage;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Plugins</CardTitle>
        <CardDescription>
          What this machine offers. A plugin is installed on the node itself, so this list is the node's own answer
          rather than a setting stored here.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {data?.inventoryStale && (
          <p className="text-muted-foreground text-sm">
            The inventory may be outdated. Installed states are last-known, not live. Run a re-check to refresh.
          </p>
        )}

        {harnesses.length === 0 && (
          <p className="text-muted-foreground text-sm">
            This node hasn't reported any plugins yet. If it has just enrolled, its first report is on the way;
            otherwise install one below.
          </p>
        )}

        {harnesses.map((h) => {
          const name = catalog?.find((c) => c.id === h.harnessId)?.name ?? h.harnessId;
          return (
            <div key={h.harnessId} className="space-y-1">
              <div className="flex flex-wrap items-center gap-3">
                <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
                {/* The plugin is installed; whether its program is present is
                    a separate fact, and the badge is about that one. */}
                {/* Three states, not two. A plugin that declares no program is
                    not one whose program is missing, and a broken plugin is
                    neither: badging all three "program not found" put a
                    negative right above the sentence explaining it away. */}
                <Badge variant={badgeVariant(h)}>{badgeLabel(h)}</Badge>
                {h.version && <span className="font-mono text-muted-foreground text-xs">{h.version}</span>}
                {checkedAtLabel(h.checkedAt) && (
                  <span className="text-muted-foreground text-xs">{checkedAtLabel(h.checkedAt)}</span>
                )}
                {actionable && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={setPlugin.isPending}
                    onClick={() => change(h.harnessId, false)}
                  >
                    Remove
                  </Button>
                )}
              </div>
              {h.broken && (
                <p role="alert" className="text-destructive text-xs">
                  This node could not load the plugin: {h.broken}
                </p>
              )}
              {/* No version number in this sentence. The one on this row is
                  the PROGRAM's (`claude --version`), not the plugin's, so
                  naming it here pointed at something the upgrade did not
                  change, and rendered "Version  is installed" whenever the
                  program was absent.

                  Shown for a broken plugin too, and that case is the reason
                  the notice earns its place: a plugin that threw on load keeps
                  throwing the cached error until the agent restarts, so the
                  row would otherwise show a failure already fixed on disk. */}
              {h.restartRequired && (
                <p className="text-muted-foreground text-xs">
                  {h.broken
                    ? "A newer copy is installed and may already fix this. Restart the agent to load it."
                    : "A newer copy is installed than the one this node is running. Restart the agent to finish the upgrade."}
                </p>
              )}
              {h.reason === "override-invalid" && (
                <p className="text-muted-foreground text-xs">
                  An environment variable overrides where this program is looked for, and it doesn't point at an
                  executable file on this node.
                </p>
              )}
              {h.reason === "no-binary" && (
                <p className="text-muted-foreground text-xs">This plugin needs no separate program installed.</p>
              )}
              {errors[h.harnessId] && (
                <p role="alert" className="text-destructive text-xs">
                  {errors[h.harnessId]}
                </p>
              )}
            </div>
          );
        })}

        {actionable && available.length > 0 && (
          <div className="space-y-2 border-t pt-3">
            <p className="text-muted-foreground text-xs">Add a plugin</p>
            {available.map((c) => (
              <div key={c.id} className="flex flex-wrap items-center gap-3">
                <span className="min-w-0 flex-1 truncate text-sm">{c.name}</span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={setPlugin.isPending}
                  onClick={() => change(c.id, true)}
                >
                  Install
                </Button>
                {errors[c.id] && (
                  <p role="alert" className="w-full text-destructive text-xs">
                    {errors[c.id]}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
