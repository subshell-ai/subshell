import { type ReactNode, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Segmented } from "@/components/ui/segmented";
import type { RosterUser, ShareDraft } from "@/hooks/use-subshell-shares";
import { errMessage } from "@/lib/api";
import type { SubshellAccess } from "@/types/subshell";

/** The grantee levels a share can hold (owner is implicit, never assignable). */
type ShareLevel = Exclude<SubshellAccess, "owner">;

const LEVEL_OPTIONS: { value: ShareLevel; label: string }[] = [
  { value: "view", label: "View" },
  { value: "edit", label: "View + edit" },
];

/** The Everyone grant's sentinel in the native picker (resolved to null on add). */
const EVERYONE = "everyone";

/**
 * The grant-editing dialog behind both `SharingDialog` (subshells) and
 * `NodeSharingDialog` (nodes) — the wire contracts are identical (GET returns
 * the grant set, PUT replaces it whole, null grantee = Everyone, same
 * view|edit vocabulary), so only the endpoint and the copy differ. The
 * wrappers own the hooks and pass everything here as plain data + one
 * `onSave`, which keeps this file fetch-free and the wrappers thin.
 *
 * Controlled with no trigger of its own. Local draft state is seeded from the
 * server data on every render until the first edit (so a freshly-opened dialog
 * renders rows without a seeding effect) and reset on close, so a cancelled
 * edit never leaks forward. `canManage` (server-derived, never re-derived
 * here) renders the same rows read-only for viewers who cannot move grants.
 */
export function SharingDialogCore({
  open,
  onOpenChange,
  title,
  description,
  isLoading,
  serverGrants,
  roster,
  saving,
  onSave,
  canManage = true,
  warning,
}: {
  /** Whether the dialog is shown */
  open: boolean;
  /** Open/close from inside (Cancel/Save/overlay) */
  onOpenChange: (open: boolean) => void;
  /** Dialog heading, e.g. "Share subshell" */
  title: string;
  /** Dialog sub-copy explaining what the grants confer */
  description: string;
  /** True while the current grant set is still loading */
  isLoading: boolean;
  /** The server's current grants — the seed until a local edit starts */
  serverGrants: ShareDraft[];
  /** Instance roster for the add-row picker (emails as labels) */
  roster: RosterUser[];
  /** True while the PUT is in flight */
  saving: boolean;
  /**
   * Amber note under the description, for what a grant DISCLOSES rather than
   * what it permits. Optional because the two callers disclose different
   * things: a subshell share hands over a live terminal's contents, a node
   * share hands over a machine.
   */
  warning?: ReactNode;
  /** PUTs the complete replacement set; rejects with the failure to surface */
  onSave: (grants: ShareDraft[]) => Promise<unknown>;
  /** False renders everything read-only (no add/remove/level/Save) */
  canManage?: boolean;
}) {
  // Local edits (null = "unsaved, still what the server has"). Derived grants
  // fall back to the server set so a freshly-opened dialog renders rows without
  // waiting on a seeding effect.
  const [draft, setDraft] = useState<ShareDraft[] | null>(null);
  const [pickId, setPickId] = useState<string>(EVERYONE);
  const [pickLevel, setPickLevel] = useState<ShareLevel>("view");
  const [error, setError] = useState<string | null>(null);

  const grants = draft ?? serverGrants;
  const alreadyShared = new Set(grants.map((g) => g.granteeUserId ?? EVERYONE));

  function handleClose(next: boolean) {
    if (!next) {
      setDraft(null);
      setError(null);
    }
    onOpenChange(next);
  }

  function changeLevel(index: number, level: ShareLevel) {
    setDraft(grants.map((g, i) => (i === index ? { ...g, permission: level } : g)));
  }

  function removeAt(index: number) {
    setDraft(grants.filter((_, i) => i !== index));
  }

  function addGrant() {
    const granteeUserId = pickId === EVERYONE ? null : pickId;
    // Replace any existing grant to the same target rather than duplicating.
    setDraft([...grants.filter((g) => g.granteeUserId !== granteeUserId), { granteeUserId, permission: pickLevel }]);
  }

  async function save() {
    setError(null);
    try {
      await onSave(grants);
      handleClose(false);
    } catch (err) {
      setError(errMessage(err, "The sharing settings could not be saved."));
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent onClick={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {/* Before the grant rows, not after: the disclosure has to be read
            while deciding, not discovered under the Save button. */}
        {warning != null && (
          <p className="rounded-md border border-amber-500/70 px-3 py-2 text-amber-600 text-xs dark:text-amber-400">
            {warning}
          </p>
        )}

        <div className="space-y-3">
          {isLoading && <p className="text-muted-foreground text-sm">Loading…</p>}
          {!isLoading && grants.length === 0 && (
            <p className="text-muted-foreground text-sm">Not shared with anyone yet.</p>
          )}
          {grants.map((g, i) => (
            <div key={g.granteeUserId ?? EVERYONE} className="flex items-center justify-between gap-3">
              <span className="min-w-0 flex-1 truncate text-sm">
                {g.granteeUserId === null
                  ? "Everyone"
                  : (roster.find((u) => u.id === g.granteeUserId)?.email ?? g.granteeUserId)}
              </span>
              {canManage ? (
                <>
                  <Segmented
                    ariaLabel={`Access for ${g.granteeUserId === null ? "Everyone" : "this user"}`}
                    options={LEVEL_OPTIONS}
                    value={g.permission}
                    onChange={(level) => changeLevel(i, level)}
                  />
                  <Button variant="ghost" size="sm" onClick={() => removeAt(i)} aria-label="Remove">
                    Remove
                  </Button>
                </>
              ) : g.permission === "edit" ? (
                // Dreamframe N2: edit is a lit plum chip, view stays bare muted
                // text — the permission levels contrast by presence, not hue.
                <Badge className="border-[var(--edit-badge-border)] bg-[var(--edit-badge-bg)] text-[var(--edit-badge-foreground)]">
                  View + edit
                </Badge>
              ) : (
                <span className="text-muted-foreground text-sm">View</span>
              )}
            </div>
          ))}

          {canManage && (
            <div className="flex flex-wrap items-center gap-3 border-t pt-3">
              <select
                value={pickId}
                onChange={(e) => setPickId(e.target.value)}
                aria-label="Share with"
                className="h-8 rounded-md border bg-transparent px-2 text-sm"
              >
                {!alreadyShared.has(EVERYONE) && <option value={EVERYONE}>Everyone</option>}
                {roster
                  .filter((u) => !alreadyShared.has(u.id))
                  .map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.email}
                    </option>
                  ))}
              </select>
              <Segmented
                ariaLabel="Access level to grant"
                options={LEVEL_OPTIONS}
                value={pickLevel}
                onChange={setPickLevel}
              />
              <Button variant="outline" size="sm" onClick={addGrant}>
                Add
              </Button>
            </div>
          )}

          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => handleClose(false)}>
            Cancel
          </Button>
          {canManage && (
            <Button onClick={() => void save()} disabled={saving || (isLoading && draft === null)}>
              {saving ? "Saving…" : "Save"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
