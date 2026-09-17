import { SUBSHELL_REPO_SLUG, semverLt } from "@internal/subshell-protocol";
import { Button } from "@/components/ui/button";
import { DASH, MobilePair, RowRule, VersionCell } from "@/components/updates/row-cells";
import { desktopInvoke, desktopShell } from "@/lib/desktop";
import type { ReleaseRef, UpdatesView } from "@/types/updates";

/** Where a release's own page lives, for the browser rows. */
export function releasePageUrl(tag: string): string {
  return `https://github.com/${SUBSHELL_REPO_SLUG}/releases/tag/${tag}`;
}

/**
 * The two desktop apps, and how a person updates the one they are in (spec §6).
 *
 * The three surfaces get three different things, and the split is not
 * cosmetic — it follows what each window is ALLOWED to do:
 *
 * - **Subshell Server** gets a button, because `desktop_open_assistant` is one
 *   of the six commands its remote window holds, and `app-update` is one more
 *   screen name on an existing closed enum. Zero new grants.
 * - **Subshell Client** gets a SENTENCE, because its remote window is granted
 *   exactly one command (`desktop_open_in_browser`) and this design does not
 *   widen it. The update lives on its bundled node page, reached from the tray.
 * - **A browser** gets links. Nothing here can install anything on a machine
 *   the page is not running on.
 *
 * The row cells carry what the old card put in one sentence: the app reading
 * its OWN row knows its own version, so "behind" is knowable there and nowhere
 * else — the other app's row, and every row from a browser, states versions
 * and offers the way out, never a verdict.
 */
export function DesktopRows({ desktop }: { desktop: UpdatesView["desktop"] }) {
  const shell = desktopShell();
  const rows: { app: "server" | "client"; name: string; release: ReleaseRef | null }[] = [
    { app: "server", name: "Subshell Server app", release: desktop.server },
    { app: "client", name: "Subshell Client app", release: desktop.client },
  ];

  return (
    <>
      {rows.map(({ app, name, release }, index) => {
        const running = shell?.app === app ? shell.version : DASH;
        const newest = release?.version ?? DASH;
        const behind = shell?.app === app && release !== null && semverLt(shell.version, release.version);
        const assistant = behind && app === "server";
        const link = shell === null && release !== null;
        return (
          <div key={app} className="contents">
            {index > 0 && <RowRule />}
            <div className="min-w-0">
              <p className="truncate font-strong">{name}</p>
              <MobilePair running={running} newest={newest} />
            </div>
            <VersionCell value={running} />
            <VersionCell value={newest} />
            {/* An up-to-date row needs no act — the equal version cells say it
                — and the app behind its OWN row gets its way out from the
                surface it is on: a button here, a sentence below (Client),
                never a link. A browser is the one reader with nothing to
                raise, so only it gets the release page. */}
            <div className="flex flex-wrap items-center justify-end gap-2">
              {assistant && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void desktopInvoke("desktop_open_assistant", { screen: "app-update" })}
                >
                  Open the update assistant
                </Button>
              )}
              {shell === null && release !== null && (
                <a
                  href={releasePageUrl(release.tag)}
                  target="_blank"
                  rel="noreferrer"
                  className="text-detail underline hover:text-foreground"
                >
                  Release notes and downloads
                </a>
              )}
              {!assistant && !link && <span className="text-detail text-muted-foreground">{DASH}</span>}
            </div>
            {behind && app === "client" && (
              <p className="col-span-full text-detail text-muted-foreground">
                Open the tray menu → This Machine… → Update.
              </p>
            )}
          </div>
        );
      })}
      {desktop.server === null && desktop.client === null && (
        <p className="col-span-full text-detail text-muted-foreground">
          No desktop release could be read from the release source.
        </p>
      )}
    </>
  );
}
