import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { type InstancePluginRow, useSetPluginEnabled } from "@/hooks/use-instance-plugins";
import { errMessage } from "@/lib/api";

/**
 * The installed half of the instance page (spec 2026-09-10 §6.1): each row
 * carries where its bytes came from (this build or npm), its version, an
 * Enabled switch and an Uninstall, and a broken plugin says why on its face
 * rather than presenting as an unexplained launch failure. For a non-admin
 * the same rows render read-only: the list is every authenticated actor's
 * read, the controls are the admin's.
 */
export function InstalledPluginsCard({
  plugins,
  canManage,
  onUninstall,
}: {
  /** The rows with `installed: true`, id-sorted as the server sends them */
  plugins: InstancePluginRow[];
  /** Cookie-admin, from the server-derived `viewerIsAdmin` */
  canManage: boolean;
  /** Opens the uninstall dialog for this row */
  onUninstall: (plugin: InstancePluginRow) => void;
}) {
  const setEnabled = useSetPluginEnabled();
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});

  return (
    <Card>
      <CardHeader>
        <CardTitle>Installed</CardTitle>
        <CardDescription>
          What this control plane offers its nodes. The bytes live on the control plane, so one install arms every node.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {plugins.length === 0 && <p className="text-muted-foreground text-sm">Nothing installed yet.</p>}
        {plugins.map((p) => (
          <div key={p.id} className="space-y-2 rounded-lg border p-3">
            <div className="flex flex-wrap items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="font-medium">{p.name}</p>
                <p className="text-muted-foreground text-xs">
                  {[p.id, p.version ? `v${p.version}` : undefined, p.binary ? `drives ${p.binary}` : undefined]
                    .filter((s): s is string => s !== undefined)
                    .join(" · ")}
                </p>
              </div>
              <Badge variant={p.builtIn ? "muted" : "outline"}>{p.builtIn ? "this build" : "npm"}</Badge>
              {canManage ? (
                <Switch
                  checked={p.enabled}
                  aria-label={`${p.name} enabled`}
                  disabled={setEnabled.isPending}
                  onCheckedChange={(checked) =>
                    setEnabled.mutate(
                      { id: p.id, enabled: checked },
                      {
                        onError: (err) =>
                          setRowErrors((prev) => ({ ...prev, [p.id]: errMessage(err, "The change was not saved.") })),
                      },
                    )
                  }
                />
              ) : (
                <Badge variant={p.enabled ? "success" : "warning"}>{p.enabled ? "enabled" : "disabled"}</Badge>
              )}
              {canManage && (
                <Button variant="ghost" size="sm" onClick={() => onUninstall(p)}>
                  Uninstall {p.name}
                </Button>
              )}
            </div>
            {p.description && <p className="text-muted-foreground text-sm">{p.description}</p>}
            {/* A broken install keeps its row precisely so it can say this;
                every launch of it fails, and the operator needs to know why. */}
            {p.broken && <p className="text-destructive text-xs">Not loaded: {p.broken}</p>}
            {rowErrors[p.id] && <p className="text-destructive text-xs">{rowErrors[p.id]}</p>}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
