import { Button } from "@internal/node-admin";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/** One plugin the card is about to replace, named for the question. */
export interface PluginUpdateTarget {
  /** Package name to show the person */
  name: string;
  /** The version installed now */
  from: string;
  /** The version the registry offers */
  to: string;
}

/**
 * The question in front of a plugin update. Its own component rather than the
 * shared boolean `confirmAction` because "Update all" names the whole batch:
 * the body lists every plugin that is about to change, and a batch is a
 * different decision from a single row's.
 *
 * The last sentence is the one fact a person cannot get from the version pair:
 * the bytes on disk change, but a plugin this process imported at boot keeps
 * running its old code until the server restarts (the page offers that
 * separately, once a row says it needs it).
 */
export function UpdatePluginsDialog({
  open,
  onOpenChange,
  targets,
  onConfirm,
}: {
  /** Whether the dialog is showing */
  open: boolean;
  /** Called with the dialog's next open state */
  onOpenChange: (open: boolean) => void;
  /** The plugins being replaced, one line each */
  targets: PluginUpdateTarget[];
  /** Called when the person confirms */
  onConfirm: () => void;
}) {
  const one = targets.length === 1;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{one ? "Update this plugin?" : `Update ${targets.length} plugins?`}</DialogTitle>
        </DialogHeader>
        <ul className="space-y-1">
          {targets.map((target) => (
            <li key={target.name} className="flex items-center justify-between gap-3 text-sm">
              <span className="min-w-0 truncate">{target.name}</span>
              <span className="font-mono text-detail text-muted-foreground">
                v{target.from} → v{target.to}
              </span>
            </li>
          ))}
        </ul>
        <DialogDescription>
          This replaces the plugin's code on this server. Updated plugins may need a server restart before their new
          code runs.
        </DialogDescription>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={onConfirm}>{one ? "Update" : "Update all"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
