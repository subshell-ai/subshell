import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  errMessage,
} from "@internal/node-admin";
import { Link } from "@tanstack/react-router";
import { LoaderCircle, RefreshCw } from "lucide-react";
import { useState } from "react";
import { PluginIcon } from "@/components/plugin-icon";
import { useHarnesses, useNodeHarnesses } from "@/hooks/use-harnesses";
import { useInstallAgent } from "@/hooks/use-install-agent";
import { useRecheckNode } from "@/hooks/use-nodes";
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
function badgeLabel(h: DetectionRow): string {
  if (h.installed || h.reason === "no-binary") return "ready";
  if (h.reason) return "program not found";
  return h.checkedAt ? "check failed" : "not checked";
}

/** The tone that verdict carries: found, definitely missing, or unknown. */
function badgeVariant(h: DetectionRow): "success" | "muted" | "outline" {
  if (h.installed || h.reason === "no-binary") return "success";
  return h.reason ? "muted" : "outline";
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
  // owner|edit is exactly the route's gate. Same SHAPE as the sections'
  // `managesNodeSections` (which it may superficially resemble) but a
  // different concept: this gates the Re-check ROUTE, not the section tabs.
  // Do not collapse them into one predicate on the strength of the spelling.
  const canRecheck = data !== undefined && data.kind === "agent" && (data.access === "owner" || data.access === "edit");
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
            // Only what is MISSING is offered: a program already here has
            // nothing to install, and `installableHere` holds the route's own
            // two refusals.
            const offerInstall = canInstallHere && !h.installed && installableHere(info);
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
                {/* The badge is the detection answer: whether the program this
                  plugin drives was found on this machine. `no-binary` reads
                  ready because a plugin that declares no program is not one
                  whose program is missing. */}
                <Badge variant={badgeVariant(h)} className="justify-self-start">
                  {badgeLabel(h)}
                </Badge>
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
                    // One at a time: the route answers a second concurrent
                    // install 409, so a second button that could be pressed
                    // would only produce a refusal.
                    disabled={install.isPending}
                    onClick={() => install.mutate(h.harnessId)}
                  >
                    {installingId === h.harnessId && <LoaderCircle aria-hidden className="motion-safe:animate-spin" />}
                    {installingId === h.harnessId ? "Installing…" : "Install"}
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
                    No detection has covered this plugin here yet. Opening this page asks for one; an offline node
                    cannot answer.
                  </p>
                )}
                {!h.installed && !h.reason && h.checkedAt !== undefined && (
                  <p className="col-span-full text-detail text-muted-foreground">
                    The probe did not complete, so whether this program is here is unknown.
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
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
