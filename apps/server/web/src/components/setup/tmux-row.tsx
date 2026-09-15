import { LoaderCircle, SquareTerminal } from "lucide-react";
import { CopyCommandRow } from "@/components/copy-command-row";
import { Button } from "@/components/ui/button";
import { tmuxInstallHint } from "@/lib/tmux-install";

/**
 * tmux on the control-plane host, pinned above the agent list on the Add an
 * Agent screen (spec 2026-09-15 § 5.1).
 *
 * The defect it closes: tmux is what every local pane launches through, and
 * the only screen that ever said so was the NATIVE Subshell Server assistant.
 * A headless install — the whole point of that spec — learned tmux was missing
 * when its first launch failed, or never.
 *
 * Detection-first, in the same shape as an agent row, because the question is
 * the same one: what is on this machine right now. Continue is never blocked
 * on it. The launch step refuses honestly on its own, and a wizard that traps
 * someone behind a package manager is worse than one that told them what is
 * missing.
 */
export function TmuxRow({
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
   */
  tmuxPath: string | null | undefined;
  /** The host's platform (`runtime.os`), which decides the command shown. */
  os: string | undefined;
  /** Runs the server-side installer. Wired only where the command needs no privilege. */
  onInstall?: () => void;
  installing?: boolean;
  /** The installer's most recent line, while it runs. */
  progress?: string;
  /** A run that failed, rendered under this row — the same shape the agent rows use. */
  failure?: { message: string; output?: string };
}) {
  if (tmuxPath === undefined) return null;
  const found = tmuxPath !== null;
  const hint = tmuxInstallHint(os ?? "");
  // The button exists only where the server can actually run the command. On
  // Linux the installer is `sudo apt-get`/`sudo dnf`, the server has no
  // terminal to answer a password prompt, and `POST /api/setup/tmux/install`
  // refuses it with a 409 — so offering one would ship a control that always
  // fails. There, the command is copyable and nothing more.
  const installable = !found && hint !== null && !hint.needsPrivilege && onInstall !== undefined;

  return (
    <li aria-label="tmux" className="border-border/60 border-b last:border-b-0">
      <div className="flex min-h-11 items-center gap-3 py-2">
        <SquareTerminal aria-hidden className="size-5 shrink-0 text-muted-foreground" />
        <span className="flex-1 font-strong">tmux</span>
        <span className={found ? "text-detail text-success" : "text-detail text-warning"}>
          {found ? "Detected" : "Not found"}
        </span>
        {installable && (
          <Button size="sm" disabled={installing} onClick={onInstall}>
            {/* A label that changes once and then holds still for a minute is
                how a working button comes to look like a wedged one. */}
            {installing && <LoaderCircle aria-hidden className="mr-1.5 size-3.5 animate-spin" />}
            {installing ? "Installing…" : "Install"}
          </Button>
        )}
      </div>
      {!found && !installing && !failure && (
        <div className="grid gap-2 pb-3 pl-9">
          {/* The cost, said once and plainly. Every local pane runs inside
              tmux, so this is not a missing convenience — it is the machine
              being unable to run anything. */}
          <p className="text-detail text-muted-foreground">
            Subshells cannot launch on this machine without it.{" "}
            {hint === null && <>Install tmux on this machine and this row will pick it up.</>}
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
        <div className="pb-3 pl-9">
          {/* The installer's own words, one line, verbatim. There is no
              percentage to derive from a package manager, and inventing stages
              it does not report would be worse than showing what it says. */}
          <p aria-live="polite" className="truncate font-mono text-detail text-muted-foreground">
            {progress ?? "Starting the installer…"}
          </p>
        </div>
      )}
      {failure && (
        <div className="pb-3 pl-9">
          <p className="text-destructive text-detail">{failure.message}</p>
          {failure.output !== undefined && failure.output.trim() !== "" && (
            <details className="mt-1 text-sm">
              <summary className="cursor-pointer text-detail text-muted-foreground">What the installer printed</summary>
              <pre className="mt-1 max-h-48 overflow-auto text-detail">{failure.output}</pre>
            </details>
          )}
        </div>
      )}
    </li>
  );
}
