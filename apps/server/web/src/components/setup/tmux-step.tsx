import { Check, LoaderCircle, SquareTerminal } from "lucide-react";
import { CopyCommandRow } from "@/components/copy-command-row";
import { Button } from "@/components/ui/button";
import { tmuxInstallHint } from "@/lib/tmux-install";

/**
 * tmux on the control-plane host — the whole body of the wizard's
 * "Install tmux" screen (spec 2026-09-15 § 5.1; its own step since the
 * 2026-09-17 amendment).
 *
 * The defect it closes: tmux is what every local pane launches through, and
 * the only surface that ever said so was the NATIVE Subshell Server assistant.
 * A headless install — the whole point of that spec — learned tmux was missing
 * when its first launch failed, or never.
 *
 * It used to ride as the first `<li>` of the agent list, "in the same shape as
 * an agent row" — and the shape was the problem: the list read as a list of
 * agents, tmux is not one, and it sat under a subtitle promising "A plain
 * terminal is always available with nothing to install". As a step it owns its
 * own title, and the tick replaces a status chip.
 *
 * The step GATES on it (operator's ruling, 2026-09-18, deliberately reversing
 * spec 2026-09-15 § 5.1's non-blocking choice): the wizard's Continue is
 * disabled until the detection reports a path — see the route's tmux branch
 * for why skipping only moved the refusal to the launch step, and for the
 * Retry the body grows when the check itself fails.
 */
export function TmuxStep({
  tmuxPath,
  os,
  onInstall,
  installing = false,
  progress,
  failure,
}: {
  /**
   * Where tmux is, null when it is absent, and `undefined` while detection has
   * not answered yet.
   *
   * The three-way split is load-bearing: the admin status read is in flight
   * for a moment after the account is created, and rendering the absent state
   * during it would accuse a correct host of a defect and then take it back.
   * As a row this case rendered nothing (no row in a list is cheap silence);
   * as a whole screen silence reads as a broken page, so it says what it is
   * doing instead — the same words the Network step uses.
   */
  tmuxPath: string | null | undefined;
  /** The host's platform (`runtime.os`), which decides the command shown. */
  os: string | undefined;
  /** Runs the server-side installer. Wired only where the command needs no privilege. */
  onInstall?: () => void;
  installing?: boolean;
  /** The installer's most recent line, while it runs. */
  progress?: string;
  /** A run that failed, rendered on the screen that ran it. */
  failure?: { message: string; output?: string };
}) {
  if (tmuxPath === undefined) {
    return <p className="text-muted-foreground text-sm">Checking this machine…</p>;
  }
  const found = tmuxPath !== null;
  const hint = tmuxInstallHint(os ?? "");
  // The button exists only where the server can actually run the command. On
  // Linux the installer is `sudo apt-get`/`sudo dnf`, the server has no
  // terminal to answer a password prompt, and `POST /api/setup/tmux/install`
  // refuses it with a 409 — so offering one would ship a control that always
  // fails. There, the command is copyable and nothing more.
  const installable = !found && hint !== null && !hint.needsPrivilege && onInstall !== undefined;

  if (found) {
    // A settled fact says nothing more: no command to run, nothing to press.
    // The path is the proof, the way the checklist tick is on every surface
    // that checks a prerequisite.
    return (
      // A `fieldset`, not a `div role="group"`: the linter prescribes the
      // element, and a fieldset carries the `group` role implicitly — so the
      // `getByRole("group", { name: "tmux" })` handle the step's own test and
      // both e2e specs reach is unchanged by satisfying the rule.
      <fieldset aria-label="tmux" className="flex items-start gap-3">
        <Check aria-hidden className="mt-0.5 size-5 shrink-0 text-success" />
        <p className="font-strong">
          Found at <code className="font-mono text-detail">{tmuxPath}</code>
        </p>
      </fieldset>
    );
  }

  return (
    <fieldset aria-label="tmux" className="space-y-3">
      <div className="flex min-h-11 items-center gap-3">
        <SquareTerminal aria-hidden className="size-5 shrink-0 text-muted-foreground" />
        <span className="flex-1 font-strong text-detail text-warning">Not found</span>
        {installable && (
          <Button size="sm" disabled={installing} onClick={onInstall}>
            {/* A label that changes once and then holds still for a minute is
                how a working button comes to look like a wedged one. */}
            {installing && <LoaderCircle aria-hidden className="mr-1.5 size-3.5 animate-spin" />}
            {installing ? "Installing…" : "Install"}
          </Button>
        )}
      </div>
      {!installing && !failure && (
        <div className="grid gap-2 pl-9">
          {/* The cost, said once and plainly. Every local pane runs inside
              tmux, so this is not a missing convenience — it is the machine
              being unable to run anything. */}
          <p className="text-detail text-muted-foreground">
            Subshells cannot launch on this machine without it.{" "}
            {hint === null && <>Install tmux on this machine and this screen will pick it up.</>}
          </p>
          {hint !== null && (
            <>
              <CopyCommandRow text={hint.command} />
              {hint.alternatives.map((command) => (
                // Which package manager a Linux host has is not knowable from
                // here — the server probes for it when the install is asked
                // for — so the alternative is stated rather than guessed at.
                <CopyCommandRow key={command} text={command} />
              ))}
            </>
          )}
        </div>
      )}
      {installing && (
        <div className="pl-9">
          {/* The installer's own words, one line, verbatim. There is no
              percentage to derive from a package manager, and inventing stages
              it does not report would be worse than showing what it says. */}
          <p aria-live="polite" className="truncate font-mono text-detail text-muted-foreground">
            {progress ?? "Starting the installer…"}
          </p>
        </div>
      )}
      {failure && (
        <div className="pl-9">
          <p className="text-destructive text-detail">{failure.message}</p>
          {failure.output !== undefined && failure.output.trim() !== "" && (
            <details className="mt-1 text-sm">
              <summary className="cursor-pointer text-detail text-muted-foreground">What the installer printed</summary>
              <pre className="mt-1 max-h-48 overflow-auto text-detail">{failure.output}</pre>
            </details>
          )}
        </div>
      )}
    </fieldset>
  );
}
