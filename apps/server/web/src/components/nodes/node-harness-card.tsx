import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { nodePluginErrorMessage, useHarnesses, useNodeHarnesses, useSetNodePlugin } from "@/hooks/use-harnesses";
import { checkedAtLabel } from "@/lib/checked-at";

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
            This node hasn't reported any plugins. If it's running an older agent, update it; otherwise install one
            below.
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
                <Badge variant={h.installed ? "success" : "muted"}>{h.installed ? "ready" : "program not found"}</Badge>
                {h.version && <span className="font-mono text-muted-foreground text-xs">{h.version}</span>}
                {checkedAtLabel(h.checkedAt) && (
                  <span className="text-muted-foreground text-xs">{checkedAtLabel(h.checkedAt)}</span>
                )}
                {canManage && (
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

        {canManage && available.length > 0 && (
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
