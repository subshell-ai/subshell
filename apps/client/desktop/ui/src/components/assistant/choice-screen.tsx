/**
 * Choice — "what did you come to do?" (spec 2026-09-18 § 4).
 *
 * The screen the old Connect screen refused to be. There are two real use
 * cases and the first run used to assume the second: *watch* a server, and
 * *register* this machine so subshells run on it. Asking once, here, is what
 * lets each path afterwards be a straight line — and it is the only place the
 * two are ever presented as alternatives.
 *
 * **One press picks AND advances.** Not a radio group with a Continue under
 * it: there is nothing to review between choosing and going, so a second press
 * would only be a second chance to mis-click. The bottom bar is therefore
 * empty on this screen, which is also why neither option is styled as the
 * primary — the question has no recommended answer, and a filled button beside
 * an outlined one would answer it for the reader.
 *
 * Each option is a line item (design system: `label` over `detail`, differing
 * by weight AND colour) and its detail names the CONSEQUENCE rather than the
 * mechanism — "nothing is installed or registered" is the fact a person
 * choosing between these two needs, in the sibling app's own voice
 * (`supervisionGroup`, `apps/server/desktop/ui/src/wizard.ts`).
 *
 * The press reports the choice and nothing else: routing, and every command
 * either path runs, belong to the host.
 */
import { Cpu, Server, Signpost } from "lucide-react";
import type { ReactNode } from "react";
import { Frame, type FrameShell } from "@/components/assistant/frame";
import { Button } from "@/components/ui/button";

/** What the two options answer with. `watch` connects; `node` registers. */
export type FirstRunChoice = "node" | "watch";

export function ChoiceScreen(props: { shell: FrameShell; onChoose: (choice: FirstRunChoice) => void; busy: boolean }) {
  const { shell, onChoose, busy } = props;
  return (
    <Frame {...shell} icon={<Signpost />}>
      {/*
       * No `role="group"` and no `aria-label`: the design system's choice-group
       * pattern is about RADIOS, which need a name because a radio's own label
       * is half a sentence. These are two buttons, each announcing its label
       * AND its detail line, under a frame heading that asks the question — so
       * a group would only restate the heading, and a restated string is one
       * that can drift out of step with it.
       */}
      <div className="flex flex-col gap-3">
        <ChoiceOption
          icon={<Cpu aria-hidden />}
          label="Run subshells on this machine"
          detail="Registers this machine as a node, so agent sessions can run here."
          disabled={busy}
          onSelect={() => onChoose("node")}
        />
        <ChoiceOption
          icon={<Server aria-hidden />}
          label="Connect to a server"
          detail="Just opens a Subshell server's dashboard. Nothing is installed or registered."
          disabled={busy}
          onSelect={() => onChoose("watch")}
        />
      </div>
    </Frame>
  );
}

/**
 * One option: a full-width button carrying a line item.
 *
 * `h-auto` + `whitespace-normal` undo the button's single-line defaults — the
 * detail wraps — and the icon is sized up from the base `size-4` because this
 * is a target the size of a card rather than a control in a bar.
 */
function ChoiceOption(props: {
  icon: ReactNode;
  label: string;
  detail: string;
  disabled: boolean;
  onSelect: () => void;
}) {
  const { icon, label, detail, disabled, onSelect } = props;
  return (
    <Button
      variant="outline"
      className="h-auto w-full items-start justify-start gap-3 whitespace-normal px-4 py-4 text-left [&_svg]:mt-1 [&_svg]:size-5"
      disabled={disabled}
      onClick={onSelect}
    >
      {icon}
      <span className="flex flex-col gap-1">
        <span className="text-label">{label}</span>
        <span className="font-regular text-detail text-muted-foreground leading-relaxed">{detail}</span>
      </span>
    </Button>
  );
}
