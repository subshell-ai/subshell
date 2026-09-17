import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { PluginIcon } from "@/components/plugin-icon";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useInstallInstancePlugin, useInstancePlugins } from "@/hooks/use-instance-plugins";
import { NETWORK_QUERY_KEY } from "@/hooks/use-network";
import { errMessage } from "@/lib/api";

/**
 * The networks this build carries that the instance store does not hold yet.
 *
 * Deliberately the SAME act as `PluginCatalogCard` on the plugins page, and
 * deliberately repeated here: a person on this page is asking "how do I reach
 * this server from my phone", and answering it with "install a plugin
 * somewhere else first" is asking them to learn our architecture to finish a
 * sentence. One click, no confirmation, no network — the bytes are inside this
 * server binary.
 *
 * It renders nothing when there is nothing to add, rather than an empty state:
 * this sits under the networks a person came here to use, and a permanent card
 * offering nothing is rent paid forever.
 */
export function AddNetworkCard() {
  const queryClient = useQueryClient();
  const { data } = useInstancePlugins();
  const install = useInstallInstancePlugin();
  const [failedId, setFailedId] = useState<string | null>(null);
  // The catalog's own flag, not a diff against the networks list: "this build
  // ships it and the store does not hold it" is one fact, and deriving it
  // from two reads would let them disagree while one is in flight.
  const available = (data?.plugins ?? []).filter((plugin) => plugin.type === "network" && !plugin.installed);
  if (available.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Add a network</CardTitle>
        <CardDescription>
          Networks this server binary carries. Installing copies one into the instance store: one click, no network,
          nothing third-party.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {available.map((plugin) => (
          <div key={plugin.id} className="flex flex-wrap items-center gap-3 rounded-lg border p-3">
            <PluginIcon pluginId={plugin.id} name={plugin.name} className="size-8" />
            <div className="min-w-0 flex-1">
              <p className="font-strong">{plugin.name}</p>
              {plugin.description && <p className="text-detail text-muted-foreground">{plugin.description}</p>}
            </div>
            <Button
              size="sm"
              disabled={install.isPending}
              onClick={() => {
                setFailedId(null);
                install.mutate(
                  { pluginId: plugin.id },
                  {
                    // The plugin hook refreshes the CATALOG; the Networks
                    // list above is the other thing the install just
                    // changed. Without it the new network vanishes from this
                    // card (it no longer reads as available) and is absent
                    // from that list until the next poll.
                    onSuccess: () => void queryClient.invalidateQueries({ queryKey: NETWORK_QUERY_KEY }),
                    onError: () => setFailedId(plugin.id),
                  },
                );
              }}
            >
              Install {plugin.name}
            </Button>
          </div>
        ))}
        {install.isError && failedId !== null && (
          <p className="text-destructive text-detail">
            {errMessage(install.error, "The install failed. Nothing changed.")}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
