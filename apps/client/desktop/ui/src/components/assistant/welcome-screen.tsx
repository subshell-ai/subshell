/**
 * Welcome — the first screen a machine with nothing set up yet sees
 * (spec 2026-09-18 § 4).
 *
 * It is the one screen in this app that is INERT BY CONSTRUCTION: it holds no
 * command, no field and no probe, and the press only steps forward. That is
 * the point of it existing at all — the screen it replaced as the front door
 * was Connect, whose primary button persisted an address and opened a window,
 * so a person who had just installed the app and was trying to set it up got a
 * jump to a dashboard as the headline action (spec § 1).
 *
 * It mirrors Subshell Server's `renderWelcome` (`apps/server/desktop/ui/src/wizard.ts`)
 * — glyph, one sentence, Continue — so the two apps read as one product.
 *
 * **The sentence lives HERE, not in the shell's subtitle.** The frame renders
 * `shell.subtitle` above this content, so `subtitleFor("welcome")` must answer
 * `undefined` or the screen says the same thing twice. One sentence, and it
 * names BOTH halves of this app: the app is a client that can also make its
 * machine a node, and a first run that mentioned only one of them would teach
 * the wrong shape on the screen before the one that asks which you came for.
 */
import { Sparkles } from "lucide-react";
import { Frame, type FrameShell } from "@/components/assistant/frame";
import { Button } from "@/components/ui/button";

export function WelcomeScreen(props: { shell: FrameShell; onContinue: () => void; busy: boolean }) {
  const { shell, onContinue, busy } = props;
  return (
    <Frame
      {...shell}
      icon={<Sparkles />}
      barRight={
        <Button className="min-w-[120px]" disabled={busy} onClick={onContinue}>
          Continue
        </Button>
      }
    >
      <p className="text-center text-body text-muted-foreground leading-relaxed">
        This app connects you to a Subshell server, and can optionally run subshells on this machine.
      </p>
    </Frame>
  );
}
