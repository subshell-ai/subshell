import { Button, errMessage, Switch } from "@internal/node-admin";
import { useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useGrantSshConnection, useRevokeSshConnection, useSshGrants } from "@/hooks/use-ssh";
import { useSharableUsers } from "@/hooks/use-subshell-shares";
import { useSubshellsList } from "@/hooks/use-subshells";
import type { SshConnectionView, SshGrantView } from "@/lib/ssh";

/**
 * Grant management for one connection (spec §2: a grant binds a connection
 * revision to a pane ID and its current credential generation, human-issued
 * only). The list is the owner's RUNNING panes - the backend refuses a grant
 * to a non-running pane, so the UI never offers one - and every toggle is a
 * live call: on = `POST …/grants`, off = `DELETE …/grants/:pane`. Revoked
 * rows stay visible as history because `GET …/grants` carries them, and a
 * silently-short history would let a stale grant read as never having
 * existed.
 */
export function SshGrantsDialog({
  open,
  onOpenChange,
  connection,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connection: SshConnectionView;
}) {
  const { data: grantsData } = useSshGrants(connection.id);
  const { data: panes } = useSubshellsList();
  const { data: users } = useSharableUsers(open);
  const grant = useGrantSshConnection(connection.id);
  const revoke = useRevokeSshConnection(connection.id);
  const [error, setError] = useState<string | null>(null);
  const [busyPane, setBusyPane] = useState<string | null>(null);

  // Owner's live panes only: the grant row binds a pane AND its issued key,
  // so a row that is gone or merely shared-in has nothing to bind to.
  const ownRunning = (panes ?? []).filter((p) => p.access === "owner" && p.status === "running" && p.alive);
  const grants = grantsData?.grants ?? [];
  const activeByPane = new Map<string, SshGrantView>();
  for (const g of grants) if (g.active) activeByPane.set(g.subshellId, g);
  const revoked = grants.filter((g) => !g.active).slice(0, 8);
  const nameOf = (id: string) => panes?.find((p) => p.id === id)?.name ?? id.slice(0, 8);
  const emailOf = (userId: string) => users?.find((u) => u.id === userId)?.email ?? userId;

  async function toggle(paneId: string, on: boolean): Promise<void> {
    setError(null);
    setBusyPane(paneId);
    try {
      if (on) await grant.mutateAsync(paneId);
      else await revoke.mutateAsync(paneId);
    } catch (err) {
      // A refused grant names itself ("not running", "token stale") - show
      // the server's sentence, never a generic "toggle failed".
      setError(errMessage(err, "The grant change did not apply."));
    } finally {
      setBusyPane(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Grant panes SSH access</DialogTitle>
          <DialogDescription>
            Only your panes that are running can take a grant. A pane keeps it only while its current credential lives,
            so a restart needs a fresh grant.
          </DialogDescription>
        </DialogHeader>

        <p className="text-detail text-muted-foreground">Connection: {connection.displayName}</p>

        <div className="flex flex-col gap-1">
          {ownRunning.length === 0 ? (
            <p className="text-detail text-muted-foreground">No running panes to grant right now.</p>
          ) : (
            ownRunning.map((pane) => {
              const active = activeByPane.get(pane.id);
              return (
                <div key={pane.id} className="flex items-center justify-between gap-3 border-b py-2 last:border-b-0">
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate font-strong text-label">{pane.name || pane.id.slice(0, 8)}</span>
                    <span className="text-detail text-muted-foreground">
                      {active
                        ? `Revision ${active.connectionRevision} · granted by ${emailOf(active.grantedByUserId)}`
                        : pane.harnessId}
                    </span>
                  </div>
                  <Switch
                    aria-label={active ? `Revoke SSH access for ${pane.name}` : `Grant SSH access to ${pane.name}`}
                    checked={active !== undefined}
                    disabled={busyPane === pane.id}
                    onCheckedChange={(checked) => void toggle(pane.id, checked === true)}
                  />
                </div>
              );
            })
          )}
        </div>

        {revoked.length > 0 ? (
          <div className="flex flex-col gap-1">
            <p className="font-strong text-label">
              Revoked history{" "}
              {grants.filter((g) => !g.active).length > revoked.length ? `(showing the latest ${revoked.length})` : ""}
            </p>
            {revoked.map((g) => (
              <p key={g.id} className="text-detail text-muted-foreground">
                {nameOf(g.subshellId)} · revoked {g.revokedAt ? new Date(g.revokedAt).toLocaleString() : "unknown"}
              </p>
            ))}
          </div>
        ) : null}

        {error ? (
          <p role="alert" className="text-destructive text-detail">
            {error}
          </p>
        ) : null}

        <div className="flex justify-end">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
