/**
 * How this node runs — the one question v1 asks about start-up
 * (spec 2026-09-18 § 5.2, plan Task 8).
 *
 * The node always runs as a background service: a launchd agent on macOS, a
 * systemd user unit on Linux. The alternative Subshell Server offers — running
 * the process as the app's own child — is **deferred** here and deliberately
 * not mentioned: a node's panes are tmux servers parented to the daemon, so the
 * signal and respawn discipline is its own design, and this app has no
 * supervisor to do it with. Naming a mode that does not exist would be the
 * screen describing our backlog.
 *
 * So the one decision is whether the service is armed at login, and it is the
 * boolean the register chain passes to `service install` (`--no-autostart` when
 * off). Default ON, which is what installing has always done.
 *
 * The login sentence is the server's own, in `apps/server/web`'s
 * supervision card and the assistant's `supervisionGroup` — the same words on
 * every surface, with "node" where those say "server".
 */
import { Power } from "lucide-react";
import { Frame, type FrameShell } from "@/components/assistant/frame";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { IS_MACOS } from "@/lib/copy";

export function StartupScreen(props: {
  shell: FrameShell;
  startAtLogin: boolean;
  onChange: (startAtLogin: boolean) => void;
  onContinue: () => void;
  /** Back to the registration details. */
  onBack?: () => void;
  busy: boolean;
}) {
  const { shell, startAtLogin, onChange, onContinue, onBack, busy } = props;
  // The manager's name goes in the SENTENCE, where it explains something,
  // rather than in a title as a parenthetical that explains nothing — the
  // supervision card's rule, and a genuine platform fact rather than voice.
  const manager = IS_MACOS ? "A launchd agent" : "A systemd user service";

  return (
    <Frame
      {...shell}
      icon={<Power />}
      barLeft={
        // Back to the details, because this screen sits between a form and the
        // press that spends a setup key: a person who gets here and realises
        // they typed the wrong server must not have to quit the app to fix it.
        onBack ? (
          <Button variant="ghost" disabled={busy} onClick={onBack}>
            Back
          </Button>
        ) : undefined
      }
      barRight={
        /*
         * **Register**, not Continue: this is the press that acts. It installs
         * the agent if there is none, enrols this machine — spending the setup
         * key — and installs the service with the answer above. The screen
         * before it collects the details and says Continue, because it spends
         * nothing (operator, 2026-09-18).
         */
        <Button className="min-w-[120px]" disabled={busy} onClick={onContinue}>
          Register
        </Button>
      }
    >
      <p className="text-muted-foreground text-sm leading-relaxed">
        {manager} runs this node in the background, whether or not Subshell Client is open.
      </p>
      <div className="mt-6 flex items-start gap-3">
        <Switch
          id="node-autostart"
          aria-label="Start at login"
          checked={startAtLogin}
          disabled={busy}
          onCheckedChange={(next) => onChange(next)}
        />
        <div className="flex flex-col gap-1">
          <Label htmlFor="node-autostart">Start at login</Label>
          <p className="text-detail text-muted-foreground leading-relaxed">
            Starts the node again the next time you log in to this machine. Without it, the service runs now but nothing
            brings it back after you log out or restart.
          </p>
          {/*
           * Linux only, and it is not a refinement of the line above but a
           * different question: an enabled --user unit's lifetime is the LOGIN
           * SESSION unless logind is told otherwise, which on a machine nobody
           * logs in to is the difference between a node and nothing
           * (`apps/node/agent/src/service.ts`, which prints the same remedy).
           */}
          {!IS_MACOS && (
            <p className="text-detail text-muted-foreground leading-relaxed">
              Start at login arms a systemd user unit, which comes back at login and dies at logout unless this user
              lingers — <span className="font-mono">loginctl enable-linger $USER</span> makes it come back at boot
              instead.
            </p>
          )}
        </div>
      </div>
    </Frame>
  );
}
