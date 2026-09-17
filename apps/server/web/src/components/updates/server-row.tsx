import { semverLt } from "@internal/subshell-protocol";
import { LoaderCircle } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DASH, MobilePair, VersionCell } from "@/components/updates/row-cells";
import { UpdateDialog } from "@/components/updates/update-dialog";
import type { StartServerUpdate } from "@/hooks/use-updates";
import { type DesktopShell, desktopInvoke, desktopShell } from "@/lib/desktop";
import { endOnce } from "@/lib/update-copy";
import type { ServerUpdateView, UpdateJob } from "@/types/updates";

/**
 * The bundled server version when it is NEWER than the one this instance is
 * running, else null. Pure, so the comparison can be tested without a shell.
 *
 * Moved here from `components/service/update-card.tsx` (spec 2026-09-15 §6),
 * which was a whole card for one sentence on a page about the service, and it
 * is a detail line inside this row now: "this app ships a newer server" and
 * "the release source has a newer server" are two answers to one question, and
 * putting them on two pages made a person choose which one to believe.
 *
 * Both unknowns answer null rather than guessing: a shell with no `b=` does
 * not say what it bundles, and an absent `serverVersion` (a cached bundle
 * outliving its server) leaves nothing to compare against. Offering an update
 * in either case would present a guess as a fact.
 *
 * Subshell CLIENT is refused explicitly rather than left to the `b=` group's
 * absence. It ships no server, so it never sends one and the second condition
 * already covers it today — but "which app is this" is the question being
 * asked here, and answering it by the absence of an unrelated field is how a
 * later change to that field silently offers a button that raises an assistant
 * window Subshell Client does not have.
 *
 * @param shell - the desktop shell, or null in a browser
 * @param serverVersion - what this instance reports it is running
 */
export function bundledServerUpdate(shell: DesktopShell | null, serverVersion: string | undefined): string | null {
  if (shell?.app !== "server") return null;
  if (!shell.bundledServer || !serverVersion) return null;
  return semverLt(serverVersion, shell.bundledServer) ? shell.bundledServer : null;
}

/** Bytes as whole megabytes — the only unit a 70-90 MB download needs. */
function mb(bytes: number): number {
  return Math.round(bytes / 1_000_000);
}

/**
 * The one line a running job speaks through (spec §10).
 *
 * Exported so the phrasing can be tested without a running download: these are
 * the sentences a person watches for up to a minute, and the one that matters
 * most — the download's progress — is the one that cannot be staged by
 * rendering a row.
 */
export function jobLine(job: UpdateJob): string {
  switch (job.phase) {
    case "downloading":
      return job.total === null
        ? `Downloading ${job.to} (${mb(job.received)} MB)…`
        : `Downloading ${job.to} (${mb(job.received)} of ${mb(job.total)} MB)…`;
    case "verifying":
      return "Verifying…";
    case "backing-up":
      return "Backing up the database…";
    case "swapping":
      return "Installing…";
    case "restarting":
      return "Restarting…";
    case "failed":
      return `The update to ${job.to} failed: ${job.error ?? "no reason was given"}.`;
  }
}

/**
 * What this server is running, what it could be running, and the one button
 * that changes it (spec 2026-09-15 §6).
 *
 * Three states, and the row says which one it is in rather than disabling a
 * button and leaving a person to guess: up to date — where the two equal
 * version cells say it — an update available, or unavailable with every reason
 * listed. The reasons come from the server's own `canApply`, so the page never
 * offers what the route will refuse.
 *
 * The confirm dialog carries the pane-safety sentence and the forced path,
 * exactly as `RestartDialog` does — an update ends in a restart, so it
 * inherits the restart's one destructive case.
 */
export function ServerRow({
  view,
  update,
  onCheck,
  checking,
  serverVersion,
}: {
  /** The server half of `GET /api/admin/updates` */
  view: ServerUpdateView;
  /** The page's update handle */
  update: StartServerUpdate;
  /** Re-read the release source now */
  onCheck: () => void;
  /** True while that check is in flight */
  checking: boolean;
  /** What the instance reports it is running, for the bundled-server line */
  serverVersion: string | undefined;
}) {
  const [confirming, setConfirming] = useState(false);
  const bundled = bundledServerUpdate(desktopShell(), serverVersion);
  // A job is a fact about the SERVER, so it outlives this page: an admin who
  // reloads mid-update must still see the phase. `update.outcome` is this
  // tab's own story on top of it.
  const job = view.job;
  const busy = update.outcome === "running" || update.outcome === "waiting" || (job !== null && job.phase !== "failed");

  return (
    <div className="contents">
      <div className="min-w-0">
        <p className="truncate font-strong text-label">Server</p>
        <MobilePair running={view.current} newest={view.latest?.version ?? DASH} />
      </div>
      <VersionCell value={view.current} />
      <VersionCell value={view.latest?.version ?? DASH} />
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          disabled={!view.updateAvailable || !view.canApply.ok || busy}
          title={view.canApply.ok ? undefined : view.canApply.reasons[0]}
          onClick={() => setConfirming(true)}
        >
          {view.latest ? `Update to ${view.latest.version}` : "Update"}
        </Button>
        <Button variant="outline" disabled={!view.source.enabled || checking || busy} onClick={onCheck}>
          {checking ? "Checking…" : "Re-check"}
        </Button>
      </div>

      {/* Everything the old card said between its title and its buttons, in
          its order, as full-width detail lines inside the row. */}

      {/* A source that is ON but unreachable is a different fact from one
          that is off, and only the second is in `canApply.reasons` — this
          host COULD update, and could not find out whether it should. */}
      {view.latestError !== null && (
        <p className="col-span-full text-detail text-muted-foreground">
          Could not check for updates: {endOnce(view.latestError)}
        </p>
      )}

      {busy && job !== null ? (
        <p className="col-span-full flex items-center gap-2 text-sm text-warning">
          {/* The wait runs into minutes and the page loses its server in the
              middle of it, so a static sentence reads as a page that has
              stopped rather than one that is working. */}
          <LoaderCircle className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
          <span>{jobLine(job)}</span>
        </p>
      ) : update.outcome === "waiting" ? (
        <p className="col-span-full flex items-center gap-2 text-sm text-warning">
          <LoaderCircle className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
          <span>Restarting… waiting for the server to come back.</span>
        </p>
      ) : null}

      {update.outcome === "done" && update.installing && (
        <p className="col-span-full text-sm">Updated to {update.installing}.</p>
      )}
      {update.outcome === "timeout" && (
        <p className="col-span-full text-sm text-warning">
          The server has not come back. Check it on that machine with{" "}
          <span className="font-mono">subshell-server status</span>.
        </p>
      )}
      {update.outcome === "failed" && update.error && (
        <p className="col-span-full text-destructive text-sm">
          {update.installing
            ? `The update to ${update.installing} failed and ${view.current} was restored: ${update.error}`
            : update.error}
        </p>
      )}

      {/* The server's OWN record of a reverted boot, which outlives this tab
          — an update pressed from another browser, or from the CLI, reports
          its failure only here. */}
      {update.outcome === "idle" && view.lastFailure !== null && (
        <p className="col-span-full text-detail text-muted-foreground">
          The update to {view.lastFailure.to} failed and {view.lastFailure.from} was restored: {view.lastFailure.error}
        </p>
      )}

      {view.updateAvailable && !busy && (
        <p className="col-span-full text-detail text-muted-foreground">
          The database is backed up to <span className="break-all font-mono">{view.backups.dir}</span> first
          {view.backups.keep === 0 ? " (all kept)" : ` (${view.backups.keep} kept)`}.{" "}
          {view.paneSafety === "keeps"
            ? "The server restarts; open subshells keep running."
            : "The server restarts, and this machine's service definition would close every running subshell."}
        </p>
      )}

      {!view.canApply.ok &&
        view.canApply.reasons.map((reason) => (
          <p key={reason} className="col-span-full text-detail text-muted-foreground">
            Updates are unavailable: {endOnce(reason)}
          </p>
        ))}

      {view.binary.path !== null && (
        <p className="col-span-full text-detail text-muted-foreground">
          Replaces <span className="break-all font-mono">{view.binary.path}</span>.
        </p>
      )}

      {/* The bundled-server offer, folded in from the Service page's old
          UpdateCard. It renders nothing at all in a browser. Its top margin is
          the grid's own row gap, not a divider — inside a row there is nothing
          for a rule to separate. */}
      {bundled && (
        <div className="col-span-full space-y-1.5">
          <p className="text-sm">
            Subshell Server includes server {bundled}; this instance is running {serverVersion}.
          </p>
          <Button variant="outline" onClick={() => void desktopInvoke("desktop_open_assistant", { screen: "update" })}>
            Update...
          </Button>
        </div>
      )}

      <UpdateDialog
        open={confirming}
        onOpenChange={setConfirming}
        view={view}
        onConfirm={(force) => {
          setConfirming(false);
          void update.start(force ? { force: true } : {});
        }}
      />
    </div>
  );
}
