/**
 * Setting Up… — the checklist the Register press runs behind (spec 2026-09-18 § 5.6).
 *
 * One press runs three acts — install the node, enroll this machine, start
 * the node service — and this screen is the only place a person can see which
 * one is in flight. That is not decoration: this repo has already learned, in
 * the server app's reset, that **a dead button lettered "Resetting…" reads
 * identically to a hang** and was reported as one. A multi-act chain with a
 * network call in the middle is the same risk, so the rows are what make
 * "working" legible from "stuck" — and, afterwards, they are the answer to
 * "what did that just do".
 *
 * It mirrors Subshell Server's `renderProgress` / `renderHandoff`
 * (`apps/server/desktop/ui/src/wizard.ts`) so the two apps read as one
 * product, with two deliberate differences:
 *
 * - **The handoff ALWAYS waits for the press.** The server app auto-opens its
 *   dashboard on a zero-touch run; here the completed list stays on screen
 *   with a Continue, because a pane that navigates away the moment it turns
 *   into an answer is the jarring thing that was reported there (2026-09-17),
 *   and this list is the answer.
 * - **No frame glyph.** The sibling's progress screen passes `"none"` for the
 *   same reason: the checklist IS the subject, and an icon above it competes
 *   with the thing the person is watching.
 *
 * The screen decides nothing. Row states come from `@/lib/client-flow`, which
 * derives them from the probe and the act in flight (never from a timer), and
 * the failed act's words come from the CLI. This file renders them.
 */
import { Circle, CircleAlert, CircleCheck, LoaderCircle, type LucideIcon } from "lucide-react";
import { Frame, type FrameShell } from "@/components/assistant/frame";
import { Button } from "@/components/ui/button";
import type { RegisterRow } from "@/lib/client-flow";
import { cn } from "@/lib/cn";

/** How one row's state is drawn, and what it is called when it is not seen. */
interface RowStyle {
  /** The glyph. Four different SHAPES, so the state never rides on colour alone. */
  icon: LucideIcon;
  /** The glyph's role colour, and `motion-safe:animate-spin` for the one that turns. */
  iconClass: string;
  /** The label's colour: an act that has not started yet recedes. */
  labelClass: string;
  /**
   * The state, spelled out for a screen reader.
   *
   * Sight reads this off the glyph, so the word is not drawn — but a person
   * listening to a three-act chain needs to hear which act moved, and the list
   * is a live region precisely so they do.
   */
  word: string;
}

const ROW_STYLES: Record<RegisterRow["state"], RowStyle> = {
  pending: {
    icon: Circle,
    iconClass: "text-muted-foreground/60",
    labelClass: "text-muted-foreground",
    word: "Not started",
  },
  active: {
    icon: LoaderCircle,
    iconClass: "text-primary motion-safe:animate-spin",
    labelClass: "",
    word: "In progress",
  },
  done: { icon: CircleCheck, iconClass: "text-success", labelClass: "", word: "Done" },
  failed: { icon: CircleAlert, iconClass: "text-destructive", labelClass: "", word: "Failed" },
};

export function ProgressScreen(props: {
  /** Title, subtitle and the problem line — the host's half of the frame. */
  shell: FrameShell;
  /** The three acts, in the order the chain performs them. */
  rows: RegisterRow[];
  /** The failed act's verbatim CLI/Rust text; `""` when nothing failed. */
  failureOutput: string;
  /** Every row is done, so the chain is finished and Continue is owed. */
  done: boolean;
  /** Step on to the Connected screen. Never fired by this screen itself. */
  onContinue: () => void;
  /**
   * Go back to the registration details, when editing them is still safe.
   *
   * `undefined` once the machine IS registered (the service act is the only
   * one that fails after enrolment landed): the details are spent by then, and
   * offering to change them would invite a second enrolment that mints another
   * node row and discards this machine's key.
   */
  onEdit?: () => void;
  /** Re-run the chain from the top; done acts are no-ops. */
  onRetry: () => void;
  /** An act is in flight, so neither press is available. */
  busy: boolean;
}) {
  const { shell, rows, failureOutput, done, onContinue, onRetry, onEdit, busy } = props;
  const failed = rows.some((row) => row.state === "failed");
  const failure = failureOutput.trim();

  return (
    <Frame
      {...shell}
      barLeft={
        // The way BACK, and the reason it is not just Retry: an enrolment that
        // reached the control plane spends the setup key whatever it answered,
        // so `clearSpentKey` empties that field — and a Retry with an empty key
        // is refused before it spawns, which would leave this screen with
        // nothing moving and nothing to press. Editing the details is the only
        // remedy that can actually converge.
        failed && onEdit ? (
          <Button variant="ghost" disabled={busy} onClick={onEdit}>
            Edit details
          </Button>
        ) : undefined
      }
      barRight={
        /*
         * Three bars, and the middle one is the point: while the chain runs
         * there is no primary at all. A button during a run is either a lie
         * (it does nothing) or a second way to start what is already started —
         * the screen is working, and saying so is the whole job.
         */
        failed ? (
          <Button className="min-w-[120px]" disabled={busy} onClick={onRetry}>
            Retry
          </Button>
        ) : done ? (
          <Button className="min-w-[120px]" disabled={busy} onClick={onContinue}>
            Continue
          </Button>
        ) : undefined
      }
    >
      {/*
       * Ordered, because the acts are: enrolling before the node exists is
       * not a thing that can happen. `aria-live` carries the state words as
       * rows tick, which is the listening half of "legible from stuck".
       */}
      <ol aria-live="polite" className="flex w-full flex-col">
        {rows.map((row) => {
          const style = ROW_STYLES[row.state];
          const Icon = style.icon;
          return (
            <li
              key={row.id}
              data-state={row.state}
              className="grid grid-cols-[20px_1fr] items-start gap-x-4 border-border/60 border-t py-3.5 first:border-t-0"
            >
              <span aria-hidden className="flex size-5 items-center justify-center">
                <Icon className={cn("size-5", style.iconClass)} />
              </span>
              <div className="min-w-0">
                <p className={cn("font-strong text-label leading-normal", style.labelClass)}>
                  {row.label}
                  <span className="sr-only">{`, ${style.word}`}</span>
                </p>
                {/*
                 * The failed act's own words, VERBATIM and attached to the row
                 * that failed — the other rows stand as they are, so how far
                 * the chain got is still readable. `apps/node/agent` owns
                 * every operator-facing message and its strings are pinned by
                 * its own tests, so this prints them and nothing else. Same
                 * block `status-facts.tsx` uses, for the same reason.
                 */}
                {row.state === "failed" && failure !== "" && (
                  <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-destructive bg-background px-3 py-2.5 font-mono text-detail leading-relaxed">
                    {failure}
                  </pre>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </Frame>
  );
}
