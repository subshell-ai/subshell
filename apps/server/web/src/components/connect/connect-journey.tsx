import { Button, Card, errMessage } from "@internal/node-admin";
import { SSH_ERROR_DESCRIPTIONS } from "@internal/subshell-protocol";
import { useNavigate } from "@tanstack/react-router";
import { Server, ServerOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { DirBrowser } from "@/components/connect/dir-browser";
import { type LaunchPick, LaunchStep } from "@/components/connect/launch-step";
import { useNodes } from "@/hooks/use-nodes";
import { usePresets } from "@/hooks/use-presets";
import {
  useSshDetectHarnesses,
  useSshDiscovery,
  useSshLaunchHarness,
  useSshLaunchTerminal,
  useSshOpen,
  useSshResolve,
  useSshSessionHarnesses,
} from "@/hooks/use-ssh-runtime";
import {
  destinationLabel,
  type SshRuntimeResolveView,
  type SshRuntimeSessionView,
  sshRuntimeErrorCopy,
} from "@/lib/ssh-runtime";

/**
 * The Connect-over-SSH journey (design 2026-10-05 §1, §7): machine, host,
 * review, connect, folder, launch. Four screens, one step each, server facts
 * throughout:
 *
 * - **Machine**: only nodes the caller REALY owns. The list rides `access:
 *   "owner"` from the node view, which is the same real-ownership answer the
 *   server's open gate applies (an admin's effective edit is not ownership;
 *   a share is not ownership; `local` is left out because the plane cannot
 *   broker a session through the control-plane host yet).
 * - **Host**: the alias list discovered ON that machine. A failed read and an
 *   empty list say different sentences - a failure must never read as "no
 *   hosts".
 * - **Review**: the resolve outcome, showing the concrete `user@host:port`
 *   and the connecting account, then Connect = open-session. The probe is the
 *   test; refusals render the named remedy (the copy table's job).
 * - **Folder/launch**: browse the destination, then the launch seam (terminal
 *   today; the preset list joins the same row list later).
 *
 * `prefill` (from a session row's Reopen) jumps straight to the host step
 * with the machine and alias already chosen; the resolve runs again, because
 * identity files and host trust are the machine's facts to re-check, not the
 * session history's to cache.
 */

type Step = "machine" | "host" | "review" | "folder";

interface Prefill {
  nodeId: string;
  alias: string;
}

export function ConnectJourney({ prefill, onActive }: { prefill: Prefill | null; onActive?: () => void }) {
  const navigate = useNavigate();
  const nodesQ = useNodes();
  const [step, setStep] = useState<Step>(prefill ? "host" : "machine");
  const [nodeId, setNodeId] = useState(prefill?.nodeId ?? "");
  const [alias, setAlias] = useState(prefill?.alias ?? "");
  const [resolved, setResolved] = useState<SshRuntimeResolveView | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [session, setSession] = useState<SshRuntimeSessionView | null>(null);
  const [cwd, setCwd] = useState("");

  const resolve = useSshResolve();
  const open = useSshOpen();
  const openTerminal = useSshLaunchTerminal();
  const openHarness = useSshLaunchHarness();

  // The destination's harness mirror, read on the folder step (the cache read
  // is free; the DETECT round trip is asked once per session, below).
  const sessionId = step === "folder" && session !== null ? session.id : null;
  const harnessQ = useSshSessionHarnesses(sessionId);
  const detectHarnesses = useSshDetectHarnesses(sessionId ?? "");
  const detectRanFor = useRef<string | null>(null);
  // One detect per opened session, on entering the folder step: the mirror
  // starts empty (a fresh destination row has never been asked), and the
  // rows below are gated on its answer. A failure leaves the terminal row
  // and the Retry affordance; StrictMode's replay must not double-ask.
  // The guard ref IS the dedupe, so the array lists exactly what the body
  // reads (biome accepts the mutation's stable `mutate` member; a directive
  // here would be an unused suppression).
  useEffect(() => {
    if (sessionId !== null && detectRanFor.current !== sessionId) {
      detectRanFor.current = sessionId;
      detectHarnesses.mutate(undefined);
    }
  }, [sessionId, detectHarnesses.mutate]);
  const presetsQ = usePresets();

  const discovery = useSshDiscovery(step === "host" ? nodeId : null);
  const machine = (nodesQ.data?.nodes ?? []).find((n) => n.id === nodeId);
  const machineLabel = machine?.name ?? "the connecting machine";

  const ownedAgents = (nodesQ.data?.nodes ?? []).filter((n) => n.kind === "agent" && n.access === "owner");

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
          setSession(view);
          setCwd("");
          setStep("folder");
          onActive?.();
        },
        onError: (err) =>
          setOpenError(sshRuntimeErrorCopy(err, { host: resolved.snapshot.host, machine: machineLabel })),
      },
    );
  }

  async function launch(pick: LaunchPick) {
    if (session === null) return;
    setLaunchError(null);
    try {
      if (pick.kind === "terminal") {
        const res = await openTerminal.mutateAsync({
          sessionId: session.id,
          cwd,
          cols: Math.max(40, Math.floor(window.innerWidth / 9)),
          rows: Math.max(12, Math.floor(window.innerHeight / 22)),
        });
        void navigate({ to: "/subshells/$id", params: { id: res.subshellId } } as never);
        return;
      }
      const res = await openHarness.mutateAsync({
        sessionId: session.id,
        harnessId: pick.harnessId,
        ...(pick.kind === "preset" ? { presetId: pick.presetId } : {}),
        cwd,
      });
      void navigate({ to: "/subshells/$id", params: { id: res.subshellId } } as never);
    } catch (err) {
      setLaunchError(
        errMessage(
          err,
          pick.kind === "terminal"
            ? "The terminal could not be opened on the destination."
            : "The agent could not be opened on the destination.",
        ),
      );
    }
  }

  const [launchError, setLaunchError] = useState<string | null>(null);

  const back = (to: Step) => {
    setStep(to);
    setResolved(null);
    setOpenError(null);
    setLaunchError(null);
  };

  return (
    <Card>
      <div className="space-y-4 p-4">
        {step === "machine" && (
          <>
            <div>
              <p className="font-strong text-heading">Connect over SSH</p>
              <p className="text-detail text-muted-foreground">
                One of your machines runs ssh; a runtime serves panes on the destination. Pick the machine first.
              </p>
            </div>
            {nodesQ.isError && (
              <p role="alert" className="text-destructive text-detail">
                {errMessage(nodesQ.error, "The machine list could not be loaded.")}
              </p>
            )}
            {ownedAgents.length === 0 && !nodesQ.isLoading && (
              <p className="text-detail text-muted-foreground">
                This needs one of your own enrolled machines to run ssh from. Add one on the Nodes page.
              </p>
            )}
            <div className="space-y-2">
              {ownedAgents.map((n) => {
                const ineligible = n.maintenance ? "in maintenance" : n.status !== "online" ? "offline" : null;
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
                Pick an SSH host from this machine&apos;s config. Only alias names leave the machine.
              </p>
            </div>
            {discovery.isError && (
              <div className="space-y-2">
                <p role="alert" className="text-destructive text-detail">
                  {errMessage(
                    discovery.error,
                    `The SSH config on ${machineLabel} could not be read. This is not an empty list.`,
                  )}
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
              <p className="text-detail text-muted-foreground">Review where this connects before the session opens.</p>
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
                  <dt className="text-detail text-muted-foreground">Runs ssh from</dt>
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

        {step === "folder" && session !== null && (
          <>
            <div>
              <p className="font-strong text-heading">{destinationLabel(session)}</p>
              <p className="text-detail text-muted-foreground">
                Connected through {machineLabel}. Pick where the first pane starts, then launch.
              </p>
            </div>
            <DirBrowser sessionId={session.id} host={session.host} value={cwd} onChange={setCwd} />
            {cwd !== "" && (
              <LaunchStep
                session={session}
                cwd={cwd}
                busy={openTerminal.isPending || openHarness.isPending}
                harnesses={harnessQ.data?.harnesses ?? []}
                presets={presetsQ.data ?? []}
                detecting={detectHarnesses.isPending}
                detectError={detectHarnesses.isError}
                onDetect={() => detectHarnesses.mutate(undefined)}
                onPick={(pick) => void launch(pick)}
              />
            )}
            {launchError !== null && (
              <p role="alert" className="text-destructive text-detail">
                {launchError}
              </p>
            )}
            <Button variant="ghost" size="sm" onClick={() => back("review")} disabled={openTerminal.isPending}>
              Disconnect
            </Button>
          </>
        )}
      </div>
    </Card>
  );
}
