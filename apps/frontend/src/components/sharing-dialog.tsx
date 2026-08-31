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
import { Segmented } from "@/components/ui/segmented";
import { type ShareDraft, useSetShares, useSharableUsers, useShares } from "@/hooks/use-session-shares";
import { errMessage } from "@/lib/api";
import type { SessionAccess } from "@/types/session";

/** The grantee levels a share can hold (owner is implicit, never assignable). */
type ShareLevel = Exclude<SessionAccess, "owner">;

const LEVEL_OPTIONS: { value: ShareLevel; label: string }[] = [
  { value: "view", label: "View" },
  { value: "edit", label: "View + edit" },
];

/** The Everyone grant's sentinel in the native picker (resolved to null on add). */
const EVERYONE = "everyone";

/**
 * Owner-only sharing control (spec 2026-08-31 §4). Lists the session's current
 * grants, lets the owner add "Everyone" or a named user at View or View + edit,
 * change a level, or remove a grant, then PUTs the whole set on Save.
 *
 * Controlled with no trigger of its own — opened from the actions menu. Local
 * draft state is seeded from the server when it first loads (or the dialog
 * reopens) and reset on close, so a cancelled edit never leaks forward.
 */
export function SharingDialog({
  sessionId,
  open,
  onOpenChange,
}: {
  sessionId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const shares = useShares(sessionId, open);
  const roster = useSharableUsers(open);
  const setShares = useSetShares(sessionId);

  // Local edits (null = "unsaved, still what the server has"). Derived grants
  // fall back to the server set so a freshly-opened dialog renders rows without
  // waiting on a seeding effect.
  const [draft, setDraft] = useState<ShareDraft[] | null>(null);
  const [pickId, setPickId] = useState<string>(EVERYONE);
  const [pickLevel, setPickLevel] = useState<ShareLevel>("view");
  const [error, setError] = useState<string | null>(null);

  const serverGrants: ShareDraft[] = (shares.data?.shares ?? []).map((s) => ({
    granteeUserId: s.granteeUserId,
    permission: s.permission,
  }));
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

  function save() {
    setError(null);
    setShares.mutate(grants, {
      onSuccess: () => handleClose(false),
      onError: (err) => setError(errMessage(err, "The sharing settings could not be saved.")),
    });
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent onClick={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>Share session</DialogTitle>
          <DialogDescription>Let others see or use this session. Sharing is private by default.</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {shares.isLoading && <p className="text-muted-foreground text-sm">Loading…</p>}
          {!shares.isLoading && grants.length === 0 && (
            <p className="text-muted-foreground text-sm">Not shared with anyone yet.</p>
          )}
          {grants.map((g, i) => (
            <div key={g.granteeUserId ?? EVERYONE} className="flex items-center justify-between gap-3">
              <span className="min-w-0 flex-1 truncate text-sm">
                {g.granteeUserId === null
                  ? "Everyone"
                  : (roster.data?.find((u) => u.id === g.granteeUserId)?.email ?? g.granteeUserId)}
              </span>
              <Segmented
                ariaLabel={`Access for ${g.granteeUserId === null ? "Everyone" : "this user"}`}
                options={LEVEL_OPTIONS}
                value={g.permission}
                onChange={(level) => changeLevel(i, level)}
              />
              <Button variant="ghost" size="sm" onClick={() => removeAt(i)} aria-label="Remove">
                Remove
              </Button>
            </div>
          ))}

          <div className="flex flex-wrap items-center gap-3 border-t pt-3">
            <select
              value={pickId}
              onChange={(e) => setPickId(e.target.value)}
              aria-label="Share with"
              className="h-8 rounded-md border bg-transparent px-2 text-sm"
            >
              {!alreadyShared.has(EVERYONE) && <option value={EVERYONE}>Everyone</option>}
              {(roster.data ?? [])
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
          <Button onClick={save} disabled={setShares.isPending || (shares.isLoading && draft === null)}>
            {setShares.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
