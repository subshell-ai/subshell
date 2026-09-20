import { Button, cn } from "@internal/node-admin";
import type { JSX } from "react";
import { desktopInvoke, desktopPlatform, isServerDesktop } from "@/lib/desktop";

/** Which permission a notice is about — and so which pane fixes it. */
export type PermissionPane = "notifications" | "files" | "photos";

/**
 * Where a person goes to change it by hand. Only ever rendered where no shell
 * is present, so these are directions rather than a link.
 */
const PANE_PATH: Record<PermissionPane, string> = {
  notifications: "System Settings → Notifications → Subshell Server",
  files: "System Settings → Privacy & Security → Files and Folders",
  photos: "System Settings → Privacy & Security → Photos",
};

/** Props for {@link PermissionNotice}. */
export interface PermissionNoticeProps {
  /** Which permission this is about. */
  pane: PermissionPane;
  /** One sentence: what is blocked, and what that costs. */
  message: string;
  /** Extra classes for the wrapper — placement belongs to the caller. */
  className?: string;
}

/**
 * The one shape every "macOS is blocking this" notice takes (spec 2026-09-14
 * §5): a sentence naming which permission is missing and what it blocks, then
 * the way to fix it.
 *
 * **The dashboard never opens System Settings itself.** Fix… raises the
 * bundled assistant at its `permissions` screen, where the denied row carries
 * the button that does — the command this page holds is
 * `desktop_open_assistant`, and popping a system pane from a page the server
 * serves is a nuisance an XSS could pull. In a plain browser there is no app
 * to raise, so the same instruction is given in words instead of as a control
 * that cannot work.
 */
export function PermissionNotice({ pane, message, className }: PermissionNoticeProps): JSX.Element {
  const inShell = isServerDesktop();
  return (
    // Spans, not a div and a p: this renders inside a banner's inline slot as
    // well as in a card's block flow, and a div inside a span is invalid
    // nesting in the one place it would be hardest to notice.
    <span className={cn("flex flex-wrap items-center gap-x-2 gap-y-1", className)}>
      {/* `detail`: every explanation a control gives about itself is one size
          (docs/design-system.md), and that is what this is. */}
      <span className="text-detail text-muted-foreground">
        {message}
        {/* The System Settings path is macOS's. Notifications and Photos are
            only ever asked about inside the Mac shell, but a FILES refusal can
            be plain unix modes on a Linux server, and pointing at System
            Settings there would be wrong twice (review, 2026-09-14). */}
        {!inShell && (pane !== "files" || desktopPlatform() === "macos") && ` Allow it in ${PANE_PATH[pane]}.`}
      </span>
      {inShell && (
        <Button
          variant="outline"
          size="sm"
          className="text-detail"
          // The forgiving invoke: a shell older than this screen knows no
          // `permissions` screen, and a button that throws is worse than one
          // that does nothing (the sentence above still stands on its own).
          onClick={() => void desktopInvoke("desktop_open_assistant", { screen: "permissions" })}
        >
          Fix…
        </Button>
      )}
    </span>
  );
}
