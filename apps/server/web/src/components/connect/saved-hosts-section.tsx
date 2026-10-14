import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, errMessage } from "@internal/node-admin";
import { Star, Trash2 } from "lucide-react";
import type { JSX } from "react";
import { SshQueryStatus } from "@/components/ssh/query-status";
import { useNodes } from "@/hooks/use-nodes";
import { useDeleteSshHost, useSaveSshHost, useSshSavedHosts } from "@/hooks/use-ssh";
import type { SshSavedHost } from "@/lib/ssh";

/**
 * The destination ledger under the Connect panel (spec 2026-10-07 §7): what
 * the caller remembered, and what they last connected to. Two lists, one
 * shape: `label` over `detail`, differing by weight and colour - the label is
 * the display alias or the destination, the detail names the connecting
 * machine and the day. Remembered rows carry the way OUT (delete); recent
 * rows carry the way IN (remember). Recent rows already Saved read once: the
 * remembered copy wins, nothing duplicates.
 *
 * The save is a plain PUT keyed to the row's own machine - the server
 * resolves first and stores the canonical destination, so a rename of the
 * alias later cannot re-point the key. The delete is by row id. No confirms:
 * a ledger row is cheap to remake, and the ACT that matters is the launch.
 */
export function SavedHostsSection(): JSX.Element {
  const query = useSshSavedHosts();
  const ledger = query.data;
  const { data: nodeData } = useNodes();
  const save = useSaveSshHost();
  const remove = useDeleteSshHost();

  const saved = ledger?.saved ?? [];
  const savedIds = new Set(saved.map((h) => h.id));
  const recent = (ledger?.recent ?? []).filter((h) => !savedIds.has(h.id));
  const nameById = new Map<string, string>(
    (Array.isArray(nodeData?.nodes) ? nodeData.nodes : []).map((n) => [n.id, n.name]),
  );
  const machineName = (row: SshSavedHost): string => nameById.get(row.nodeId) ?? "Node unavailable";

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Saved destinations</CardTitle>
          <CardDescription>Destinations you’ve remembered appear in the SSH destination picker.</CardDescription>
        </CardHeader>
        <CardContent>
          {query.isPending || query.isError ? (
            <SshQueryStatus query={query} label="saved destinations" />
          ) : saved.length === 0 ? (
            <p className="text-detail text-muted-foreground">No saved destinations yet.</p>
          ) : (
            <ul className="flex flex-col divide-y">
              {saved.map((row) => (
                <LedgerRow
                  key={row.id}
                  row={row}
                  detail={[machineName(row), row.savedAt?.slice(0, 10)].filter(Boolean).join(" · ")}
                  action={{
                    disabled: remove.isPending,
                    label: `Forget ${row.alias ?? row.destination}`,
                    icon: Trash2,
                    onSelect: () => remove.mutate(row.id),
                  }}
                />
              ))}
            </ul>
          )}
          {remove.isError && (
            <p role="alert" className="text-destructive text-detail">
              {errMessage(remove.error, "Couldn’t remove the destination. Try again.")}
            </p>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Recent destinations</CardTitle>
          <CardDescription>Save a recent destination to keep it in your saved suggestions.</CardDescription>
        </CardHeader>
        <CardContent>
          {query.isPending || query.isError ? (
            <SshQueryStatus query={query} label="recent destinations" />
          ) : recent.length === 0 ? (
            <p className="text-detail text-muted-foreground">No recent destinations yet.</p>
          ) : (
            <ul className="flex flex-col divide-y">
              {recent.map((row) => (
                <LedgerRow
                  key={row.id}
                  row={row}
                  detail={`${machineName(row)} · ${row.lastConnectAt.slice(0, 10)}`}
                  action={{
                    disabled: save.isPending,
                    label: `Remember ${row.alias ?? row.destination}`,
                    icon: Star,
                    onSelect: () => save.mutate({ node: row.nodeId, destination: row.destination }),
                  }}
                />
              ))}
            </ul>
          )}
          {save.isError && (
            <p role="alert" className="text-destructive text-detail">
              {errMessage(save.error, "Couldn’t save the destination. Try again.")}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/** One ledger line: label over detail, with the row's single act on the right. */
function LedgerRow({
  row,
  detail,
  action,
}: {
  row: SshSavedHost;
  detail: string;
  action: { label: string; icon: typeof Star; onSelect: () => void; disabled: boolean };
}): JSX.Element {
  const Icon = action.icon;
  return (
    <li className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0 flex-1">
        <div className="break-all font-strong text-label">{row.alias ?? row.destination}</div>
        {row.alias && row.alias !== row.destination && (
          <div className="break-all text-detail text-muted-foreground">{row.destination}</div>
        )}
        <div className="break-words text-detail text-muted-foreground">{detail}</div>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        disabled={action.disabled}
        aria-label={action.label}
        title={action.label}
        onClick={action.onSelect}
        className="shrink-0"
      >
        <Icon />
      </Button>
    </li>
  );
}
