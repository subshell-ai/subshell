import { SUBSHELL_REPO_SLUG, semverLt } from "@internal/subshell-protocol";
import { DASH, MobilePair, RowRule, VersionCell } from "@/components/updates/row-cells";
import { desktopShell } from "@/lib/desktop";
import type { ReleaseRef, UpdatesView } from "@/types/updates";

/** Where a release's own page lives, for the browser rows. */
export function releasePageUrl(tag: string): string {
  return `https://github.com/${SUBSHELL_REPO_SLUG}/releases/tag/${tag}`;
}

/**
 * The two desktop apps, and how a person updates the one they are in (spec §6).
 *
 * Each surface gets what it is ALLOWED to do, which is why they differ:
 *
 * - **Subshell Client** gets a SENTENCE, because its remote window is granted
 *   exactly one command (`desktop_open_in_browser`) and no design here widens
 *   it. The update lives on its bundled node page, reached from the tray.
 * - **A browser** gets links. Nothing here can install anything on a machine
 *   the page is not running on.
 *
 * **Subshell Server's own row is no longer one of these** (spec 2026-09-18
 * D4). It used to carry a button raising the `app-update` screen; inside that
 * app the row is now FOLDED into the Server row, because the app ships the
 * server and updating them separately was our packaging presented as the
 * user's decision — see `folded-server-row.tsx`, which owns that button and
 * the one screen it now opens. So the branch that drew it here is gone rather
 * than left unreachable: `assistant` required `shell.app === "server"`, and
 * this component is never asked for that row in that shell.
 *
 * The row cells carry what the old card put in one sentence: the app reading
 * its OWN row knows its own version, so "behind" is knowable there and nowhere
 * else — the other app's row, and every row from a browser, states versions
 * and offers the way out, never a verdict.
 */
export function DesktopRows({
  desktop,
  apps = ["server", "client"],
}: {
  desktop: UpdatesView["desktop"];
  /**
   * Which of the two rows to draw, in this order.
   *
   * Inside Subshell Server the server row is FOLDED into the Server row
   * (`folded-server-row.tsx`, spec 2026-09-18 D4), so this component is asked
   * for the client alone. An explicit list rather than an `omit` flag because
   * the caller is naming what it wants rendered, and a negative prop would
   * have to be read twice to answer that.
   */
  apps?: readonly ("server" | "client")[];
}) {
  const shell = desktopShell();
  const rows: { app: "server" | "client"; name: string; release: ReleaseRef | null }[] = [
    { app: "server", name: "Subshell Server app", release: desktop.server },
    { app: "client", name: "Subshell Client app", release: desktop.client },
  ].filter((row) => apps.includes(row.app as "server" | "client")) as {
    app: "server" | "client";
    name: string;
    release: ReleaseRef | null;
  }[];

  return (
    <>
      {rows.map(({ app, name, release }, index) => {
        const running = shell?.app === app ? shell.version : DASH;
        const newest = release?.version ?? DASH;
        const behind = shell?.app === app && release !== null && semverLt(shell.version, release.version);
        const link = shell === null && release !== null;
        return (
          <div key={app} className="contents">
            {index > 0 && <RowRule />}
            <div className="min-w-0">
              <p className="truncate font-strong text-label">{name}</p>
              <MobilePair running={running} newest={newest} />
            </div>
            <VersionCell value={running} />
            <VersionCell value={newest} />
            {/* An up-to-date row needs no act — the equal version cells say
                it — and the app behind its OWN row gets its way out from the
                surface it is on: a sentence below (Client). A browser is the
                one reader with nothing to raise, so only it gets the release
                page. */}
            <div className="flex flex-wrap items-center justify-end gap-2">
              {link && (
                <a
                  href={releasePageUrl(release.tag)}
                  target="_blank"
                  rel="noreferrer"
                  className="text-detail underline hover:text-foreground"
                >
                  Release notes and downloads
                </a>
              )}
              {!link && <span className="text-detail text-muted-foreground">{DASH}</span>}
            </div>
            {behind && app === "client" && (
              <p className="col-span-full text-detail text-muted-foreground">
                Open the tray menu → This Machine… → Update.
              </p>
            )}
          </div>
        );
      })}
      {rows.length > 0 && rows.every((row) => row.release === null) && (
        <p className="col-span-full text-detail text-muted-foreground">
          No desktop release could be read from the release source.
        </p>
      )}
    </>
  );
}
