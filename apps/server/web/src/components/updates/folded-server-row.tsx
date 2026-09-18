import { semverLt } from "@internal/subshell-protocol";
import { Button } from "@/components/ui/button";
import { DASH, MobilePair, VersionCell } from "@/components/updates/row-cells";
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
 * **The version cells hold the APP's pair**, because the row is named for the
 * app and the app is what the press replaces first; the server's pair is the
 * detail line under it. Putting the server's numbers in the cells would make
 * the row's own name disagree with its columns.
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
  // The release source's newest server, and separately the one this app ships.
  // Either can be ahead of what is installed, and the assistant installs the
  // BUNDLED one — so the sentence names that, not the release index's.
  const bundled = shell.bundledServer ?? null;
  const serverBehind = bundled !== null && server.current !== "" && semverLt(server.current, bundled);
  const behind = appBehind || serverBehind;

  return (
    <div className="contents">
      <div className="min-w-0">
        <p className="truncate font-strong text-label">Subshell Server</p>
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
      {/* The second pair, as a detail line rather than a second row: it is the
          same act's other half, and a row of its own would be the two controls
          this design just removed, wearing one name. */}
      <p className="col-span-full text-detail text-muted-foreground">
        {bundled === null
          ? `subshell-server ${server.current || DASH}. This build does not report the server it ships.`
          : serverBehind
            ? `subshell-server ${server.current} → ${bundled}, installed with the app.`
            : `subshell-server ${server.current} — the version this app ships.`}
      </p>
    </div>
  );
}
