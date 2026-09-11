import { CopyCommandRow } from "@/components/copy-command-row";
import { Button } from "@/components/ui/button";
import type { HarnessInfo } from "@/types/harness";

/** `Button variant="link"` flattened to this block's dense muted text. */
const denseLink = "h-auto p-0 text-xs text-muted-foreground underline hover:text-foreground";

/**
 * The "how do I get this harness" block shown under a not-installed card:
 * the official command (copy-to-clipboard), a docs link, and a Re-check that
 * just refetches detection. Also renders the plain reason for a harness that
 * is installed but disabled, so every non-usable card says why.
 */
export function HarnessInstallHelp({
  harness,
  onRecheck,
  rechecking = false,
}: {
  /** The harness this block explains */
  harness: HarnessInfo;
  /** Re-run server-side detection (refetch) */
  onRecheck: () => void;
  /** True while the re-check is in flight */
  rechecking?: boolean;
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

  if (harness.reason === "override-invalid") {
    // Offering an install command here is actively wrong advice: the binary
    // may well be installed, and the operator has simply pointed the override
    // at the wrong place. Nothing they install will change that.
    return (
      <div className="space-y-2">
        <p className="text-muted-foreground text-xs">
          The <code className="font-mono">{harness.envOverride}</code> environment variable is set, but it doesn't point
          at an executable file. Fix it or unset it, then re-check.
        </p>
        <Button type="button" variant="link" size="sm" className={denseLink} onClick={onRecheck} disabled={rechecking}>
          {rechecking ? "Checking…" : "Re-check"}
        </Button>
      </div>
    );
  }

  // The command NAME, not the plugin id: what wasn't found on PATH is
  // `bash`, and telling someone "the terminal command wasn't found" sends
  // them hunting for a program called terminal.
  //
  // A plugin with no `install` block (the terminal plugin has nothing to
  // install) gets the reason and a Re-check only. An empty copy box and an
  // "Install docs" link to the current page are not fallbacks, they are
  // affordances that lead nowhere.
  const installable = harness.install.command !== "";
  return (
    <div className="space-y-2">
      <p className="text-muted-foreground text-xs">
        Not installed: the <code className="font-mono">{harness.binary}</code> command wasn't found.{" "}
        {installable
          ? "To install it:"
          : "Nothing needs installing for this plugin, so this machine's PATH is the problem."}
      </p>
      {installable && <CopyCommandRow text={harness.install.command} />}
      <div className="flex items-center gap-3 text-xs">
        <Button type="button" variant="link" size="sm" className={denseLink} onClick={onRecheck} disabled={rechecking}>
          {rechecking ? "Checking…" : "Re-check"}
        </Button>
        {installable && (
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
    </div>
  );
}
