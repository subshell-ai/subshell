import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  type InstancePluginRow,
  type UninstallMode,
  usePluginImpact,
  useUninstallInstancePlugin,
} from "@/hooks/use-instance-plugins";
import { errMessage } from "@/lib/api";

/**
 * The uninstall prompt (spec 2026-09-10 §6.1). Its own component over the
 * Dialog primitives because the shared `confirmAction` resolves a BOOLEAN and
 * cannot express keep-vs-delete. The mount IS the open: the page renders this
 * only while a row is targeted, so the keep default is the initial state of a
 * fresh mount rather than a reset to remember.
 */
export function UninstallPluginDialog({ plugin, onClose }: { plugin: InstancePluginRow; onClose: () => void }) {
  const [mode, setMode] = useState<UninstallMode>("keep");
  const { data: impact, error, refetch } = usePluginImpact(plugin.id);
  const uninstall = useUninstallInstancePlugin();

  async function confirmUninstall() {
    if (!impact) return;
    try {
      await uninstall.mutateAsync({ id: plugin.id, mode });
      onClose();
    } catch {
      // Stay open: the row is unchanged, the error belongs beside the button
      // that can press it again.
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Uninstall {plugin.name}?</DialogTitle>
          <DialogDescription>
            This removes the plugin from this instance and stops offering it on every node.
          </DialogDescription>
        </DialogHeader>

        {impact === undefined && error === null && (
          <p className="text-muted-foreground text-sm">Checking which profiles use it…</p>
        )}
        {error !== null && (
          <div className="flex items-center justify-between gap-3">
            <p className="text-destructive text-sm">Could not count what uses it. {errMessage(error, "")}</p>
            <Button variant="link" size="sm" className="h-auto p-0 text-xs underline" onClick={() => void refetch()}>
              Retry
            </Button>
          </div>
        )}
        {impact && (
          <>
            {/* One text node, one sentence: the counts are the dialog's whole
                argument, and a query for them must find them as written. */}
            <p className="text-sm">{blastRadius(impact)}</p>
            <fieldset className="space-y-2">
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="uninstall-mode"
                  checked={mode === "keep"}
                  onChange={() => setMode("keep")}
                  className="mt-0.5"
                />
                <span>Keep the profiles, unavailable until reinstalled</span>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="uninstall-mode"
                  checked={mode === "delete"}
                  onChange={() => setMode("delete")}
                  className="mt-0.5"
                />
                <span>
                  {impact.profiles > 0 ? `Delete the ${impact.profiles} profiles` : "Delete the profiles"} permanently
                </span>
              </label>
            </fieldset>
            {/* Both halves of the surprise, stated where the decision is made:
                uninstalling has never stopped a running subshell, and deleting
                a profile breaks the restart that needs it. */}
            <p className="text-muted-foreground text-xs">
              Running subshells are unaffected. A restart of one whose profile was deleted will fail.
            </p>
          </>
        )}

        {uninstall.isError && (
          <p className="text-destructive text-sm">{errMessage(uninstall.error, "Uninstall failed.")}</p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => void confirmUninstall()}
            disabled={!impact || uninstall.isPending}
          >
            {uninstall.isPending ? "Uninstalling…" : "Uninstall"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** `N` with its noun, pluralized by `N` itself. */
function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/**
 * The §6.1 blast-radius sentence, one string: "4 profiles use it, across 3
 * users: 2 Defaults, 1 running subshell." The zero case says so plainly,
 * which collapses the radios' stakes without hiding the default.
 */
export function blastRadius(impact: {
  profiles: number;
  distinctUsers: number;
  defaults: number;
  runningSubshells: number;
}): string {
  if (impact.profiles === 0) return "No profiles use it.";
  const verb = impact.profiles === 1 ? "uses" : "use";
  const profileWord = impact.profiles === 1 ? "profile" : "profiles";
  const head = `${impact.profiles} ${profileWord} ${verb} it, across ${count(impact.distinctUsers, "user")}`;
  const tail = [
    impact.defaults > 0 ? count(impact.defaults, "Default", "Defaults") : "",
    impact.runningSubshells > 0 ? count(impact.runningSubshells, "running subshell") : "",
  ].filter((s) => s !== "");
  return `${head}${tail.length > 0 ? `: ${tail.join(", ")}` : ""}.`;
}
