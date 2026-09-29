import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, errMessage } from "@internal/node-admin";
import { Link } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { NodeHarnessRow } from "@/components/nodes/node-harness-row";
import { useHarnesses, useNodeHarnesses } from "@/hooks/use-harnesses";
import { type AgentCommandKind, type AgentInstallResult, useAgentCommand } from "@/hooks/use-install-agent";
import { useRecheckNode } from "@/hooks/use-nodes";

/** A run that RAN and said no: it either never started or exited non-zero. */
function runFailure(data: AgentInstallResult): { message: string; output: string } {
  return {
    message:
      data.exitCode === null ? "The command could not be started." : `The command exited with code ${data.exitCode}.`,
    output: data.output,
  };
}

/**
 * Which harnesses this machine can RUN (spec 2026-09-10): detection output,
 * not a plugin manager. The rows are the node view's — one per plugin the
 * INSTANCE has installed and enabled, crossed with this machine's binary
 * answer (server-side `inventory.ts → effectiveHarnessStates`): a live probe
 * for `local`, the cached detection for an enrolled node. A row whose plugin
 * the instance dropped never arrives, and this card adds rows from nothing
 * else — the old catalog lookup that listed uninstalled plugins as install
 * extras is gone with the per-node plugin route (Task 9).
 *
 * Two former branches are gone because they stopped being facts about THIS
 * machine: `broken` and `restartRequired` describe plugin loading in the
 * control-plane process, and the instance plugins page says so. Rendering
 * them here would attribute an instance failure to one node.
 *
 * The only control is Re-check, gated by the SAME rule the server's recheck
 * route applies — `nodeCanConfigure` (owner or `edit`;
 * `api/src/lib/node-access.ts`, and the security posture states it plainly:
 * "edit (or owner) additionally configures the node (re-checks)"). It is
 * deliberately NOT `canManage`: on an agent that flag is owner-or-admin-on-
 * local, narrower than what the route honours, and hiding a permitted action
 * is a capability regression. `access` is server-derived on the view (admins
 * resolve to `edit` there), so this mirrors the gate without re-deriving
 * admin identity client-side. `local` is excluded outright — its view probes
 * live on every read, and the recheck route answers it 400.
 *
 * **On `local`, and only there, a row that is missing its program also gets
 * an Install button on its own line** (spec 2026-09-15 § 5.3; the button
 * reads just "Install" since the card is already about THIS machine). This is not the plugin
 * management that left with Task 9 — it installs the CLI a plugin drives, not
 * the plugin — and it exists because `POST /api/setup/agents/:id/install` had
 * exactly one entrance, the first-run wizard's step 2: skip that screen and
 * there was no path back to it, ever. The gate is `canManage`, which on
 * `local` is the SERVER's own word for "an admin" and is the same gate the
 * route applies; an enrolled node never offers it, because the route can only
 * install on the control-plane host (installing on a remote node is out of
 * scope, spec 2026-09-11 § 11) and a button naming the wrong machine is worse
 * than no button. A ready row on `local` offers Update the same way: the
 * vendor's own update command when the plugin declares one, else a re-run of
 * the installer (spec 2026-09-28 § 2). On an enrolled node the server cannot
 * run the command yet, so a ready row shows it as a copy line instead.
 */
export function NodeHarnessCard({ nodeId }: { nodeId: string }) {
  const { harnesses, data, isLoading } = useNodeHarnesses(nodeId);
  const recheck = useRecheckNode(nodeId);
  // The registry, for the install command and the plugin TYPE — neither of
  // which rides a node view. Read unconditionally rather than only on
  // `local`: the hook takes no `enabled`, the key is shared with the launch
  // form and the preset editor so a warm cache costs nothing, and gating it
  // would mean two copies of what the row component is handed.
  const { data: registry } = useHarnesses();
  /** The running command's own line, keyed `kind:id`. */
  const [cmdLines, setCmdLines] = useState<Record<string, string>>({});
  // A blank line is spacing in a command's output, not progress; showing one
  // would blank the only thing on screen that is saying anything. (Same rule
  // the install button had; it now serves both kinds.)
  const noteLine = (kind: AgentCommandKind) => (id: string, line: string) => {
    if (line.trim() !== "") setCmdLines((prev) => ({ ...prev, [`${kind}:${id}`]: line }));
  };
  const install = useAgentCommand("install", noteLine("install"));
  const update = useAgentCommand("update", noteLine("update"));

  if (isLoading) return <p className="text-muted-foreground text-sm">Loading…</p>;

  // The web-side mirror of `nodeCanConfigure` — the SPA hand-mirrors the
  // server's view model and its rules (see `types/node.ts`), and no helper
  // for this one existed here. `access` is "none" nowhere a view exists, so
  // owner|edit is exactly the route's gate. Same SHAPE as the sections'
  // `managesNodeSections` (which it may superficially resemble) but a
  // different concept: this gates the Re-check ROUTE, not the section tabs.
  // Do not collapse them into one predicate on the strength of the spelling.
  const canRecheck = data !== undefined && data.kind === "agent" && (data.access === "owner" || data.access === "edit");
  // `canManage` is server-derived and, on `local`, resolves to admin — the
  // same answer the install route's own cookie gate gives.
  const canInstallHere = data?.kind === "local" && data.canManage;
  /** Whichever command is running, so exactly one row spins. */
  const active = install.isPending
    ? { kind: "install" as const, id: install.variables }
    : update.isPending
      ? { kind: "update" as const, id: update.variables }
      : undefined;
  /**
   * Why the last command did not work, under whichever row ran it. The two
   * different failures said differently, as before: the CALL failing is
   * `.error`, while a command that RAN and exited non-zero is `data.ok:false`
   * carrying its own output.
   */
  const failure: { id: string; kind: AgentCommandKind; message: string; output?: string } | undefined =
    install.error && install.variables
      ? {
          id: install.variables,
          kind: "install" as const,
          message: errMessage(install.error, "Couldn't run the installer."),
        }
      : update.error && update.variables
        ? {
            id: update.variables,
            kind: "update" as const,
            message: errMessage(update.error, "Couldn't run the updater."),
          }
        : install.data && !install.data.ok && install.variables
          ? { id: install.variables, kind: "install" as const, ...runFailure(install.data) }
          : update.data && !update.data.ok && update.variables
            ? { id: update.variables, kind: "update" as const, ...runFailure(update.data) }
            : undefined;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Harnesses</CardTitle>
        <CardDescription>
          Which agents this machine can run: one row per plugin the instance has installed, matched against what
          detection found here. Plugins themselves are managed under{" "}
          <Link to="/settings/plugins" className="underline">
            Settings → Plugins
          </Link>
          , not per node.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {canRecheck && (
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={recheck.isPending}
              onClick={() => recheck.mutate()}
            >
              <RefreshCw /> {recheck.isPending ? "Re-checking…" : "Re-check"}
            </Button>
            {recheck.isSuccess && (
              <p className="text-detail text-success">Re-check sent. Inventory will refresh shortly.</p>
            )}
          </div>
        )}
        {recheck.isError && (
          <p role="alert" className="text-destructive text-detail">
            {errMessage(recheck.error, "Re-check failed. The node may be offline.")}
          </p>
        )}

        {data?.inventoryStale && (
          <p className="text-muted-foreground text-sm">
            The inventory may be outdated. These states are last-known, not live; a re-check refreshes them.
          </p>
        )}

        {harnesses.length === 0 && (
          <p className="text-muted-foreground text-sm">
            Nothing to report: either no plugins are installed on the instance, or this node hasn't been detected yet.
          </p>
        )}

        {/* A headerless table: ONE grid for every row, so the four columns
            share their tracks and line up down the card. Each row was its own
            flex before, where the name took the slack and pushed the rest
            right — which put every row's badge at a different place, since the
            version strings are different widths. `auto` tracks size to the
            widest cell, which is the alignment a table gives and a row of
            flex items cannot.

            Rows are `display: contents` (see the fragment's inner wrapper):
            the row element itself draws nothing, so its cells are the grid's
            own children. That is also why every cell is ALWAYS rendered, even
            empty — a skipped cell would slide the rest of that row one column
            left.

            Two columns below `sm`, four above: version and the action cell
            fall to a second line on a phone rather than crushing the name. */}
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 sm:grid-cols-[minmax(0,1fr)_auto_auto_auto]">
          {harnesses.map((h) => {
            const info = registry?.find((r) => r.id === h.harnessId);
            // The card owns the hooks, the gates and the two mutations; the
            // row gets its OWN slice of the command state, scoped here so the
            // row never re-derives which row a running or failed command
            // belongs to. The `kind` on `failure` is unused by the row's
            // rendering and rides along because the card's failure object is
            // what the id match selects.
            const mine = active?.id === h.harnessId ? active : undefined;
            const mineFailure = failure?.id === h.harnessId ? failure : undefined;
            return (
              <NodeHarnessRow
                key={h.harnessId}
                harness={h}
                info={info}
                nodeKind={data?.kind ?? "agent"}
                canInstallHere={canInstallHere}
                commandRunning={active !== undefined}
                activeKind={mine?.kind}
                cmdLine={mine ? cmdLines[`${mine.kind}:${h.harnessId}`] : undefined}
                failure={mineFailure}
                // A fresh command clears the OTHER kind's failure first:
                // `failure` above reads both mutations, and TanStack resets
                // only a mutation's own state on its next mutate - without
                // this, an install that failed under this row keeps showing
                // while the update runs and masks the update's own failure.
                // `cmdLines` is component state keyed `kind:id`, not mutation
                // state, so a reset never blanks a still-streaming line.
                onInstall={() => {
                  update.reset();
                  install.mutate(h.harnessId);
                }}
                onUpdate={() => {
                  // The mirror of the install button's reset: this
                  // mutation's own state is cleared by mutate, the other
                  // kind's only by this call.
                  install.reset();
                  update.mutate(h.harnessId);
                }}
              />
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
