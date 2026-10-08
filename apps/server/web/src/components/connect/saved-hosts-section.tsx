import { Star, Trash2 } from "lucide-react";
import type { JSX } from "react";
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
  const { data: ledger } = useSshSavedHosts();
  const { data: nodeData } = useNodes();
  const save = useSaveSshHost();
  const remove = useDeleteSshHost();

  const saved = ledger?.saved ?? [];
  const savedIds = new Set(saved.map((h) => h.id));
  const recent = (ledger?.recent ?? []).filter((h) => !savedIds.has(h.id));
  const nameById = new Map<string, string>(
    (Array.isArray(nodeData?.nodes) ? nodeData.nodes : []).map((n) => [n.id, n.name]),
  );
  const machineName = (row: SshSavedHost): string => nameById.get(row.nodeId) ?? row.nodeId;

  return (
    <div className="space-y-6 border-t pt-6">
      <div className="space-y-2">
        <h2 className="font-strong text-label">Remembered</h2>
        {saved.length === 0 ? (
          <p className="text-detail text-muted-foreground">No remembered destinations yet.</p>
        ) : (
          <ul className="space-y-1">
            {saved.map((row) => (
              <LedgerRow
                key={row.id}
                row={row}
                detail={[machineName(row), row.savedAt?.slice(0, 10)].filter(Boolean).join(" · ")}
                action={{
                  label: `Forget ${row.alias ?? row.destination}`,
                  icon: Trash2,
                  onSelect: () => remove.mutate(row.id),
                }}
              />
            ))}
          </ul>
        )}
      </div>
      <div className="space-y-2">
        <h2 className="font-strong text-label">Recent</h2>
        {recent.length === 0 ? (
          <p className="text-detail text-muted-foreground">No recent destinations yet.</p>
        ) : (
          <ul className="space-y-1">
            {recent.map((row) => (
              <LedgerRow
                key={row.id}
                row={row}
                detail={`${machineName(row)} · ${row.lastConnectAt.slice(0, 10)}`}
                action={{
                  label: `Remember ${row.alias ?? row.destination}`,
                  icon: Star,
                  onSelect: () => save.mutate({ node: row.nodeId, destination: row.destination }),
                }}
              />
            ))}
          </ul>
        )}
      </div>
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
  action: { label: string; icon: typeof Star; onSelect: () => void };
}): JSX.Element {
  const Icon = action.icon;
  return (
    <li className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <div className="truncate font-strong text-label">{row.alias ?? row.destination}</div>
        <div className="truncate text-detail text-muted-foreground">{detail}</div>
      </div>
      <button
        type="button"
        aria-label={action.label}
        title={action.label}
        onClick={action.onSelect}
        className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground"
      >
        <Icon className="h-3.5 w-3.5" />
      </button>
    </li>
  );
}
