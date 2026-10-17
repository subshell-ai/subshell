import { Button, errMessage } from "@internal/node-admin";
import { type ReactNode, useId, useState } from "react";
import { SearchableSelect } from "@/components/ui/combobox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ErrorNotice, WarningNotice } from "@/components/ui/notice";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { RosterUser, ShareDraft } from "@/hooks/use-subshell-shares";
import type { SubshellAccess } from "@/types/subshell";

/** The grantee levels a share can hold (owner is implicit, never assignable). */
type ShareLevel = Exclude<SubshellAccess, "owner">;

const LEVEL_OPTIONS: { value: ShareLevel; label: string }[] = [
  { value: "view", label: "View" },
  { value: "edit", label: "View + edit" },
];

function ShareLevelSelect({
  label,
  value,
  onChange,
}: {
  label: string;
  value: ShareLevel;
  onChange: (value: ShareLevel) => void;
}) {
  return (
    <Select items={LEVEL_OPTIONS} value={value} onValueChange={(level) => level && onChange(level)}>
      <SelectTrigger aria-label={label} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {LEVEL_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

/** The Everyone grant's sentinel in the picker (resolved to null on add). */
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

  const pickerId = useId();
  const grants = draft ?? serverGrants;
  // Grant order isn't meaningful: removing and re-adding the same access is unchanged.
  const savedPermissions = new Map(serverGrants.map((grant) => [grant.granteeUserId, grant.permission]));
  const hasChanges =
    grants.length !== serverGrants.length ||
    grants.some((grant) => savedPermissions.get(grant.granteeUserId) !== grant.permission);
  const saveDisabled = saving || isLoading || !hasChanges;
  const alreadyShared = new Set(grants.map((g) => g.granteeUserId ?? EVERYONE));

  const recipientOptions = [
    { value: EVERYONE, label: "Everyone" },
    ...roster.map((user) => ({ value: user.id, label: user.email, searchText: user.name })),
  ].filter((option) => !alreadyShared.has(option.value));
  const selectedRecipient = recipientOptions.some((option) => option.value === pickId) ? pickId : "";

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
    if (!selectedRecipient) return;
    const granteeUserId = selectedRecipient === EVERYONE ? null : selectedRecipient;
    // Replace any existing grant to the same target rather than duplicating.
    setDraft([...grants.filter((g) => g.granteeUserId !== granteeUserId), { granteeUserId, permission: pickLevel }]);
    setPickId("");
  }

  async function save() {
    if (!canManage || saveDisabled) return;
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
        {warning != null && <WarningNotice>{warning}</WarningNotice>}

        <div className="flex flex-col gap-3">
          {canManage && (
            <p className="text-detail text-muted-foreground">
              Save applies all additions, removals, and access changes. Cancel discards them.
            </p>
          )}
          {isLoading && <p className="text-muted-foreground text-sm">Loading…</p>}
          {!isLoading && grants.length === 0 && (
            <p className="text-muted-foreground text-sm">
              {hasChanges ? "No one will have shared access after you save." : "Not shared with anyone yet."}
            </p>
          )}
          {grants.map((g, i) => (
            <div
              key={g.granteeUserId ?? EVERYONE}
              className="grid grid-cols-[minmax(0,1fr)_5rem] items-center gap-3 sm:grid-cols-[minmax(0,1fr)_9rem_5rem]"
            >
              <span className="col-span-2 min-w-0 text-sm [overflow-wrap:anywhere] sm:col-span-1">
                {g.granteeUserId === null
                  ? "Everyone"
                  : (roster.find((u) => u.id === g.granteeUserId)?.email ?? g.granteeUserId)}
              </span>
              {canManage ? (
                <>
                  <ShareLevelSelect
                    label={`Access for ${g.granteeUserId === null ? "Everyone" : "this user"}`}
                    value={g.permission}
                    onChange={(level) => changeLevel(i, level)}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-9"
                    onClick={() => removeAt(i)}
                    aria-label={`Remove access for ${g.granteeUserId === null ? "Everyone" : (roster.find((u) => u.id === g.granteeUserId)?.email ?? "this user")}`}
                  >
                    Remove
                  </Button>
                </>
              ) : g.permission === "edit" ? (
                <span className="text-sm">View + edit</span>
              ) : (
                <span className="text-muted-foreground text-sm">View</span>
              )}
            </div>
          ))}

          {canManage && (
            <div className="grid grid-cols-[minmax(0,1fr)_5rem] items-center gap-3 border-t pt-3 sm:grid-cols-[minmax(0,1fr)_9rem_5rem]">
              <div className="col-span-2 min-w-0 sm:col-span-1">
                <label htmlFor={pickerId} className="sr-only">
                  Share with
                </label>
                <SearchableSelect
                  id={pickerId}
                  value={selectedRecipient}
                  onValueChange={setPickId}
                  placeholder="Search people…"
                  options={recipientOptions}
                  emptyText="No matching people to add."
                />
              </div>
              <ShareLevelSelect label="Access level to grant" value={pickLevel} onChange={setPickLevel} />
              <Button
                variant="outline"
                size="sm"
                className="h-9"
                onClick={addGrant}
                disabled={!selectedRecipient}
                disabledReason="Choose who to share with first."
              >
                Add
              </Button>
            </div>
          )}

          {error && <ErrorNotice>{error}</ErrorNotice>}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => handleClose(false)}>
            Cancel
          </Button>
          {canManage && (
            <Button
              onClick={() => void save()}
              disabled={saveDisabled}
              disabledReason={
                saving
                  ? "Wait for sharing changes to save."
                  : isLoading
                    ? "Wait for the current sharing settings to load."
                    : "No sharing changes to save."
              }
            >
              {saving ? "Saving…" : "Save"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
