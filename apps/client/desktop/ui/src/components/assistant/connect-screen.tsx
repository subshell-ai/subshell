/**
 * Connect to a Server — the first screen a fresh install shows.
 *
 * Subshell Client is two things in one window set: a control plane's own UI,
 * and this machine's node settings. The plane's UI is a separate window
 * loading a remote origin, so it cannot be reached from inside this document;
 * this screen is the door, and it comes FIRST because without an address the
 * app has nothing to show in its other window — and "register this machine" is
 * a question about a server the person has not named yet.
 *
 * The field is deliberately NOT the enrolment form's server field. That one
 * spends a setup key; this one opens a window. Sharing them would make "show
 * me the plane" and "register this machine" one gesture, which is exactly the
 * conflation the app's two windows exist to undo.
 */
import { ExternalLink, Server } from "lucide-react";
import { useEffect, useState } from "react";
import { Frame, type FrameShell } from "@/components/assistant/frame";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { NodeCommands } from "@/hooks/use-node-commands";

export function ConnectScreen(props: { shell: FrameShell; commands: NodeCommands; busy: boolean }) {
  const { shell, commands, busy } = props;
  const [typed, setTyped] = useState("");
  /**
   * Whether the pending open should finish in the SYSTEM browser.
   *
   * `node_open_plane_url` re-reads the settled address rather than taking one
   * from this page, so an address that has never been saved cannot be opened
   * in a browser at all — the URL has to be persisted first. The runner
   * serializes actions and drops a second submission while one is in flight,
   * so the two cannot be fired together: this flag hands off to the effect
   * below, which runs the second once the first has landed.
   */
  const [wantBrowser, setWantBrowser] = useState(false);

  useEffect(() => {
    if (!wantBrowser || busy) return;
    setWantBrowser(false);
    commands.openPlaneUrl();
  }, [wantBrowser, busy, commands]);

  const empty = typed.trim() === "";
  const submit = () => {
    if (busy || empty) return;
    commands.openPlane(typed);
  };

  return (
    <Frame
      {...shell}
      icon={<Server />}
      barLeft={
        <Button
          variant="ghost"
          disabled={busy || empty}
          onClick={() => {
            if (busy || empty) return;
            // Persists AND opens the app window — `node_open_plane` is the
            // only command that remembers the address, and there is no
            // save-without-opening. The browser follows once it lands.
            setWantBrowser(true);
            commands.openPlane(typed);
          }}
        >
          Open in browser instead
        </Button>
      }
      barRight={
        <Button className="min-w-[120px]" disabled={busy || empty} onClick={submit}>
          <ExternalLink aria-hidden />
          Open
        </Button>
      }
    >
      <form
        className="mx-auto flex w-[360px] flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Label htmlFor="plane-url" className="text-muted-foreground text-detail">
          Server URL
        </Label>
        <Input
          id="plane-url"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder="https://subshell.example.com"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          disabled={busy}
        />
        <p className="text-muted-foreground text-detail leading-relaxed">
          Opening a server does not register this machine. Enrolling comes after, and only if you want subshells to run
          here.
        </p>
      </form>
    </Frame>
  );
}
