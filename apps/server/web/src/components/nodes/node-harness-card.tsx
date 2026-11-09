import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, errMessage } from "@internal/node-admin";
import { Link } from "@tanstack/react-router";
import { ArrowUpCircle, LoaderCircle, RefreshCw } from "lucide-react";
import { useState } from "react";
import { PluginIcon } from "@/components/plugin-icon";
import { useHarnesses, useNodeHarnesses } from "@/hooks/use-harnesses";
import { useInstallAgent } from "@/hooks/use-install-agent";
import { useRecheckNode } from "@/hooks/use-nodes";
import { type HarnessUpdateResult, useUpdateHarness } from "@/hooks/use-update-harness";
import type { HarnessInfo } from "@/types/harness";

/** What a row of {@link NodeHarnessCard} knows about one program on this machine. */
interface DetectionRow {
  /** The node's answer: the program was found here */
  installed: boolean;
  /** Why the lookup failed, when it ran and failed. Absent when it never ran. */
  reason?: string;
  /** When the probe ran. Absent when no probe has covered this plugin yet. */
  checkedAt?: string;
}

/**
 * The row's one-word detection verdict — and one of the four is "we do not
 * know", which is NOT the same claim as "not found".
 *
 * A row carries no `reason` only when nothing looked: either no detection has
 * covered this plugin on this node at all (no `checkedAt` either — a node
 * enrolled but never probed, or one offline since the plugin was installed),
 * or a probe ran and threw, which `scanOne` records deliberately without a
 * reason because "the probe failed" is different from "we looked and it was
 * not there". Every real miss travels with a reason (`binary-lookup.ts` gives
 * one on every `path: null` path), so reading its absence as a missing program
 * asserted a negative nothing had established — the card said "program not
 * found" about a machine that may well have the CLI.
 */
function detectionLabel(h: DetectionRow): string {
  if (h.installed || h.reason === "no-binary") return "ready";
  if (h.reason) return "program not found";
  return h.checkedAt ? "check failed" : "not checked";
}

/**
 * Whether this row's program can be installed from here — the client half of
 * `POST /api/setup/agents/:pluginId/install`'s own refusals.
 *
 * It needs the HARNESS REGISTRY, not the node view, and that is the whole
 * reason this card reads a second endpoint: a node's row carries detection
 * (is the program here?) and no manifest, so the install COMMAND and the
 * agent/terminal type live only on `GET /api/setup/harnesses`. Both of the
 * route's pre-stream refusals are mirrored — `terminal` drives no program, and
 * an empty command 400s — because a button that always fails is worse than no
 * button.
 *
 * @param info - the registry row for this plugin, absent when the registry has
 *   no such id (a registry-installed plugin the built-in catalog never lists)
 */
function installableHere(info: HarnessInfo | undefined): boolean {
  return info !== undefined && info.type === "agent-harness" && info.install.command.trim() !== "";
}

/**
 * Whether this row offers an update on this machine: the CLI is actually
 * here, and the plugin declares an update path (`update.command`, which the
 * server resolves to the vendor's update line, or the installer when that is
 * idempotent). A harness with no program — `terminal`, an ssh pane — has
 * nothing to update, and a missing program's row offers Install instead.
 */
function updatableHere(info: HarnessInfo | undefined, installed: boolean): boolean {
  return info !== undefined && installed && info.type === "agent-harness" && info.update.command.trim() !== "";
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
 * Two controls act on this machine. **Re-check** is gated by the SAME rule
 * the server's recheck route applies — `nodeCanConfigure` (owner or `edit`;
 * `api/src/modules/nodes/access.ts`, and the security posture states it plainly:
 * "edit (or owner) additionally configures the node (re-checks)"). It is
 * deliberately NOT `canManage`: on an agent that flag is owner-or-admin-on-
 * local, narrower than what the route honours, and hiding a permitted action
 * is a capability regression. `access` is server-derived on the view (admins
 * resolve to `edit` there), so this mirrors the gate without re-deriving
 * admin identity client-side. `local` is excluded from Re-check outright —
 * its view probes live on every read, and the recheck route answers it 400.
 * Permission alone does not light Re-check: detection needs a LIVE socket,
 * and an offline or HELD node answers nothing but `update`, so the button
 * sits disabled with the reason in its title rather than trading a press for
 * a 409.
 *
 * **Update and Update all** (issue 250) run each harness CLI's own update
 * line on the machine that holds it: in this process for `local`, through
 * the signed `harness_update` command for an enrolled node. The same
 * `nodeCanConfigure` gate applies, and `local` IS allowed here — the server
 * can update its own tools. A remote node must be live for the same reason
 * Re-check must. The button exists only on a row whose CLI is installed AND
 * whose plugin declares an update path (`update.command`, resolved by the
 * server to the vendor's line, or to the installer when that is idempotent).
 * Update all walks the same per-row action sequentially, so two package
 * managers never run over one filesystem at once.
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
 * than no button.
 */
export function NodeHarnessCard({ nodeId }: { nodeId: string }) {
  const { harnesses, data, isLoading } = useNodeHarnesses(nodeId);
  const recheck = useRecheckNode(nodeId);
  // The registry, for the install command and the plugin TYPE — neither of
  // which rides a node view. Read unconditionally rather than only on
  // `local`: the hook takes no `enabled`, the key is shared with the launch
  // form and the preset editor so a warm cache costs nothing, and gating it
  // would mean two copies of the row renderer below.
  const { data: registry } = useHarnesses();
  const update = useUpdateHarness(nodeId);
  /** Per-harness results and failures, so two rows can finish at different times. */
  const [updateResults, setUpdateResults] = useState<Record<string, HarnessUpdateResult>>({});
  const [updateErrors, setUpdateErrors] = useState<Record<string, string>>({});
  /** Harness ids a run is in flight for, in order — "Update all" walks them one at a time. */
  const [updatingIds, setUpdatingIds] = useState<string[]>([]);
  const [updatingAll, setUpdatingAll] = useState(false);
  /** The installer's latest line, per plugin id — see the render below. */
  const [installLines, setInstallLines] = useState<Record<string, string>>({});
  const install = useInstallAgent((id, line) => {
    // A blank line is spacing in an installer's output, not progress; showing
    // one would blank the only thing on screen that is saying anything.
    if (line.trim() !== "") setInstallLines((prev) => ({ ...prev, [id]: line }));
  });

  if (isLoading) return <p className="text-muted-foreground text-sm">Loading…</p>;

  // The web-side mirror of `nodeCanConfigure` — the SPA hand-mirrors the
  // server's view model and its rules (see `types/node.ts`), and no helper
  // for this one existed here. `access` is "none" nowhere a view exists, so
  // owner|manage|edit is exactly the route's gate (manage joined at spec
  // 2026-11-07; it ranks above edit, so a manage grantee re-checks too). Same
  // SHAPE as the sections' `managesNodeSections` (which it may superficially
  // resemble) but a different concept: this gates the Re-check ROUTE, not the
  // section tabs. Do not collapse them into one predicate on the strength of
  // the spelling.
  const canRecheck =
    data !== undefined &&
    data.kind === "agent" &&
    (data.access === "owner" || data.access === "manage" || data.access === "edit");
  // Permission is only half the button's truth: re-check is a DETECTION
  // command over the live socket, and a node with no live socket cannot run
  // one. A HELD link drops it too (held answers `update` only), so the honest
  // state set is exactly `online` — same split the Update card draws from the
  // server's own `canUpdate` rule, with the held half landing the other way.
  const recheckReachable = data?.status === "online";
  // `canManage` is server-derived and, on `local`, resolves to admin — the
  // same answer the install route's own cookie gate gives.
  const canInstallHere = data?.kind === "local" && data.canManage;
  /** The id currently installing, so only its own row spins. */
  const installingId = install.isPending ? install.variables : undefined;
  /** The id whose last install ended, so a failure renders under the row that failed. */
  const settledId = install.isPending ? undefined : install.variables;
  /**
   * Why the last install did not work, or undefined when it did.
   *
   * Two different failures said differently, as on the wizard's screen: the
   * CALL failing (the server refused, the network went) is `install.error`,
   * while a command that RAN and exited non-zero comes back `ok: false` with
   * the installer's own output — which is the case worth showing, and the one
   * a bare error line would have hidden.
   */
  const installFailure = install.error
    ? { message: errMessage(install.error, "Couldn't run the installer.") }
    : install.data && !install.data.ok
      ? {
          message:
            install.data.exitCode === null
              ? "The installer could not be started."
              : `The installer exited with code ${install.data.exitCode}.`,
          output: install.data.output,
        }
      : undefined;

  // The update action's gate is `nodeCanConfigure` on ANY node — unlike
  // Re-check, `local` runs it too, so the `kind === "agent"` narrowing is not
  // part of this predicate. A remote node must be live: the command travels
  // the signed link, and a held socket answers none.
  const canUpdate =
    data !== undefined && (data.access === "owner" || data.access === "manage" || data.access === "edit");
  const updateReachable = data?.kind === "local" || data?.status === "online";
  const updatableIds = harnesses
    .filter((h) =>
      updatableHere(
        registry?.find((r) => r.id === h.harnessId),
        h.installed,
      ),
    )
    .map((h) => h.harnessId);
  const updateBusy = updatingIds.length > 0;

  /**
   * One harness, awaited. Everything is per-row: a row's own spinner, its own
   * output on failure, and its own error line, so a failure on the fourth of
   * five names the harness it belongs to.
   */
  async function runUpdate(id: string): Promise<void> {
    setUpdatingIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
    setUpdateErrors((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    try {
      const result = await update.mutateAsync(id);
      setUpdateResults((prev) => ({ ...prev, [id]: result }));
    } catch (err) {
      setUpdateErrors((prev) => ({ ...prev, [id]: errMessage(err, "Couldn't update this harness.") }));
    } finally {
      setUpdatingIds((prev) => prev.filter((x) => x !== id));
    }
  }

  /**
   * Every updatable harness, SEQUENTIALLY. Two package managers over one
   * filesystem is a race, and one harness's failure must not stop the rest —
   * so the loop carries on and each row reports itself.
   */
  async function runUpdateAll(): Promise<void> {
    setUpdatingAll(true);
    try {
      for (const id of updatableIds) await runUpdate(id);
    } finally {
      setUpdatingAll(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Harnesses</CardTitle>
        <CardDescription>
          Agents available on this machine, based on installed plugins and the most recent check. Manage plugins for all
          nodes under{" "}
          <Link to="/settings/plugins" className="underline">
            Settings → Plugins
          </Link>
          , not per node.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {(canRecheck || (canUpdate && updatableIds.length > 0)) && (
          <div className="flex flex-wrap items-center gap-3">
            {/* Update all walks the same per-row action, one at a time: the
                rows below show which harness is running right now. */}
            {canUpdate && updatableIds.length > 0 && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                // Same mutual exclusion as a row's Update button: an install
                // is another package-manager run over this machine.
                disabled={updateBusy || install.isPending || !updateReachable}
                disabledReason={
                  !updateReachable
                    ? "The node is offline. Wait for it to reconnect before updating."
                    : install.isPending
                      ? "Wait for the current installation to finish."
                      : "Wait for the current update to finish."
                }
                onClick={() => void runUpdateAll()}
              >
                <ArrowUpCircle /> {updatingAll ? "Updating…" : "Update all"}
              </Button>
            )}
            {canRecheck && (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  // Detection probes binaries, so it waits while a package
                  // manager is rewriting them: a mid-update or mid-install
                  // probe would otherwise report a harness missing.
                  disabled={recheck.isPending || updateBusy || install.isPending || !recheckReachable}
                  disabledReason={
                    !recheckReachable
                      ? "The node is offline. Wait for it to reconnect before checking."
                      : updateBusy
                        ? "Wait for the current update to finish."
                        : install.isPending
                          ? "Wait for the current installation to finish."
                          : "Wait for the current check to finish."
                  }
                  onClick={() => recheck.mutate()}
                >
                  <RefreshCw /> {recheck.isPending ? "Re-checking…" : "Re-check"}
                </Button>
                {recheck.isSuccess && (
                  <p className="text-detail text-success">Re-check sent. The harness list will refresh shortly.</p>
                )}
              </>
            )}
          </div>
        )}
        {recheck.isError && (
          <p role="alert" className="text-destructive text-detail">
            {errMessage(recheck.error, "Re-check failed. The node may be offline.")}
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
            // Only what is MISSING is offered: a program already here has
            // nothing to install, and `installableHere` holds the route's own
            // two refusals.
            const offerInstall = canInstallHere && !h.installed && installableHere(info);
            const offerUpdate = canUpdate && updatableHere(info, h.installed);
            const updatingThis = updatingIds.includes(h.harnessId);
            const updateResult = updateResults[h.harnessId];
            const updateError = updateErrors[h.harnessId];
            return (
              <div key={h.harnessId} className="contents">
                {/* Named by the node view itself: every row carries the display
                  name from the instance store's manifest (spec 2026-09-10
                  follow-ups), so the page needs no second registry read and a
                  registry-installed plugin is named exactly like a built-in. */}
                <div className="flex min-w-0 items-center gap-3">
                  <PluginIcon pluginId={h.harnessId} name={h.name} />
                  <span className="truncate font-strong">{h.name}</span>
                </div>
                {/* The text is the detection answer: whether the program this
                  plugin drives was found on this machine. `no-binary` reads
                  ready because a plugin that declares no program is not one
                  whose program is missing. */}
                <span className="justify-self-start">{detectionLabel(h)}</span>
                <span className="font-mono text-detail text-muted-foreground">{h.version ?? ""}</span>
                {/* The action cell, ALWAYS rendered — the grid rule above says
                  a skipped cell slides the rest of the row one column left.
                  This is where the `checked …` stamp sat until 2026-09-22,
                  when the operator asked for the install button on the
                  harness's own line instead; the stamp came off, not the
                  data (the detection `checkedAt` still drives the unknown
                  states below, and Re-check still says when in its own
                  line). */}
                {offerInstall && info ? (
                  <Button
                    type="button"
                    size="sm"
                    // One at a time, and never beside an update: both act on
                    // this machine's filesystem, and the update route already
                    // serializes its own runs.
                    disabled={install.isPending || updateBusy}
                    disabledReason={
                      updateBusy ? "Wait for the current update to finish." : "Wait for installation to finish."
                    }
                    onClick={() => install.mutate(h.harnessId)}
                  >
                    {installingId === h.harnessId && <LoaderCircle aria-hidden className="motion-safe:animate-spin" />}
                    {installingId === h.harnessId ? "Installing…" : "Install"}
                  </Button>
                ) : offerUpdate && info ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    // One at a time across the whole card: the update route
                    // refuses a concurrent run on the same harness, and
                    // "Update all" is a sequential walk of this same action.
                    disabled={updateBusy || !updateReachable || install.isPending}
                    disabledReason={
                      !updateReachable
                        ? "The node is offline. Wait for it to reconnect before updating."
                        : install.isPending
                          ? "Wait for the current installation to finish."
                          : "Wait for the current update to finish."
                    }
                    // What the button runs, without a press: the line is the
                    // vendor's own, and it is about to run on a machine.
                    title={`Runs ${info.update.command}`}
                    onClick={() => void runUpdate(h.harnessId)}
                  >
                    {updatingThis && <LoaderCircle aria-hidden className="motion-safe:animate-spin" />}
                    {updatingThis ? "Updating…" : "Update"}
                  </Button>
                ) : (
                  <span aria-hidden />
                )}
                {h.reason === "override-invalid" && (
                  <p className="col-span-full text-detail text-muted-foreground">
                    An environment variable overrides where this program is looked for, and it doesn't point at an
                    executable file on this node.
                  </p>
                )}
                {h.reason === "no-binary" && (
                  <p className="col-span-full text-detail text-muted-foreground">No separate program is needed here.</p>
                )}
                {/* The unknown states, spelled out: neither says anything about
                  whether the program is here, because nothing established it. */}
                {!h.installed && !h.reason && h.checkedAt === undefined && (
                  <p className="col-span-full text-detail text-muted-foreground">
                    This plugin hasn't been checked on this machine yet. Opening this page starts a check if the node is
                    online.
                  </p>
                )}
                {!h.installed && !h.reason && h.checkedAt !== undefined && (
                  <p className="col-span-full text-detail text-muted-foreground">
                    The check didn't finish. Try Re-check to see whether this program is installed.
                  </p>
                )}
                {offerInstall && info && (
                  /* What the button above will do, without a click. This runs
                    a vendor's script on the control-plane host as the
                    server's own user, which should not take a press to
                    find out. */
                  <p className="col-span-full text-detail text-muted-foreground">
                    Runs <code className="font-mono">{info.install.command}</code> on this machine, as the user the
                    server runs as.
                  </p>
                )}
                {installingId === h.harnessId && (
                  // The installer's own words, one line, verbatim: there is no
                  // percentage to derive from `curl … | bash`, and inventing
                  // stages it does not report would be worse than showing what
                  // it says.
                  <p aria-live="polite" className="col-span-full truncate font-mono text-detail text-muted-foreground">
                    {installLines[h.harnessId] ?? "Starting the installer…"}
                  </p>
                )}
                {settledId === h.harnessId && installFailure && (
                  // Under the row that failed, never under the list: a failure
                  // on the fourth of five agents rendered at the bottom of the
                  // card names none of them.
                  <div className="col-span-full space-y-1">
                    <p className="text-destructive text-detail">{installFailure.message}</p>
                    {installFailure.output !== undefined && installFailure.output.trim() !== "" && (
                      <details className="text-sm">
                        <summary className="cursor-pointer text-detail text-muted-foreground">
                          What the installer printed
                        </summary>
                        <pre className="mt-1 max-h-48 overflow-auto text-detail">{installFailure.output}</pre>
                      </details>
                    )}
                  </div>
                )}
                {updatingThis && (
                  <p aria-live="polite" className="col-span-full truncate font-mono text-detail text-muted-foreground">
                    {info ? `Running ${info.update.command}` : "Running the update…"}
                  </p>
                )}
                {!updatingThis && updateError !== undefined && (
                  <p role="alert" className="col-span-full text-destructive text-detail">
                    {updateError}
                  </p>
                )}
                {!updatingThis &&
                  updateError === undefined &&
                  updateResult !== undefined &&
                  // A run that FAILED is the case worth showing, and the
                  // installer rows' own precedent: the command's output is
                  // the disclosure, so it rides a details block rather than
                  // a bare error line. A success says so and lets the
                  // refetched version speak for itself.
                  (updateResult.ok ? (
                    <p className="col-span-full text-detail text-success">Updated.</p>
                  ) : (
                    <div className="col-span-full space-y-1">
                      <p className="text-destructive text-detail">
                        {updateResult.timedOut
                          ? "The update timed out. It may still be running."
                          : updateResult.exitCode === null
                            ? "The update command could not be started."
                            : `The update exited with code ${updateResult.exitCode}.`}
                      </p>
                      {updateResult.output.trim() !== "" && (
                        <details className="text-sm">
                          <summary className="cursor-pointer text-detail text-muted-foreground">
                            What the update printed
                          </summary>
                          <pre className="mt-1 max-h-48 overflow-auto text-detail">{updateResult.output}</pre>
                        </details>
                      )}
                    </div>
                  ))}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
