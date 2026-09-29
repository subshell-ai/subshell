import type { NodeDetail, NodeHarness } from "@internal/node-admin";
import { Badge, Button } from "@internal/node-admin";
import { LoaderCircle } from "lucide-react";
import { PluginIcon } from "@/components/plugin-icon";
import type { AgentCommandKind } from "@/hooks/use-install-agent";
import type { HarnessInfo } from "@/types/harness";

/** What the row knows about one program on this machine (the detection half of a view row). */
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
 * reason the card reads a second endpoint: a node's row carries detection
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
 * The command an Update affordance would run for this plugin: the vendor's
 * own if declared, else a re-run of the installer, exactly the service's
 * fallback. Undefined when neither exists (terminal): no button, no copy
 * line, mirroring the route's own "nothing to update" refusal.
 */
function updateCommandFor(info: HarnessInfo | undefined): string | undefined {
  if (info?.type !== "agent-harness") return undefined;
  const cmd = info.update ?? info.install.command;
  return cmd.trim() !== "" ? cmd : undefined;
}

export interface NodeHarnessRowProps {
  /** The node view's row: display name, detection answer, version. */
  harness: NodeHarness;
  /** The instance registry's row for this plugin; undefined when it has no such id. */
  info: HarnessInfo | undefined;
  /** The node kind: only an enrolled node gets the copy line, only `local` the buttons. */
  nodeKind: NodeDetail["kind"];
  /** `local` + manager: the server can run install/update on this machine. */
  canInstallHere: boolean;
  /** True while EITHER row's command runs — the routes 409 a second concurrent command. */
  commandRunning: boolean;
  /** This row's command while it runs; undefined when this row is idle. */
  activeKind: AgentCommandKind | undefined;
  /** The running command's own last streamed line, when it has emitted one. */
  cmdLine: string | undefined;
  /** Why this row's last command failed, when it was this row that failed. */
  failure: { kind: AgentCommandKind; message: string; output?: string } | undefined;
  /** The Install press: the card owns the mutations and resets the other kind first. */
  onInstall: () => void;
  /** The Update press: same seam as Install. */
  onUpdate: () => void;
}

/**
 * One row of {@link NodeHarnessCard}: the four grid cells (name, detection
 * badge, version, action) plus the full-width explanation lines under them.
 * Dumb by construction — it reads its scoped command state off props and
 * presses callbacks, owning no hook, no mutation, no card-level gate. The row
 * derives `installableHere` and `updateCommandFor` from the registry row, the
 * documented client mirror of the route's pre-stream refusals; what arrives
 * pre-derived from the card are the node-view gates (`canInstallHere`, the
 * copy-line kind check).
 *
 * Every explanation it renders is `detail` on the grid's `col-span-full`: the
 * `checked …` stamp left the action cell on 2026-09-22 (the install button
 * moved onto the harness's own line), and the unknown states spell out what
 * a badge of "not checked" / "check failed" refuses to claim.
 */
export function NodeHarnessRow({
  harness: h,
  info,
  nodeKind,
  canInstallHere,
  commandRunning,
  activeKind,
  cmdLine,
  failure,
  onInstall,
  onUpdate,
}: NodeHarnessRowProps) {
  // Only what is MISSING is offered: a program already here has nothing to
  // install, and `installableHere` holds the route's own two refusals.
  const offerInstall = canInstallHere && !h.installed && installableHere(info);
  const cmdText = updateCommandFor(info);
  // Update is for a program that IS here (unlike Install, which is for one
  // that is not); gate-mirrored like install: local + admin. `showCopyLine`
  // is the honest half on a node the server cannot drive: the exact command
  // to run there, printed, never run (spec 2026-09-28 §2; Phase 2 turns this
  // line into a button via a signed command). Both already imply `cmdText`
  // is set — that is the one narrowing, so the JSX below re-checks nothing.
  const offerUpdate = h.installed && canInstallHere && cmdText !== undefined;
  const showCopyLine = h.installed && nodeKind === "agent" && cmdText !== undefined;
  return (
    <div className="contents">
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
      {/* The action cell, ALWAYS rendered — the card's grid rule says
        a skipped cell slides the rest of the row one column left.
        This is where the `checked …` stamp sat until 2026-09-22,
        when the operator asked for the install button on the
        harness's own line instead; the stamp came off, not the
        data (the detection `checkedAt` still drives the unknown
        states, and Re-check still says when in its own line). */}
      {offerInstall && info ? (
        <Button
          type="button"
          size="sm"
          // One at a time, either kind: the routes answer a second
          // concurrent command 409, so a second button that could
          // be pressed would only produce a refusal.
          disabled={commandRunning}
          onClick={onInstall}
        >
          {activeKind === "install" && <LoaderCircle aria-hidden className="motion-safe:animate-spin" />}
          {activeKind === "install" ? "Installing…" : "Install"}
        </Button>
      ) : offerUpdate ? (
        <Button type="button" size="sm" disabled={commandRunning} onClick={onUpdate}>
          {activeKind === "update" && <LoaderCircle aria-hidden className="motion-safe:animate-spin" />}
          {activeKind === "update" ? "Updating…" : "Update"}
        </Button>
      ) : (
        <span aria-hidden />
      )}
      {h.reason === "override-invalid" && (
        <p className="col-span-full text-detail text-muted-foreground">
          An environment variable overrides where this program is looked for, and it doesn't point at an executable file
          on this node.
        </p>
      )}
      {h.reason === "no-binary" && (
        <p className="col-span-full text-detail text-muted-foreground">No separate program is needed here.</p>
      )}
      {/* The unknown states, spelled out: neither says anything about
        whether the program is here, because nothing established it. */}
      {!h.installed && !h.reason && h.checkedAt === undefined && (
        <p className="col-span-full text-detail text-muted-foreground">
          No detection has covered this plugin here yet. Opening this page asks for one; an offline node cannot answer.
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
          Runs <code className="font-mono">{info.install.command}</code> on this machine, as the user the server runs
          as.
        </p>
      )}
      {offerUpdate && (
        <p className="col-span-full text-detail text-muted-foreground">
          Runs <code className="font-mono">{cmdText}</code> on this machine, as the user the server runs as.
        </p>
      )}
      {showCopyLine && (
        <p className="col-span-full text-detail text-muted-foreground">
          Run <code className="font-mono">{cmdText}</code> on this machine. The server can't do it on a node yet.
        </p>
      )}
      {activeKind !== undefined && (
        // The command's own words, one line, verbatim (unchanged
        // rule): there is no percentage to derive from `curl … | bash`.
        <p aria-live="polite" className="col-span-full truncate font-mono text-detail text-muted-foreground">
          {cmdLine ?? (activeKind === "update" ? "Running the update…" : "Starting the installer…")}
        </p>
      )}
      {failure !== undefined && (
        // Under the row that failed, never under the list: a failure
        // on the fourth of five agents rendered at the bottom of the
        // card names none of them.
        <div className="col-span-full space-y-1">
          <p className="text-destructive text-detail">{failure.message}</p>
          {failure.output !== undefined && failure.output.trim() !== "" && (
            <details className="text-sm">
              <summary className="cursor-pointer text-detail text-muted-foreground">What the command printed</summary>
              <pre className="mt-1 max-h-48 overflow-auto text-detail">{failure.output}</pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
