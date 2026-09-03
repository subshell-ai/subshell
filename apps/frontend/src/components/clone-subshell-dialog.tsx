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
import { type CreateSessionInput, useCreateSession } from "@/hooks/use-create-session";
import { useNodes } from "@/hooks/use-nodes";
import { useProfiles } from "@/hooks/use-profiles";
import { createSessionErrorMessage } from "@/lib/create-session-error";
import { NAME_MAX_DEFAULT } from "@/lib/name-limits";
import { nodeOptionLabel } from "@/lib/node-label";
import type { SessionView } from "@/types/session";

/**
 * The launch input a clone copies from its source: same profile, same
 * directory, same node; only the (optional) name is the operator's. An
 * absent nodeId on an older cached view means "local" (the server default)
 * and the name is trimmed (blank stays blank — the server defaults it).
 * Pure so the mapping is testable without a dialog.
 */
export function cloneInputFromSource(source: SessionView, name: string): CreateSessionInput {
  return {
    profileId: source.profileId,
    workingDir: source.workingDir,
    name: name.trim(),
    nodeId: source.nodeId ?? "local",
  };
}

/**
 * Clone = launch a fresh copy of THIS subshell's launch (spec 2026-09-02 §2):
 * node, profile and working directory are copied read-only, the name is the
 * only input, and the POST runs under the CALLER's credentials — the clone
 * is owned by whoever launches it, and shares are never copied. Copy is
 * entity-neutral so the vocabulary rename (spec §1) does not rewrite the UI.
 */
export function CloneSubshellDialog({
  source,
  open,
  onOpenChange,
}: {
  /** The subshell being cloned */
  source: SessionView;
  /** Controlled open state, owned by the actions menu (TitleDialog posture) */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const create = useCreateSession();
  // "any": the source's profile may live on another node than the default list filters.
  const { data: profiles } = useProfiles({ node: "any" });
  const { data: nodeData } = useNodes();
  const profile = (profiles ?? []).find((p) => p.id === source.profileId);
  const node = (nodeData?.nodes ?? []).find((n) => n.id === (source.nodeId ?? "local"));
  // Same display grammar as the launch pickers, so the rows read identical.
  const profileLabel = profile ? `${profile.name} (${profile.harnessId})` : source.harnessId;
  const nodeLabel = node ? nodeOptionLabel(node, "Local") : (source.nodeId ?? "local");

  async function launch() {
    try {
      const created = await create.mutateAsync(cloneInputFromSource(source, name));
      onOpenChange(false);
      void navigate({ to: "/sessions/$id", params: { id: created.id } });
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
            Launches a fresh copy with the same node, profile and working directory. Blank name defaults to date/time.
          </DialogDescription>
        </DialogHeader>
        <dl className="text-sm">
          <dt className="text-muted-foreground">Node</dt>
          <dd className="mb-2 truncate">{nodeLabel}</dd>
          <dt className="text-muted-foreground">Profile</dt>
          <dd className="mb-2 truncate">{profileLabel}</dd>
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
              {createSessionErrorMessage(create.error, "Failed to launch the clone")}
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
