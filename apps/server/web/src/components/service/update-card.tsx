import { semverLt } from "@internal/subshell-protocol";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { type DesktopShell, desktopInvoke, desktopShell } from "@/lib/desktop";

/**
 * The bundled server version when it is NEWER than the one this instance is
 * running, else null. Pure, so the comparison can be tested without a shell.
 *
 * Both unknowns answer null rather than guessing: a shell with no `b=` does
 * not say what it bundles, and an absent `serverVersion` (a cached bundle
 * outliving its server) leaves nothing to compare against. Offering an
 * update in either case would present a guess as a fact.
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
export function updateAvailable(shell: DesktopShell | null, serverVersion: string | undefined): string | null {
  if (shell?.app !== "server") return null;
  if (!shell.bundledServer || !serverVersion) return null;
  return semverLt(serverVersion, shell.bundledServer) ? shell.bundledServer : null;
}

/**
 * Desktop only: this app ships a newer server than the one it is talking to.
 *
 * The press names a SCREEN and nothing more — the update itself is a press
 * inside the bundled assistant page, because installing a binary and
 * restarting a service is exactly the kind of act a served page may not
 * perform (spec 2026-09-12 § 2). In a browser the card does not render at
 * all, since there would be nothing behind the button.
 */
export function UpdateCard({ serverVersion }: { serverVersion: string | undefined }) {
  const next = updateAvailable(desktopShell(), serverVersion);
  if (!next) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Update available</CardTitle>
        <CardDescription>
          Subshell Server includes server {next}; this instance is running {serverVersion}.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button onClick={() => void desktopInvoke("desktop_open_assistant", { screen: "update" })}>Update...</Button>
      </CardContent>
    </Card>
  );
}
