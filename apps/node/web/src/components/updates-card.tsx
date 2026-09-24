import {
  apiFetch,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  errMessage,
  Input,
} from "@internal/node-admin";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

/** `GET /api/self/update` — the machine's own update state. */
interface UpdateInfo {
  currentVersion: string;
  protocolVersion: number;
  /** False = no `SUBSHELL_RELEASE_URL`: the air-gapped configuration. */
  releaseConfigured: boolean;
  debugLogging: boolean;
  /** Set while an installed-but-unbooted update is awaiting its boot-time finish. */
  pending: { from: string; to: string } | null;
  lastFailure: { from: string; to: string; reason: string; failedAt: string } | null;
  connected: boolean;
}

const UPDATE_KEY = ["self-update"];

/**
 * The Updates page's engine — this node updating itself from its release source.
 *
 * It talks to `/api/self/update`, not `/api/nodes/:id/update`, because the
 * subject is THIS machine and there is no plane in the loop: the same
 * `subshell update` the CLI runs, driven through the daemon's own release
 * resolution (signed manifest, compiled-in publisher key, the install digest
 * from that manifest — the trust chain is unchanged, only the caller is local).
 *
 * The act ends the process, so the page is built for vanishing: an accepted
 * update asks the daemon to exit, the {@link useReconnect} overlay takes the
 * screen while the manager respawns it, and the whole thing re-reads on return.
 * The two refusals that do NOT exit — "not supervised" and a bad release
 * source — come back as ordinary 409s and print inline, because a foreground
 * `subshell run` has nothing to respawn it.
 */
export function UpdatesCard(): React.ReactNode {
  const _queryClient = useQueryClient();
  const [force, setForce] = useState(false);
  const [to, setTo] = useState("");
  const [result, setResult] = useState<string | null>(null);

  const info = useQuery<UpdateInfo>({
    queryKey: UPDATE_KEY,
    queryFn: () => apiFetch<UpdateInfo>("/api/self/update"),
  });

  const update = useMutation({
    mutationFn: () =>
      apiFetch<{ ok: true; version: string }>("/api/self/update", {
        method: "POST",
        body: JSON.stringify({
          ...(to.trim() ? { to: to.trim() } : {}),
          ...(force ? { force: true } : {}),
        }),
      }),
    onSuccess: (r) => setResult(`Installing ${r.version}. The node is restarting to finish it.`),
  });

  const rollback = useMutation({
    mutationFn: () =>
      apiFetch<{ ok: true; to: string; restarted: boolean }>("/api/self/update/rollback", { method: "POST" }),
    onSuccess: (r) =>
      setResult(r.restarted ? `Rolled back to ${r.to}. The node is restarting.` : `Rolled back to ${r.to}.`),
  });

  const busy = update.isPending || rollback.isPending;

  if (info.isError) {
    return (
      <p role="alert" className="text-body text-destructive">
        {errMessage(info.error, "Could not read this node's update state.")}
      </p>
    );
  }
  const d = info.data;
  if (!d) return <p className="text-body text-muted-foreground">Loading…</p>;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Node software</CardTitle>
        <CardDescription>
          The node updates itself from its release source, exactly as <code className="font-mono">subshell update</code>{" "}
          does. The signed release manifest is verified against the publisher key compiled into this binary, and the
          install digest comes from that manifest, never from the download host.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <span className="text-body text-foreground">
            Running <span className="font-mono text-detail">v{d.currentVersion}</span> · protocol v{d.protocolVersion}
          </span>
          {!d.connected && <Badge variant="warning">offline from its plane</Badge>}
        </div>

        {d.pending && (
          <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-detail text-foreground">
            An update from <span className="font-mono">{d.pending.from}</span> to{" "}
            <span className="font-mono">{d.pending.to}</span> is installed but not yet confirmed by a successful boot.
          </p>
        )}
        {d.lastFailure && (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-detail text-foreground">
            The last update ({d.lastFailure.from} → {d.lastFailure.to}) failed and was rolled back:{" "}
            {d.lastFailure.reason}
          </p>
        )}

        {!d.releaseConfigured ? (
          <p className="text-detail text-muted-foreground">
            No release source is configured (<code className="font-mono">SUBSHELL_RELEASE_URL</code> is empty), so this
            node is air-gapped: it fetches nothing. Update it on the machine with{" "}
            <code className="font-mono">subshell update --from &lt;url&gt;</code>.
          </p>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={() => void update.mutate()} disabled={busy}>
                {update.isPending ? "Installing…" : "Update to latest"}
              </Button>
              <label className="flex items-center gap-2 text-detail text-muted-foreground">
                <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} disabled={busy} />
                Force (allow a downgrade)
              </label>
            </div>
            <p className="text-detail text-muted-foreground">
              A downgrade the control plane will not accept is reversed automatically after about ten minutes offline.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <div className="w-40">
                <Input
                  type="text"
                  placeholder="specific version"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  disabled={busy}
                />
              </div>
              <span className="text-detail text-muted-foreground">Blank installs the newest published release.</span>
            </div>
          </div>
        )}

        <div className="border-t pt-3">
          <Button variant="outline" onClick={() => void rollback.mutate()} disabled={busy}>
            {rollback.isPending ? "Rolling back…" : "Roll back to the previous version"}
          </Button>
          <p className="mt-2 text-detail text-muted-foreground">
            Reinstalls the binary kept as <code className="font-mono">.previous</code> by the last update.
          </p>
        </div>

        {update.isError && (
          <p role="alert" className="text-destructive text-detail">
            {errMessage(update.error, "The update was refused.")}
          </p>
        )}
        {rollback.isError && (
          <p role="alert" className="text-destructive text-detail">
            {errMessage(rollback.error, "Rollback was refused.")}
          </p>
        )}
        {result && <p className="text-detail text-success">{result}</p>}

        <p className="text-detail text-muted-foreground">
          This page cannot ask the control plane which node version it accepts; that compatibility check lives in the
          server's Settings → Updates.
        </p>
      </CardContent>
    </Card>
  );
}
