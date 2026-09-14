import { LoaderCircle } from "lucide-react";
import { PluginIcon } from "@/components/plugin-icon";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { HarnessInfo } from "@/types/harness";

/**
 * One agent on the Add an Agent screen (spec 2026-09-11 § 6.2): name, a
 * detection chip, and when not found an Install button (where installing
 * from here exists) plus a collapsed How to install. No switch, no
 * description, no timestamp: first run asks what is here, not plugin
 * management, which lives in Settings → Plugins.
 */
export function AgentRow({
  harness,
  onInstall,
  installing = false,
  progress,
  failure,
}: {
  harness: HarnessInfo;
  onInstall?: (id: string) => void;
  installing?: boolean;
  /** The installer's most recent line, while it runs. */
  progress?: string;
  /**
   * This agent's own failed install, rendered under this row.
   *
   * It used to render under the whole LIST — a bare line plus a collapsed
   * "Installer output" — so a failure on the fourth of five agents appeared
   * at the bottom of the screen naming none of them. A failure belongs to the
   * thing that failed.
   */
  failure?: { message: string; output?: string };
}) {
  const chip = chipFor(harness);
  // The server 400s an id whose install.command is empty, so offering the
  // button for one would ship a control that always fails. Latent today (every built-in
  // agent harness carries a command, and `terminal` is filtered out by type)
  // but not derivable from `installed` alone once a command-less agent joins.
  const installable = harness.install.command.trim() !== "";
  return (
    <li aria-label={harness.name} className="border-border/60 border-b last:border-b-0">
      <div className="flex min-h-11 items-center gap-3 py-2">
        <PluginIcon pluginId={harness.id} name={harness.name} />
        <span className="flex-1 font-strong">{harness.name}</span>
        <span className={cn("text-xs", chip.className)}>{chip.text}</span>
        {!harness.installed && installable && onInstall && (
          <Button size="sm" disabled={installing} onClick={() => onInstall(harness.id)}>
            {/* These installers are `curl … | bash` against someone else's
                host, which can sit for a while on a slow network. A label
                that changes once and then holds still for a minute is how a
                working button comes to look like a wedged one. */}
            {installing && <LoaderCircle aria-hidden className="mr-1.5 size-3.5 animate-spin" />}
            {installing ? "Installing…" : "Install"}
          </Button>
        )}
      </div>
      {/* What Install will actually do, without a click. The button sat next
          to a disclosure containing a command to copy, which read as two
          alternatives rather than as a button and its explanation — and this
          runs a vendor's script on this machine as the server's own user, so
          it should not take a click to find out which one. Not a confirm
          step: the tmux install one screen earlier runs on a single press
          too, and one product should not ask twice for the same kind of act. */}
      {!harness.installed && !installing && !failure && (
        <p className="pb-2 pl-9 text-muted-foreground text-xs">
          {installable && onInstall ? (
            <>
              Runs <code className="font-mono">{harness.install.command}</code> on this machine.
            </>
          ) : (
            // No button, so this line is the only guidance there is. Latent
            // today — every built-in agent ships a command — but the row must
            // not go silent if one ever does not.
            <>No install command for {harness.name}; install it yourself and re-check.</>
          )}{" "}
          {harness.install.docsUrl.trim() !== "" && (
            // The one thing the old "How to install" disclosure carried that
            // this line does not already say. It gates on its OWN field: a
            // plugin can ship a command without docs, and `href=""` is a link
            // that silently reloads the page it sits on.
            <a href={harness.install.docsUrl} target="_blank" rel="noreferrer" className="underline">
              Install docs ↗
            </a>
          )}
        </p>
      )}
      {installing && (
        <div className="pb-3 pl-9">
          {/* The installer's own words, one line, verbatim. There is no
              percentage to derive from `curl … | bash`, and inventing stages
              it does not report would be worse than showing what it says. */}
          <p aria-live="polite" className="truncate font-mono text-muted-foreground text-xs">
            {progress ?? "Starting the installer…"}
          </p>
        </div>
      )}
      {failure && (
        <div className="pb-3 pl-9">
          <p className="text-destructive text-sm">{failure.message}</p>
          {failure.output !== undefined && failure.output.trim() !== "" && (
            <details className="mt-1 text-sm">
              <summary className="cursor-pointer text-muted-foreground text-xs">What the installer printed</summary>
              <pre className="mt-1 max-h-48 overflow-auto text-xs">{failure.output}</pre>
            </details>
          )}
        </div>
      )}
    </li>
  );
}

/** The detection chip's text and colour for one harness. */
function chipFor(h: HarnessInfo): { text: string; className: string } {
  if (h.installed) return { text: h.version ? `Detected · v${h.version}` : "Detected", className: "text-success" };
  if (h.reason === "override-invalid" && h.envOverride) {
    return { text: `Check ${h.envOverride}`, className: "text-warning" };
  }
  return { text: "Not found", className: "text-muted-foreground" };
}
