/**
 * The way back to the control plane — the OTHER half of what this app is.
 *
 * Subshell Client is two things in one window set: the plane's own UI, and this
 * machine's node settings. The plane's UI is a separate window loading a remote
 * origin, so it cannot be reached from inside this page's own document; this
 * card is the door.
 *
 * Two renders, and the difference is whether an address is settled:
 *
 * - **known** — one line and a button. The address came from the stored
 *   preference or from the enrolled node's own `serverUrl`, resolved on the
 *   Rust side, so it is the address that will actually open.
 * - **unknown** — a URL field. A client is not required to be a node: someone
 *   who only watches subshells never enrols, so there may be no `config.json`
 *   to read an address out of, and typing one has to be possible without going
 *   near the enrolment form.
 *
 * The field is deliberately NOT the enrolment form's server field. That one
 * spends a setup key; this one opens a window. Sharing it would make "show me
 * the plane" and "register this machine" one gesture, which is exactly the
 * conflation the app's two windows exist to undo.
 */
import { ExternalLink } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { NodeSettings } from "@/lib/ipc";

export function PlaneCard(props: {
  settings: NodeSettings | undefined;
  busy: boolean;
  /** `null` opens the settled address; a string opens (and remembers) that one. */
  onOpen: (url: string | null) => void;
}) {
  const { settings, busy, onOpen } = props;
  const known = settings?.planeUrl ?? null;
  const [typed, setTyped] = useState("");

  if (known !== null) {
    return (
      <Card>
        <CardContent className="flex items-center justify-between gap-3 p-4">
          <div className="min-w-0">
            <p className="text-muted-foreground text-xs">Control plane</p>
            <p className="mt-0.5 truncate font-mono text-xs">{known}</p>
          </div>
          <Button size="sm" onClick={() => onOpen(null)} disabled={busy}>
            <ExternalLink aria-hidden />
            Open
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-2 p-4">
        <Label htmlFor="plane-url" className="text-xs">
          Control plane
        </Label>
        <p className="text-muted-foreground text-xs">
          The address of the Subshell server you want to watch. Opening it does not register this machine.
        </p>
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (busy) return;
            onOpen(typed);
          }}
        >
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
          <Button type="submit" size="sm" disabled={busy || typed.trim() === ""}>
            <ExternalLink aria-hidden />
            Open
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
