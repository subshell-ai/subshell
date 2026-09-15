import { SUBSHELL_REPO_SLUG, semverLt } from "@internal/subshell-protocol";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { type DesktopShell, desktopInvoke, desktopShell } from "@/lib/desktop";
import type { ReleaseRef, UpdatesView } from "@/types/updates";

/** Where a release's own page lives, for the browser rows. */
export function releasePageUrl(tag: string): string {
  return `https://github.com/${SUBSHELL_REPO_SLUG}/releases/tag/${tag}`;
}

/**
 * What this row says, given the release and the shell reading it.
 *
 * Pure and exported, because the three cases are the point and only one of
 * them can be rendered on any given machine: the app updating ITSELF knows its
 * own version and says how far behind it is; the OTHER app is a release a
 * person can go and fetch; and a browser is neither, so it links.
 *
 * `null` means the row says nothing at all — there is no release to name.
 *
 * @param app - which app this row is about
 * @param release - that app's newest release, or null
 * @param shell - the shell this page is rendered in, or null in a browser
 */
export function desktopRowText(
  app: "server" | "client",
  release: ReleaseRef | null,
  shell: DesktopShell | null,
): string | null {
  const name = app === "server" ? "Subshell Server" : "Subshell Client";
  if (release === null) return null;
  if (shell?.app === app) {
    // The app reading its own row knows its own version, so it can say
    // whether there is anything to do rather than only what exists.
    return semverLt(shell.version, release.version)
      ? `${name} ${release.version} is available; this app is ${shell.version}.`
      : `${name} ${release.version} — this app is up to date.`;
  }
  return `${name} ${release.version} is the newest release.`;
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
 */
export function DesktopCard({ desktop }: { desktop: UpdatesView["desktop"] }) {
  const shell = desktopShell();
  const rows: { app: "server" | "client"; release: ReleaseRef | null }[] = [
    { app: "server", release: desktop.server },
    { app: "client", release: desktop.client },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Desktop apps</CardTitle>
        <CardDescription>
          {desktop.server === null && desktop.client === null
            ? "No desktop release could be read from the release source."
            : "The newest releases of the two desktop apps."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {rows.map(({ app, release }) => {
          const text = desktopRowText(app, release, shell);
          if (text === null) return null;
          const behind = shell?.app === app && semverLt(shell.version, release?.version ?? "0.0.0");
          return (
            <div key={app} className="space-y-1.5">
              <p className="text-sm">{text}</p>
              {behind && app === "server" && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void desktopInvoke("desktop_open_assistant", { screen: "app-update" })}
                >
                  Open the update assistant
                </Button>
              )}
              {behind && app === "client" && (
                <p className="text-detail text-muted-foreground">Open the tray menu → This Machine… → Update.</p>
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
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
