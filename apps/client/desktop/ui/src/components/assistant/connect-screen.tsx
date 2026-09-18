/**
 * Connect to a Server — the watch path's one screen.
 *
 * Subshell Client is two things in one window set: a control plane's own UI,
 * and this machine's node settings. This screen is the whole of the first
 * question for someone who came only to watch: name the server, and nothing on
 * this machine is touched — no agent installed, no setup key spent, no service.
 *
 * **It remembers the address; it does not open the dashboard** (spec
 * 2026-09-18). It used to call `node_open_plane`, which persists AND opens, so
 * pressing the one button on a fresh install threw the server's dashboard on
 * screen while the setup behind it carried on — the defect this whole flow
 * exists to remove. `connectOnly` is the persisting half alone, and the
 * dashboard opens from the status screen's own button afterwards, which is the
 * screen this one hands off to.
 *
 * The old "Open in browser instead" affordance is gone from the first run by
 * the same rule (it is still on the status screen's More…, where a person who
 * has a working client can ask for it deliberately).
 *
 * The field is deliberately NOT the enrolment form's server field. That one
 * spends a setup key; this one remembers an address.
 */
import { Server } from "lucide-react";
import { useState } from "react";
import { Frame, type FrameShell } from "@/components/assistant/frame";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { NodeCommands } from "@/hooks/use-node-commands";

export function ConnectScreen(props: { shell: FrameShell; commands: NodeCommands; busy: boolean }) {
  const { shell, commands, busy } = props;
  const [typed, setTyped] = useState("");

  const empty = typed.trim() === "";
  const submit = () => {
    if (busy || empty) return;
    commands.connectOnly(typed);
  };

  return (
    <Frame
      {...shell}
      icon={<Server />}
      barRight={
        <Button className="min-w-[120px]" disabled={busy || empty} onClick={submit}>
          Connect
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
          Connecting does not register this machine. Nothing is installed here, and no subshells run here until you
          choose to register it.
        </p>
      </form>
    </Frame>
  );
}
