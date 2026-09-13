import { useNavigate } from "@tanstack/react-router";
import { type JSX, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { type CreateSubshellInput, useCreateSubshell } from "@/hooks/use-create-subshell";
import { useInstancePlugins } from "@/hooks/use-instance-plugins";
import { useNodes } from "@/hooks/use-nodes";
import { usePresets } from "@/hooks/use-presets";
import { createSubshellErrorMessage } from "@/lib/create-subshell-error";
import { NAME_MAX_DEFAULT } from "@/lib/name-limits";
import { nodeOptionLabel } from "@/lib/node-label";
import type { SubshellView } from "@/types/subshell";

/** The source's node with the legacy fallback: an absent nodeId on an older
 * cached view means "local" (the server default). */
function cloneNodeId(source: SubshellView): string {
  return source.nodeId ?? "local";
}

/**
 * The launch input a clone copies from its source: same agent, same preset,
 * same directory, same node; only the (optional) name is the operator's. An
 * absent nodeId on an older cached view means "local" (the server default)
 * and the name is trimmed (blank stays blank — the server defaults it).
 * Pure so the mapping is testable without a dialog.
 */
export function cloneInputFromSource(source: SubshellView, name: string): CreateSubshellInput {
  return {
    harnessId: source.harnessId,
    presetId: source.presetId,
    workingDir: source.workingDir,
    name: name.trim(),
    nodeId: cloneNodeId(source),
  };
}

/**
 * Clone = launch a fresh copy of THIS subshell's launch (spec 2026-09-02 §2,
 * rows re-cut by spec 2026-09-13 §5): agent, preset, node and working
 * directory are copied read-only, the name is the only input, and the POST
 * runs under the CALLER's credentials — the clone is owned by whoever
 * launches it, and shares are never copied. Copy is entity-neutral so the
 * vocabulary rename does not rewrite the UI.
 */
export function CloneSubshellDialog({
  source,
  open,
  onOpenChange,
}: {
  /** The subshell being cloned */
  source: SubshellView;
  /** Controlled open state, owned by the actions menu (TitleDialog posture) */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const create = useCreateSubshell();
  const { data: presets } = usePresets();
  const { data: nodeData } = useNodes();
  const { data: pluginData } = useInstancePlugins();
  // Both lookups name what the POST already carries by id (`harnessId`,
  // `presetId`). An unresolvable HARNESS degrades to its id, which is a
  // readable slug ("claude-code"); a preset id is a uuid and gets prose
  // instead — see below.
  const agentName = (pluginData?.plugins ?? []).find((p) => p.id === source.harnessId)?.name ?? source.harnessId;
  // A preset id that resolves to no row is rendered as prose, never as the
  // uuid: this dialog's whole job is "here is what will be copied", and a
  // bare uuid answers that with a fact the reader cannot use. The case is
  // reachable — the preset was deleted, or its plugin was disabled, which
  // now removes it from the list (availability is the store, spec
  // 2026-09-13 amendment). An UNANSWERED list is not that case: absence
  // proves nothing while the query is still in flight.
  const presetName =
    source.presetId === null
      ? "None"
      : presets === undefined
        ? "…"
        : (presets.find((p) => p.id === source.presetId)?.name ?? "(preset no longer available)");
  const node = (nodeData?.nodes ?? []).find((n) => n.id === cloneNodeId(source));
  // `cloneNodeId` still feeds the create request, where `local` is the correct
  // IDENTIFIER — but it is never rendered: an id is not a label.
  const nodeLabel = node ? nodeOptionLabel(node) : "its original node";

  async function launch() {
    try {
      const created = await create.mutateAsync(cloneInputFromSource(source, name));
      onOpenChange(false);
      void navigate({ to: "/subshells/$id", params: { id: created.id } });
    } catch {
      // The mutation keeps the error; it renders under the name field.
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onClick={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>Clone</DialogTitle>
          <DialogDescription>
            Launches a fresh copy with the same agent, preset, node and working directory. Blank name defaults to
            date/time.
          </DialogDescription>
        </DialogHeader>
        <dl className="text-sm">
          <dt className="text-muted-foreground">Agent</dt>
          <dd className="mb-2 truncate">{agentName}</dd>
          <dt className="text-muted-foreground">Preset</dt>
          <dd className="mb-2 truncate">{presetName}</dd>
          <dt className="text-muted-foreground">Node</dt>
          <dd className="mb-2 truncate">{nodeLabel}</dd>
          <dt className="text-muted-foreground">Working directory</dt>
          <dd className="mb-3 truncate font-mono text-xs">{source.workingDir}</dd>
        </dl>
        <div className="space-y-2">
          <label className="font-medium text-sm" htmlFor="clone-name">
            Name (optional)
          </label>
          <Input
            id="clone-name"
            aria-label="Clone name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={NAME_MAX_DEFAULT}
            placeholder="Defaults to date/time"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter" && !create.isPending) void launch();
            }}
          />
          {create.error && (
            <p className="text-destructive text-sm">
              {createSubshellErrorMessage(create.error, "Failed to launch the clone")}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={create.isPending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={create.isPending} onClick={() => void launch()}>
            {create.isPending ? "Starting…" : "Launch clone"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
