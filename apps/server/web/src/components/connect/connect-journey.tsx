import { Button, errMessage } from "@internal/node-admin";
import { SSH_ERROR_DESCRIPTIONS } from "@internal/subshell-protocol";
import { Server, ServerOff } from "lucide-react";
import { useState } from "react";
import { useNodes } from "@/hooks/use-nodes";
import { usePublicSettings } from "@/hooks/use-public-settings";
import { useSshDiscovery, useSshOpen, useSshResolve } from "@/hooks/use-ssh-runtime";
import { type SshRuntimeResolveView, type SshRuntimeSessionView, sshRuntimeErrorCopy } from "@/lib/ssh-runtime";

/** Connection selection inside the ordinary launch form. No pane is launched here. */
type Step = "machine" | "host" | "review";

interface Prefill {
  nodeId: string;
  alias: string;
}

export function ConnectJourney({
  prefill,
  onConnected,
}: {
  prefill: Prefill | null;
  onConnected: (session: SshRuntimeSessionView) => void;
}) {
  const settings = usePublicSettings();
  const nodesQ = useNodes();
  const [step, setStep] = useState<Step>(prefill ? "host" : "machine");
  const [nodeId, setNodeId] = useState(prefill?.nodeId ?? "");
  const [alias, setAlias] = useState(prefill?.alias ?? "");
  const [resolved, setResolved] = useState<SshRuntimeResolveView | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);

  const resolve = useSshResolve();
  const open = useSshOpen();
  const discovery = useSshDiscovery(step === "host" ? nodeId : null);
  const machine = (nodesQ.data?.nodes ?? []).find((n) => n.id === nodeId);
  const machineLabel = machine?.name ?? "the connecting machine";

  const ownedAgents = (nodesQ.data?.nodes ?? []).filter(
    (n) =>
      (n.kind === "agent" && n.access === "owner") || (n.kind === "local" && settings.data?.viewerIsAdmin === true),
  );

  function pickMachine(id: string) {
    setNodeId(id);
    setAlias("");
    setStep("host");
  }

  function pickHost(name: string) {
    setAlias(name);
    setResolved(null);
    setOpenError(null);
    setStep("review");
    // The answer rides onSuccess (not resolve.data): a re-pick must never
    // render the PREVIOUS alias's review facts while its own resolve is in
    // flight, and the per-call callback clears exactly then.
    resolve.mutate(
      { nodeId, alias: name },
      {
        // Transport failures stay on the mutation object (the step renders
        // `resolve.isError`); only an ANSWER (accepted or named refusal)
        // becomes review facts.
        onSuccess: (view) => setResolved(view),
      },
    );
  }

  function connect() {
    if (resolved === null || !resolved.accepted) return;
    setOpenError(null);
    open.mutate(
      {
        connectingNodeId: nodeId,
        target: {
          alias: resolved.snapshot.alias,
          host: resolved.snapshot.host,
          port: resolved.snapshot.port,
          user: resolved.snapshot.user,
          identityFile: resolved.snapshot.identityFiles[0] ?? null,
        },
      },
      {
        onSuccess: (view) => {
          onConnected(view);
        },
        onError: (err) =>
          setOpenError(sshRuntimeErrorCopy(err, { host: resolved.snapshot.host, machine: machineLabel })),
      },
    );
  }

  const back = (to: Step) => {
    setStep(to);
    setResolved(null);
    setOpenError(null);
  };

  return (
    <div className="flex flex-col gap-4">
      {step === "machine" && (
        <>
          <div>
            <p className="font-strong text-heading">Connect from</p>
            <p className="text-detail text-muted-foreground">
              Choose the machine whose SSH configuration and keys can reach your host. Your agent will run on the SSH
              host.
            </p>
          </div>
          {nodesQ.isError && (
            <p role="alert" className="text-destructive text-detail">
              {errMessage(nodesQ.error, "The machine list could not be loaded.")}
            </p>
          )}
          {ownedAgents.length === 0 && !nodesQ.isLoading && (
            <p className="text-detail text-muted-foreground">
              No connecting machines are available to your account. The browser cannot use your computer’s SSH keys.
              Connect one of your machines on the Nodes page, or ask an admin to connect from the server.
            </p>
          )}
          <div className="space-y-2">
            {ownedAgents.map((n) => {
              const ineligible = n.maintenance
                ? "in maintenance"
                : n.kind === "local" && settings.data?.allowServerSubshells === false
                  ? "server launching disabled"
                  : n.status !== "online"
                    ? "offline"
                    : null;
              return (
                <button
                  key={n.id}
                  type="button"
                  disabled={ineligible !== null}
                  onClick={() => pickMachine(n.id)}
                  className="flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left hover:bg-accent disabled:pointer-events-none disabled:opacity-60"
                >
                  {ineligible === null ? (
                    <Server className="h-4 w-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <ServerOff className="h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-strong text-label">{n.name}</span>
                    <span className="block truncate text-detail text-muted-foreground">
                      {[n.hostname, n.os, n.arch].filter(Boolean).join(" · ")}
                      {ineligible !== null && ` · ${ineligible}`}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </>
      )}

      {step === "host" && (
        <>
          <div>
            <p className="font-strong text-heading">{machineLabel}</p>
            <p className="text-detail text-muted-foreground">
              Choose the host you want to work on. These names come from ~/.ssh/config on {machineLabel}.
            </p>
          </div>
          {discovery.isError && (
            <div className="space-y-2">
              <p role="alert" className="text-destructive text-detail">
                {errMessage(discovery.error, `The SSH config on ${machineLabel} could not be read.`)}
              </p>
              <Button variant="outline" size="sm" onClick={() => void discovery.refetch()}>
                Retry
              </Button>
            </div>
          )}
          {discovery.isLoading && <p className="text-detail text-muted-foreground">Reading the config…</p>}
          {discovery.data !== undefined && discovery.data.aliases.length === 0 && (
            <p className="text-detail text-muted-foreground">
              No SSH host aliases were found for this account on {machineLabel}. Add one to the machine&apos;s SSH
              config and retry.
            </p>
          )}
          {discovery.data !== undefined && discovery.data.aliases.length > 0 && (
            <div className="space-y-2">
              {discovery.data.aliases.map((a) => (
                <button
                  key={a}
                  type="button"
                  onClick={() => pickHost(a)}
                  className="flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left hover:bg-accent"
                >
                  <span className="min-w-0 flex-1 truncate font-mono text-sm">{a}</span>
                </button>
              ))}
              {discovery.data.includeCycle && (
                <p className="text-detail text-muted-foreground">
                  The config has an include cycle; the list is what parsed before it.
                </p>
              )}
              {discovery.data.truncated && <p className="text-detail text-muted-foreground">The list is capped.</p>}
            </div>
          )}
          <Button variant="ghost" size="sm" onClick={() => back("machine")}>
            Back
          </Button>
        </>
      )}

      {step === "review" && (
        <>
          <div>
            <p className="font-strong text-heading">{alias}</p>
            <p className="text-detail text-muted-foreground">
              Subshell and the agent you want to use must be installed on this host. No node enrollment is needed.
            </p>
          </div>
          {resolve.isPending && <p className="text-detail text-muted-foreground">Resolving…</p>}
          {resolve.isError && (
            <p role="alert" className="text-destructive text-detail">
              {errMessage(resolve.error, "The host could not be resolved on the machine.")}
            </p>
          )}
          {resolved !== null && !resolved.accepted && (
            <div role="alert" className="space-y-1">
              {/* The shipped sentence for the named code, by EQUALITY - never
                    the wire code itself (the old editor's mapping, same package). */}
              <p className="text-destructive text-detail">{SSH_ERROR_DESCRIPTIONS[resolved.code]}</p>
              {resolved.settings.length > 0 && (
                <p className="font-mono text-detail text-muted-foreground">
                  Blocked settings: {resolved.settings.join(", ")}
                </p>
              )}
            </div>
          )}
          {resolved?.accepted && (
            <dl className="space-y-1">
              <div className="flex items-baseline gap-2">
                <dt className="text-detail text-muted-foreground">Destination</dt>
                <dd className="font-mono text-sm">
                  {resolved.snapshot.user ?? ""}
                  {resolved.snapshot.user !== null ? "@" : ""}
                  {resolved.snapshot.host}:{resolved.snapshot.port}
                </dd>
              </div>
              <div className="flex items-baseline gap-2">
                <dt className="text-detail text-muted-foreground">Connect from</dt>
                <dd className="text-sm">
                  {machineLabel}
                  {resolved.connectingAccount !== undefined ? ` as ${resolved.connectingAccount}` : ""}
                </dd>
              </div>
            </dl>
          )}
          {openError !== null && (
            <p role="alert" className="text-destructive text-detail">
              {openError}
            </p>
          )}
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => back("host")} disabled={open.isPending}>
              Back
            </Button>
            <Button size="sm" onClick={connect} disabled={open.isPending || resolved === null || !resolved.accepted}>
              {open.isPending ? "Connecting…" : "Connect"}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
