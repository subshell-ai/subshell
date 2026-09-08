/**
 * The step card: what has to be true next, and the buttons that make it so.
 *
 * Every control in here is disabled while an action is in flight, which is the
 * visible half of "actions serialize" — the runner refuses a second submission
 * regardless, but a live button over a running action is an invitation to try.
 */
import { ConfirmPanel } from "@/components/confirm-panel";
import { EnrollFields } from "@/components/enroll-fields";
import { type StepContext, stepScreen } from "@/components/step-screens";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { EnrollForm } from "@/hooks/use-enroll-form";
import type { PendingConfirmation } from "@/lib/actions";
import type { StepKey } from "@/lib/steps";

export function StepCard(props: {
  step: StepKey | null;
  context: StepContext;
  form: EnrollForm;
  busy: boolean;
  /** Why the last action or probe failed, in the CLI's (or Rust's) words. */
  problem: string;
  pending: PendingConfirmation | null;
  onAccept: () => void;
  onCancel: () => void;
}) {
  const { step, context, form, busy, problem, pending, onAccept, onCancel } = props;
  const screen = stepScreen(step, context);
  const { probe, commands } = context;

  return (
    <Card>
      <CardContent className="p-4">
        {problem && <p className="mb-2.5 text-warning text-xs">{problem}</p>}
        {screen.body && <p className="text-sm">{screen.body}</p>}

        {screen.notes?.map((note) => (
          <p key={note} className="mt-2 text-muted-foreground text-xs leading-relaxed">
            {note}
          </p>
        ))}

        {screen.form && <EnrollFields form={form} busy={busy} />}

        <div className="mt-3 flex flex-wrap gap-2">
          {/*
           * A newer bundled agent is OFFERED alongside whatever step is
           * showing — never applied unasked, because installing it stops the
           * service that runs the old one. The reverse (a newer agent already
           * installed) is adopted silently and is not a choice.
           *
           * Not on the re-enroll screen: that row already ends in a
           * destructive button, and putting an unrelated one first is how the
           * wrong one gets clicked.
           */}
          {probe?.agentChoice === "upgrade-available" && step !== "enroll" && (
            <Button variant="outline" size="sm" onClick={commands.updateAgent} disabled={busy}>
              Update the agent to {probe.bundledVersion}
            </Button>
          )}
          {screen.actions.map((action) => (
            <Button
              key={action.label}
              size="sm"
              variant={action.danger ? "destructive" : action.primary ? "default" : "outline"}
              onClick={action.onClick}
              // The tmux gate: a hard stop the CLI would refuse anyway, shown
              // as disabled BEFORE the click. `probe === undefined` is "not
              // read yet" — buttons stay live then, because the first probe
              // landing is what reveals whether this gate applies at all.
              disabled={busy || (action.needsTmux === true && probe !== undefined && !probe.tmux)}
            >
              {action.label}
            </Button>
          ))}
        </div>

        {screen.hint && <p className="mt-2 text-muted-foreground text-xs">{screen.hint}</p>}

        {/*
         * Inside the step card, below its actions: a confirmation names the
         * cost of the button that was just pressed, so it belongs next to it
         * rather than over the top of the form it is about.
         */}
        {pending && <ConfirmPanel pending={pending} busy={busy} onAccept={onAccept} onCancel={onCancel} />}
      </CardContent>
    </Card>
  );
}
