import { Button, errMessage, Label } from "@internal/node-admin";
import { SSH_ERROR_DESCRIPTIONS } from "@internal/subshell-protocol";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Server, ServerOff } from "lucide-react";
import { useState } from "react";
import { useDesktopBrokers } from "@/components/connect/desktop-broker-setup";
import { SshSetupHelp } from "@/components/connect/ssh-setup-help";
import { CopyCommandRow } from "@/components/copy-command-row";
import { type ComboboxOption, SearchableSelect } from "@/components/ui/combobox";
import { useNodes } from "@/hooks/use-nodes";
import { usePublicSettings } from "@/hooks/use-public-settings";
import { useSshDiscovery, useSshOpen, useSshResolve } from "@/hooks/use-ssh-runtime";
import { desktopInvokeStrict, desktopShell } from "@/lib/desktop";
import {
  SshApiError,
  type SshRuntimeResolveView,
  type SshRuntimeSessionView,
  sshRuntimeErrorCopy,
} from "@/lib/ssh-runtime";

/** Connection selection inside the ordinary launch form. No pane is launched here. */
type Step = "machine" | "host" | "review";

interface Prefill {
  nodeId: string;
  alias: string;
}

export function ConnectJourney({
  prefill,
  onConnected,
  requiredTarget,
}: {
  prefill: Prefill | null;
  requiredTarget?: { host: string; port: number; user: string | null };
  onConnected: (session: SshRuntimeSessionView) => void;
}) {
  const settings = usePublicSettings();
  const nodesQ = useNodes();
  const brokersQ = useDesktopBrokers();
  const isClient = desktopShell()?.app === "client";
  const identity = useQuery({
    queryKey: ["desktop-ssh-identity", window.location.origin],
    queryFn: () => desktopInvokeStrict<string[]>("desktop_ssh_identity"),
    enabled: isClient,
    retry: false,
    refetchInterval: 5000,
  });
  const localBrokers = (brokersQ.data?.brokers ?? []).filter((b) => identity.data?.includes(b.id));
  const localOnline = localBrokers.find((b) => b.online);
  const [showLocalHelp, setShowLocalHelp] = useState(false);
  const [step, setStep] = useState<Step>(prefill ? "host" : "machine");
  const [nodeId, setNodeId] = useState(prefill?.nodeId ?? "");
  const [alias, setAlias] = useState(prefill?.alias ?? "");
  const [resolved, setResolved] = useState<SshRuntimeResolveView | null>(null);
  const [openCode, setOpenCode] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);

  const resolve = useSshResolve();
  const open = useSshOpen();
  const discovery = useSshDiscovery(step === "host" ? nodeId : null);
  const machine = (nodesQ.data?.nodes ?? []).find((n) => n.id === nodeId);
  const broker = brokersQ.data?.brokers?.find((row) => row.id === nodeId);
  const machineLabel = machine?.name ?? broker?.name ?? "the connecting machine";

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
    setOpenCode(null);
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
        onSuccess: (view) => {
          if (
            view.accepted &&
            requiredTarget &&
            (view.snapshot.host !== requiredTarget.host ||
              view.snapshot.port !== requiredTarget.port ||
              view.snapshot.user !== requiredTarget.user)
          ) {
            setResolved(null);
            setOpenError(
              "This SSH alias now points to a different account or host. Open a new subshell to review that destination; this pane cannot reconnect there.",
            );
            return;
          }
          setResolved(view);
        },
      },
    );
  }

  function connect() {
    if (resolved === null || !resolved.accepted) return;
    setOpenError(null);
    setOpenCode(null);
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
        onError: (err) => {
          setOpenCode(err instanceof SshApiError ? (err.sshCode ?? null) : null);
          setOpenError(sshRuntimeErrorCopy(err, { host: resolved.snapshot.host, machine: machineLabel }));
        },
      },
    );
  }

  const back = (to: Step) => {
    setStep(to);
    setResolved(null);
    setOpenError(null);
    setOpenCode(null);
  };

  // The connecting machine is a picker like every other launch choice (the
  // Quick connect selects below it, the node and agent pickers). A card stack
  // was readable at one machine and a scan at ten, with the live one buried
  // among greyed ones; a searchable list keeps the primary step one field no
  // matter how many computers the account owns.
  const serverIcon = <Server className="h-4 w-4 shrink-0 text-muted-foreground" />;
  const offlineIcon = <ServerOff className="h-4 w-4 shrink-0 text-muted-foreground" />;
  const machineOptions: ComboboxOption[] = [];
  if (isClient && localOnline) {
    machineOptions.push({
      value: localOnline.id,
      label: "This computer",
      reason: `${localOnline.name} · Subshell Client SSH`,
      searchText: `${localOnline.name} this computer`,
      icon: serverIcon,
    });
  }
  const brokerOptions = (brokersQ.data?.brokers ?? [])
    .filter((b) => !localOnline || b.id !== localOnline.id)
    .map((b) => ({
      value: b.id,
      label: b.name,
      reason: b.online ? "Subshell Client SSH" : "Subshell Client SSH · offline",
      searchText: "Subshell Client SSH",
      disabled: !b.online,
      icon: b.online ? serverIcon : offlineIcon,
    }));
  const agentOptions = ownedAgents.map((n) => {
    const why = n.maintenance
      ? "in maintenance"
      : n.kind === "local" && settings.data?.allowServerSubshells === false
        ? "server launching disabled"
        : n.status !== "online"
          ? "offline"
          : null;
    const detail = [n.hostname, n.os, n.arch].filter(Boolean).join(" · ");
    return {
      value: n.id,
      label: n.name,
      reason: why === null ? detail : detail ? `${detail} · ${why}` : why,
      // The detail line is `reason`, which the shared filter does NOT search,
      // so hostnames go in `searchText` to stay findable by what the row shows.
      searchText: [n.hostname, n.os, n.arch].filter(Boolean).join(" "),
      disabled: why !== null,
      icon: why === null ? serverIcon : offlineIcon,
    };
  });
  machineOptions.push(
    ...brokerOptions.filter((o) => !o.disabled),
    ...agentOptions.filter((o) => !o.disabled),
    ...brokerOptions.filter((o) => o.disabled),
    ...agentOptions.filter((o) => o.disabled),
  );

  return (
    <div className="flex flex-col gap-4">
      {step === "machine" && (
        <>
          <div>
            <Label htmlFor="picker-ssh-machine" className="font-strong text-heading">
              Connect from
            </Label>
            <p id="ssh-machine-help" className="text-detail text-muted-foreground">
              Choose the computer that will make the SSH connection, using its SSH settings and keys. Your agent or
              terminal runs on the remote host you choose next.
            </p>
          </div>
          {nodesQ.isError && (
            <p role="alert" className="text-destructive text-detail">
              {errMessage(nodesQ.error, "We couldn’t load your computers. Please try again.")}
            </p>
          )}
          {brokersQ.isError && (
            <div className="flex flex-col gap-2">
              <p role="alert" className="text-destructive text-detail">
                {errMessage(brokersQ.error, "We couldn’t load your Subshell Client connections.")}
              </p>
              <Button variant="outline" size="sm" onClick={() => void brokersQ.refetch()}>
                Retry computer connections
              </Button>
            </div>
          )}
          {isClient && !localOnline && (
            <div className="flex flex-col gap-2">
              <Button
                type="button"
                variant="outline"
                className="self-start"
                disabled={identity.isLoading || brokersQ.isLoading || brokersQ.isError}
                onClick={() => setShowLocalHelp(true)}
              >
                This computer · set up SSH
              </Button>
              {showLocalHelp && (
                <p className="text-detail text-muted-foreground" role="status">
                  {identity.isError
                    ? "Update Subshell Client to identify this computer automatically. You can still choose a named connection below."
                    : localBrokers.length > 0
                      ? "In Subshell Client, open SSH Connections and reconnect to this server."
                      : "Open Settings → SSH Connections on this server to get a pairing code. Then open SSH Connections in Subshell Client and pair with this server. Your node registration stays unchanged."}
                </p>
              )}
            </div>
          )}
          {machineOptions.length > 0 ? (
            <SearchableSelect
              id="picker-ssh-machine"
              value=""
              consumed
              placeholder="Choose a computer"
              describedBy="ssh-machine-help"
              options={machineOptions}
              onValueChange={(id) => {
                if (id) pickMachine(id);
              }}
            />
          ) : (
            !nodesQ.isLoading &&
            !brokersQ.isLoading &&
            !nodesQ.isError &&
            !brokersQ.isError && (
              <p className="text-detail text-muted-foreground">
                You haven’t connected a computer for SSH yet. To use the SSH keys on your computer,
                <Link to="/settings/connections" className="underline">
                  open Settings → SSH Connections
                </Link>{" "}
                and pair it with Subshell Client. You can also add a computer you own on the Nodes page.
              </p>
            )
          )}
        </>
      )}

      {step === "host" && (
        <>
          <div>
            <p className="font-strong text-heading">Work on</p>
            <p className="text-detail text-muted-foreground">
              Choose where you want to work. {machineLabel} SSHes into one of these hosts, listed in its SSH config.
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
            <div className="flex flex-col gap-3">
              <p className="text-detail text-muted-foreground">
                No SSH hosts found on {machineLabel}. Add a host to ~/.ssh/config for the account running Subshell.
                Here’s an example you can adapt:
              </p>
              <CopyCommandRow
                label="SSH configuration example"
                text={`Host work
  HostName host.example.com
  User your-remote-account
  Port 22
  IdentityFile ~/.ssh/id_ed25519`}
              />
              <p className="text-detail text-muted-foreground">
                Replace the example address, username, and key path with yours. For a container, use its published SSH
                port. The address must be reachable from {machineLabel}; localhost refers to that computer. Give each
                host a name rather than a wildcard like *. Then run ssh work on {machineLabel}, verify the host’s
                fingerprint, and select Refresh hosts here.
              </p>
            </div>
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
                  Some SSH config files include each other in a loop, so a few hosts may be missing.
                </p>
              )}
              {discovery.data.truncated && (
                <p className="text-detail text-muted-foreground">
                  There are too many hosts to show them all. Narrow down your SSH config to find the one you need.
                </p>
              )}
            </div>
          )}
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void discovery.refetch()}
              disabled={discovery.isFetching}
            >
              Refresh hosts
            </Button>
            <Button variant="ghost" size="sm" onClick={() => back("machine")}>
              Back
            </Button>
          </div>
        </>
      )}

      {step === "review" && (
        <>
          <div>
            <p className="font-strong text-heading">{alias}</p>
            <p className="text-detail text-muted-foreground">
              Connect to this host, then choose a folder to work in. We’ll help you with any setup along the way.
            </p>
          </div>
          {resolve.isPending && <p className="text-detail text-muted-foreground">Checking host settings…</p>}
          {resolve.isError && (
            <p role="alert" className="text-destructive text-detail">
              {errMessage(
                resolve.error,
                "We couldn’t read the settings for this host. Check its SSH config and try again.",
              )}
            </p>
          )}
          {resolved !== null && !resolved.accepted && (
            <div role="alert" className="space-y-1">
              {/* The shipped sentence for the named code, by EQUALITY - never
                    the wire code itself (the old editor's mapping, same package). */}
              <p className="text-destructive text-detail">{SSH_ERROR_DESCRIPTIONS[resolved.code]}</p>
              {resolved.settings.length > 0 && (
                <p className="font-mono text-detail text-muted-foreground">
                  Unsupported SSH settings: {resolved.settings.join(", ")}
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
          <SshSetupHelp
            code={openCode}
            alias={alias}
            machine={machineLabel}
            account={resolved?.accepted ? resolved.connectingAccount : undefined}
          />
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => back("host")} disabled={open.isPending}>
              Back
            </Button>
            <Button size="sm" onClick={connect} disabled={open.isPending || resolved === null || !resolved.accepted}>
              {open.isPending ? "Connecting…" : openError ? "Retry connection" : "Connect"}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
