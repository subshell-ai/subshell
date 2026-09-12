import type { JSX } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { desktopInvoke } from "@/lib/desktop";

/**
 * Whether the danger card may render (spec 2026-09-10 § 6).
 *
 * Both halves are required: an admin, and this page running under the SERVER
 * desktop app's UA marker. `undefined` counts as not-admin (unknown ≠ open,
 * the same rule the route's own gate uses). Visibility is UX, not security -
 * the security gate is the bundled-page-only ACL behind the button - but the
 * desktop half is honesty: the reset verb lives in the Subshell Server
 * assistant, and Subshell Client strips the marker, so an entry point rendered
 * anywhere else would be a button that lies.
 */
export function resetCardVisible(opts: { viewerIsAdmin?: boolean; desktop: boolean }): boolean {
  return opts.viewerIsAdmin === true && opts.desktop;
}

/**
 * The dashboard's entry into the machine reset: a button that raises the
 * Subshell Server assistant at its reset screen. The card itself confirms
 * nothing and destroys nothing - the whole chain runs in that window.
 */
export function ResetServerCard(): JSX.Element {
  return (
    <Card className="border-destructive/50">
      <CardHeader>
        <CardTitle>Reset this server</CardTitle>
        <CardDescription>
          Stops and uninstalls the Subshell Server service, closes this machine&apos;s panes, and deletes the instance
          data: accounts, sessions, API keys, signing keys, pane logs, plugins, and the server configuration. Enrolled
          nodes and any subshell agent on this machine are not touched and will need to be re-enrolled or stopped
          separately. The installed server binary stays. There is no undo.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {/* The confirmation and the whole chain run in the Subshell Server window: it is the only surface
            that may drive the CLI. This button raises the assistant at its reset screen. An older desktop
            build knows no such command and `desktopInvoke` resolves null rather than throwing, so the worst
            skew is a press that does nothing visible. */}
        <Button variant="destructive" onClick={() => void desktopInvoke("desktop_open_assistant", { screen: "reset" })}>
          Reset this server…
        </Button>
      </CardContent>
    </Card>
  );
}
