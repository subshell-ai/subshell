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
        Installed but disabled — its profiles are hidden until you enable it.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-muted-foreground text-xs">
        Not installed — the <code className="font-mono">{harness.id}</code> command wasn't found. To install it:
      </p>
      <CopyCommandRow text={harness.install.command} />
      <div className="flex items-center gap-3 text-xs">
        <Button type="button" variant="link" size="sm" className={denseLink} onClick={onRecheck} disabled={rechecking}>
          {rechecking ? "Checking…" : "Re-check"}
        </Button>
        <Button
          variant="link"
          size="sm"
          className={denseLink}
          nativeButton={false}
          render={<a href={harness.install.docsUrl} target="_blank" rel="noreferrer" />}
        >
          Install docs ↗
        </Button>
      </div>
    </div>
  );
}
