import { type LucideIcon, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export interface EmptyStateProps {
  /** Icon beside the title, drawn at the shared `h-5 w-5` */
  icon: LucideIcon;
  /** Headline — "No X yet" wording is e2e-pinned on some pages; pass it verbatim */
  title: string;
  /** One or two sentences explaining what fills this space */
  description: string;
  /**
   * CTA label, e.g. "Create your first preset".
   *
   * Optional together with {@link onAction}: an empty state a viewer cannot
   * act on is a real shape, not a missing prop. `/nodes` reaches it when an
   * admin has turned off adding nodes — the alternative was offering a button
   * whose route answers 403, which is worse than an explanation and no
   * button.
   */
  actionLabel?: string;
  /** Opens the creation flow; omit with `actionLabel` for a stateless card */
  onAction?: () => void;
  /** Disables the CTA while the action is in flight */
  busy?: boolean;
  /** Label while `busy` (e.g. "Creating…"); falls back to `actionLabel` */
  busyLabel?: string;
}

/**
 * The "No X yet" card every list page shows before its first row: a dashed
 * card (a slot, not content that failed to render), an icon'd title, a
 * sentence of orientation, and one CTA.
 *
 * Four pages spelled this identically but for the nouns and the icon; the
 * copy lives in props so each site keeps its exact wording (e2e asserts
 * some of it) while the shape stays shared.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  actionLabel,
  onAction,
  busy,
  busyLabel,
}: EmptyStateProps) {
  return (
    <Card variant="dashed">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon className="h-5 w-5" /> {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      {/* Both or neither: `onAction` without a label is a nameless button,
          and a label without a handler is a button that does nothing. */}
      {actionLabel && onAction && (
        <CardContent>
          <Button onClick={onAction} disabled={busy}>
            <Plus /> {busy && busyLabel ? busyLabel : actionLabel}
          </Button>
        </CardContent>
      )}
    </Card>
  );
}
