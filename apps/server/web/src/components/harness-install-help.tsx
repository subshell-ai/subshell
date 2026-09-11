import { CopyCommandRow } from "@/components/copy-command-row";
import { Button } from "@/components/ui/button";
import type { HarnessInfo } from "@/types/harness";

/** `Button variant="link"` flattened to this block's dense muted text. */
const denseLink = "h-auto p-0 text-xs text-muted-foreground underline hover:text-foreground";

/**
 * The "how do I get this harness" block shown under a not-installed card:
 * the official command (copy-to-clipboard) and a docs link. Also renders the
 * plain reason for a harness that is installed but disabled, so every
 * non-usable card says why.
 */
export function HarnessInstallHelp({
  harness,
}: {
  /** The harness this block explains */
  harness: HarnessInfo;
}) {
  if (harness.installed) {
    return (
      <p className="text-muted-foreground text-xs">
        Installed but disabled. Its profiles are hidden until you enable it.
      </p>
    );
  }

  if (harness.reason === "no-binary") {
    // Not a failure. A plugin can legitimately drive no external CLI, and
    // offering an install command for one would be nonsense.
    return <p className="text-muted-foreground text-xs">This plugin needs no separate program installed.</p>;
  }

  if (harness.reason === "override-invalid" && harness.envOverride) {
    // Offering an install command here is actively wrong advice: the binary
    // may well be installed, and the operator has simply pointed the override
    // at the wrong place. Nothing they install will change that.
    //
    // Gated on the NAME existing: a message naming an empty variable is
    // worse than the generic branch, and the field CAN be absent — a
    // cached bundle talking to a server predating it. If we cannot name the
    // variable we do not write a sentence about it.
    return (
      <p className="text-muted-foreground text-xs">
        The <code className="font-mono">{harness.envOverride}</code> environment variable is set, but it doesn't point
        at an executable file. Fix it or unset it, then check again.
      </p>
    );
  }

  // The command NAME, not the plugin id: what wasn't found on PATH is
  // `bash`, and telling someone "the terminal command wasn't found" sends
  // them hunting for a program called terminal.
  //
  // A plugin with no `install` block (the terminal plugin has nothing to
  // install) gets the reason only. An empty copy box and an "Install docs"
  // link to the current page are not fallbacks, they are affordances that
  // lead nowhere.
  const installable = harness.install.command.trim() !== "";
  // The docs link gates on its OWN field, not on the command's: a plugin
  // can honestly ship one without the other, and `href=""` is a link that
  // silently reloads the page it sits on.
  const hasDocs = harness.install.docsUrl.trim() !== "";
  return (
    <div className="space-y-2">
      <p className="text-muted-foreground text-xs">
        Not installed: the <code className="font-mono">{harness.binary}</code> command wasn't found.{" "}
        {installable
          ? "To install it:"
          : "Nothing needs installing for this plugin, so this machine's PATH is the problem."}
      </p>
      {installable && <CopyCommandRow text={harness.install.command} />}
      {hasDocs && (
        <Button
          variant="link"
          size="sm"
          className={denseLink}
          nativeButton={false}
          render={<a href={harness.install.docsUrl} target="_blank" rel="noreferrer" />}
        >
          Install docs ↗
        </Button>
      )}
    </div>
  );
}
