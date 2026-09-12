import {
  COMPANY_URL,
  COPYRIGHT_HOLDER,
  COPYRIGHT_LINE,
  LICENSE_SUMMARY,
  LICENSE_URL,
  PRODUCT_URL,
} from "@internal/subshell-protocol";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { usePublicSettings } from "@/hooks/use-public-settings";
import { desktopShell } from "@/lib/desktop";

/** One external link in the footer row. */
function AboutLink({ href, children }: { href: string; children: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="underline hover:text-foreground">
      {children}
    </a>
  );
}

/**
 * What is this, and what am I allowed to do with it (spec 2026-09-12 § 4.5).
 *
 * Deliberately NOT admin-gated: a person asking what the thing in front of
 * them is should not need a role to be told. Nothing here is instance state —
 * the name and the version both ride the public-settings payload every page
 * already holds, so the dialog costs no request of its own.
 *
 * Two versions, because they move independently: the SERVER's, and — only
 * under the desktop marker — the shell's own. On Linux this replaces what the
 * console's About box used to say; macOS keeps its native About as well.
 */
export function AboutDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { data: settings } = usePublicSettings();
  const shell = desktopShell();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <div className="flex flex-col items-center gap-4 text-center">
          <img
            src="/icons/wordmark-80.png"
            srcSet="/icons/wordmark-80.png 1x, /icons/wordmark-120.png 2x"
            alt="Subshell"
            className="h-8 w-auto"
          />
          <DialogTitle className="text-base">{settings?.instanceName ?? ""}</DialogTitle>
          <div className="space-y-0.5 text-muted-foreground text-sm">
            <p>Server {settings?.serverVersion ?? "—"}</p>
            {shell && <p>Subshell Server {shell.version}</p>}
          </div>
          <p className="text-muted-foreground text-xs">{LICENSE_SUMMARY}</p>
          <p className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-muted-foreground text-xs">
            <AboutLink href={PRODUCT_URL}>Website</AboutLink>
            <AboutLink href={LICENSE_URL}>Licence</AboutLink>
            <AboutLink href={COMPANY_URL}>{COPYRIGHT_HOLDER}</AboutLink>
          </p>
          <p className="text-muted-foreground text-xs">{COPYRIGHT_LINE}</p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
