import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { type InstancePluginRow, useInstallInstancePlugin } from "@/hooks/use-instance-plugins";
import { errMessage } from "@/lib/api";

/**
 * The offline half of the catalog: built-ins this build carries that the
 * instance store does not hold yet. One click, no confirmation, because
 * nothing third-party runs and no network is touched: the bytes are inside
 * this server binary (spec 2026-09-10 §6; phase 4 carried this affordance
 * over unchanged in kind, the question "does this need asking?" is what moved
 * to the install-by-name form next door).
 */
export function PluginCatalogCard({ plugins }: { plugins: InstancePluginRow[] }) {
  const install = useInstallInstancePlugin();
  const [failedId, setFailedId] = useState<string | null>(null);
  if (plugins.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Add from this build</CardTitle>
        <CardDescription>
          Plugins this server binary carries. Installing copies them into the instance store: one click, no network,
          nothing third-party.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {plugins.map((p) => (
          <div key={p.id} className="flex flex-wrap items-center gap-3 rounded-lg border p-3">
            <div className="min-w-0 flex-1">
              <p className="font-strong">{p.name}</p>
              {p.description && <p className="text-muted-foreground text-xs">{p.description}</p>}
            </div>
            <Button
              size="sm"
              disabled={install.isPending}
              onClick={() => {
                setFailedId(null);
                install.mutate({ pluginId: p.id }, { onError: () => setFailedId(p.id) });
              }}
            >
              Install {p.name}
            </Button>
          </div>
        ))}
        {install.isError && failedId !== null && (
          <p className="text-destructive text-sm">
            {errMessage(install.error, "The install failed. Nothing changed.")}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
