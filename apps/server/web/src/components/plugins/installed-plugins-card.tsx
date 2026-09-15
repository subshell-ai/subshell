import { useState } from "react";
import { PluginIcon } from "@/components/plugin-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
      {/* No description: the page header already says what this list is and
          that acting on it is instance-wide. The two sibling cards' captions
          each say where THEIR bytes come from, which this list does per row
          with its source badge. */}
      <CardHeader>
        <CardTitle>Installed</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {plugins.length === 0 && <p className="text-muted-foreground text-sm">Nothing installed yet.</p>}
        {/* A headerless table: ONE grid for the whole list, so the source
            badge, the switch and Uninstall share their tracks and line up
            down the card. Each row was its own bordered flex box before, and
            `auto` sizes per CONTAINER — so every row placed its controls
            wherever that row's own name and version left them, a different x
            in every row. One grid with `auto` tracks sizes each column to its
            widest cell, which is the alignment a table gives and per-row flex
            containers cannot.

            Rows are `display: contents` (the inner wrapper below): the row
            element draws nothing, so its cells are the grid's own children.
            That is also why every cell is ALWAYS rendered, even when empty —
            a skipped cell would slide the rest of that row one column left.

            Two columns below `sm`, four above: the badge, the switch and
            Uninstall fall to a second line on a phone rather than crushing
            the name. */}
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 sm:grid-cols-[minmax(0,1fr)_auto_auto_auto]">
          {plugins.map((p, index) => (
            <div key={p.id} className="contents">
              {/* Spans the full width, so it starts its own grid row and
                  cannot displace a cell: the rows carry no border of their
                  own any more, and a rule between them is what keeps a
                  multi-line row from reading as two. */}
              {index > 0 && <div aria-hidden className="col-span-full border-t" />}
              <div className="flex min-w-0 items-center gap-3">
                <PluginIcon pluginId={p.id} name={p.name} className="size-8" />
                <div className="min-w-0">
                  <p className="truncate font-strong">{p.name}</p>
                  <p className="truncate text-detail text-muted-foreground">
                    {[p.id, p.version ? `v${p.version}` : undefined, p.binary ? `drives ${p.binary}` : undefined]
                      .filter((s): s is string => s !== undefined)
                      .join(" · ")}
                  </p>
                </div>
              </div>
              <Badge variant={p.builtIn ? "muted" : "outline"} className="justify-self-start">
                {p.builtIn ? "this build" : "npm"}
              </Badge>
              {canManage ? (
                <Switch
                  className="justify-self-start"
                  checked={p.enabled}
                  aria-label={`${p.name} enabled`}
                  disabled={setEnabled.isPending}
                  onCheckedChange={(checked) =>
                    setEnabled.mutate(
                      { id: p.id, enabled: checked },
                      {
                        // A later success retires the row's old failure text:
                        // leaving it up reads as "still broken" under a
                        // switch that just moved, and the error IS gone.
                        onSuccess: () =>
                          setRowErrors((prev) => {
                            if (prev[p.id] === undefined) return prev;
                            const { [p.id]: _retired, ...rest } = prev;
                            return rest;
                          }),
                        onError: (err) =>
                          setRowErrors((prev) => ({ ...prev, [p.id]: errMessage(err, "The change was not saved.") })),
                      },
                    )
                  }
                />
              ) : (
                <Badge variant={p.enabled ? "success" : "warning"} className="justify-self-start">
                  {p.enabled ? "enabled" : "disabled"}
                </Badge>
              )}
              {/* Always a cell, even for a reader who manages nothing — an
                  omitted one would pull this row's earlier cells rightwards
                  out of their columns. */}
              {canManage ? (
                <Button variant="ghost" size="sm" className="justify-self-end" onClick={() => onUninstall(p)}>
                  Uninstall {p.name}
                </Button>
              ) : (
                <span />
              )}
              {p.description && <p className="col-span-full text-detail text-muted-foreground">{p.description}</p>}
              {/* A broken install keeps its row precisely so it can say this;
                  every launch of it fails, and the operator needs to know why. */}
              {p.broken && <p className="col-span-full text-destructive text-detail">Not loaded: {p.broken}</p>}
              {rowErrors[p.id] && <p className="col-span-full text-destructive text-detail">{rowErrors[p.id]}</p>}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
