import { semverLt } from "@internal/subshell-protocol";
import { Button } from "@/components/ui/button";
import { DASH, MobilePair, VersionCell } from "@/components/updates/row-cells";
import { bundledServerUpdate } from "@/components/updates/server-row";
import { type DesktopShell, desktopInvoke } from "@/lib/desktop";
import type { ReleaseRef, ServerUpdateView } from "@/types/updates";

/**
 * Subshell Server — the app and the server it ships — as ONE row, inside the
 * app that manages both (spec 2026-09-18 D4).
 *
 * In a browser this page shows two rows and three update controls for what a
 * person experiences as one thing: the *Subshell Server app* row, the *Server*
 * row's release-source download, and a bundled-server sentence under it. That
 * is honest in a browser, where nothing can be installed on a machine the page
 * is not running on — but inside the app it is our packaging presented as the
 * user's decision. Each desktop bundle SHIPS the CLI it wraps, so on this
 * machine "update the app" and "update the server" are one act whose second
 * half is the first half's tail.
 *
 * So here the row states BOTH pairs and offers ONE control, which opens the
 * assistant — the only surface allowed to drive either install, and now the
 * only surface that needs to.
 *
 * **Both halves sit in the SAME COLUMNS**, as two grid rows sharing one
 * control. The first draft put the app's pair in the cells and the server's in
 * a `col-span-full` sentence underneath, which broke the only read this table
 * has — scan the middle two columns, spot the mismatch (operator's report,
 * 2026-09-18: "why is the CLI version data not in the same columns as the
 * app?"). The fold was only ever about having ONE control; it was never about
 * having one line, and taking the CLI out of the columns cost the table its
 * whole point.
 *
 * So the CLI row carries its own Running and Newest cells and, where the act
 * would be, the words "with the app" — which is why it has no button of its
 * own rather than a dash that says nothing.
 *
 * This component is never rendered in a browser — `UpdatesTable` branches on
 * `isServerDesktop()` — which is why it takes a non-null {@link DesktopShell}
 * and never checks for one.
 */
export function FoldedServerRow({
  shell,
  app,
  server,
}: {
  /** This window's own shell, already known to be Subshell Server's. */
  shell: DesktopShell;
  /** The newest published Subshell Server app, or null when none could be read. */
  app: ReleaseRef | null;
  /** The Server half, exactly as the standalone row receives it. */
  server: ServerUpdateView;
}) {
  const appBehind = app !== null && semverLt(shell.version, app.version);
  // I6: the SAME helper the standalone row uses, not a second copy of the
  // comparison. It answers "the bundle is newer than what is installed", or
  // null — including for a shell that does not report what it bundles.
  const bundledNewer = bundledServerUpdate(shell, server.current || undefined);
  const behind = appBehind || bundledNewer !== null;

  return (
    <>
      <div className="contents">
        <div className="min-w-0">
          {/* Sentence case, matching the sibling "Subshell Client app" row —
              two rows in one table must not disagree about capitalisation.
              It read "Subshell Server", which named the product rather than
              the thing this row's versions are about (operator's report,
              2026-09-18). */}
          <p className="truncate font-strong text-label">Subshell Server app</p>
          <MobilePair running={shell.version} newest={app?.version ?? DASH} />
        </div>
        <VersionCell value={shell.version} />
        <VersionCell value={app?.version ?? DASH} />
        <div className="flex flex-wrap items-center justify-end gap-2">
          {behind ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void desktopInvoke("desktop_open_assistant", { screen: "update" })}
            >
              Open the update assistant
            </Button>
          ) : (
            <span className="text-detail text-muted-foreground">{DASH}</span>
          )}
        </div>
      </div>
      <div className="contents">
        <div className="min-w-0">
          {/* "CLI", so the version beside it is unambiguously the binary's and
              not this app's — the row above carries the other one. */}
          <p className="truncate font-strong text-label">subshell-server CLI</p>
          <MobilePair running={server.current || DASH} newest={server.latest?.version ?? DASH} />
        </div>
        <VersionCell value={server.current || DASH} />
        {/*
         * **"Newest" means the newest PUBLISHED release here, exactly as it
         * does in every other row of this grid** (review finding I10).
         *
         * It briefly held the version this app BUNDLES, which can be older
         * than what has been published — so one row's column quietly meant
         * something else while looking like it obeyed the header. That breaks
         * the only read the table has (scan the middle two columns, spot the
         * mismatch) in the way hardest to notice, and combined with this app
         * rendering no standalone Server row it left an admin unable to learn
         * that a newer `subshell-server` existed at all.
         *
         * What the app ships is a fact about the ACT, not about the release
         * feed, so it lives in the act cell below.
         */}
        <VersionCell value={server.latest?.version ?? DASH} />
        <div className="flex flex-wrap items-center justify-end gap-2">
          {/* Not a dash where there is an act: this half HAS one and it is the
              row above's. M13: the no-bundle case keeps its explanation rather
              than collapsing to a bare dash — a shell that predates the `b=`
              marker, or a cached bundle, is a real state and the row said so
              before the restructure. */}
          <span className="text-detail text-muted-foreground">
            {/* `bundledServer` is OPTIONAL on the parsed shell, not nullable —
                a `=== null` check here silently never fired. */}
            {shell.bundledServer
              ? `ships ${shell.bundledServer}, with the app`
              : "this build does not report the server it ships"}
          </span>
        </div>
      </div>
    </>
  );
}
