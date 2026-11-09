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
import type { RosterUser } from "@/hooks/use-subshell-shares";

/** One assignable rung of the sharing ladder, lowest first. */
export interface ShareLevelDef<P extends string> {
  /** The wire value stored on the grant */
  value: P;
  /** The picker's label */
  label: string;
}

/** A grant in the dialog's shape: who, and which rung. */
export interface ShareGrant<P extends string> {
  granteeUserId: string | null;
  permission: P;
}

/** The ladder, ordered bottom rung first so the picker and the styling agree. */
export type ShareLevels<P extends string> = readonly [ShareLevelDef<P>, ...ShareLevelDef<P>[]];

/** The view/edit ladder the subshell and preset dialogs share. */
export const BASIC_SHARE_LEVELS: ShareLevels<"view" | "edit"> = [
  { value: "view", label: "View" },
  { value: "edit", label: "View + edit" },
];

function ShareLevelSelect<P extends string>({
  label,
  levels,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  levels: ShareLevels<P>;
  disabled?: boolean;
  value: P;
  onChange: (value: P) => void;
}) {
  return (
    <Select
      disabled={disabled}
      items={levels.map((level) => ({ value: level.value as string, label: level.label }))}
      value={value}
      onValueChange={(next) => next && onChange(next as P)}
    >
      <SelectTrigger aria-label={label} className="w-full" disabledReason="Wait for sharing changes to save.">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {levels.map((level) => (
            <SelectItem key={level.value} value={level.value}>
              {level.label}
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
 * The grant-editing dialog behind `SharingDialog` (subshells),
 * `PresetSharingDialog` (presets) and `NodeSharingDialog` (nodes) — the wire
 * contracts are identical (GET returns the grant set, PUT replaces it whole,
 * null grantee = Everyone), so only the endpoint, the copy, and the ladder of
 * assignable levels differ. Node sharing gained `manage` (spec 2026-11-07)
 * without giving the other two a rung they do not have: `levels` is a
 * required prop, ordered lowest first, and the read-only rows and the picker
 * both render from it. The wrappers own the hooks and pass everything here as
 * plain data + one `onSave`, which keeps this file fetch-free and the wrappers
 * thin.
 *
 * Controlled with no trigger of its own. Local draft state is seeded from the
 * server data on every render until the first edit (so a freshly-opened dialog
 * renders rows without a seeding effect) and reset on close, so a cancelled
 * edit never leaks forward. `canManage` (server-derived, never re-derived
 * here) renders the same rows read-only for viewers who cannot move grants.
 */
export function SharingDialogCore<P extends string>({
  open,
  onOpenChange,
  title,
  description,
  levels,
  isLoading,
  serverGrants,
  roster,
  saving,
  onSave,
  canManage = true,
  warning,
  loadError,
}: {
  /** Whether the dialog is shown */
  open: boolean;
  /** Open/close from inside (Cancel/Save/overlay) */
  onOpenChange: (open: boolean) => void;
  /** Dialog heading, e.g. "Share subshell" */
  title: string;
  /** Dialog sub-copy explaining what the grants confer */
  description: string;
  /** The assignable rungs, lowest first; drives picker labels and read-only styling */
  levels: ShareLevels<P>;
  /** True while the current grant set is still loading */
  isLoading: boolean;
  /** The server's current grants — the seed until a local edit starts */
  serverGrants: ShareGrant<P>[];
  /** Instance roster for the add-row picker (emails as labels) */
  roster: RosterUser[];
  /** True while the PUT is in flight */
  saving: boolean;
  /**
   * Amber note under the description, for what a grant DISCLOSES rather than
   * what it permits. Optional because the callers disclose different
   * things: a subshell share hands over a live terminal's contents, a node
   * share hands over a machine.
   */
  warning?: ReactNode;
  /** Failed initial reads must not be mistaken for an empty grant set. */
  loadError?: ReactNode;
  /** PUTs the complete replacement set; rejects with the failure to surface */
  onSave: (grants: ShareGrant<P>[]) => Promise<unknown>;
  /** False renders everything read-only (no add/remove/level/Save) */
  canManage?: boolean;
}) {
  // Local edits (null = "unsaved, still what the server has"). Derived grants
  // fall back to the server set so a freshly-opened dialog renders rows without
  // waiting on a seeding effect.
  const [draft, setDraft] = useState<ShareGrant<P>[] | null>(null);
  const [pickId, setPickId] = useState<string>(EVERYONE);
  const [pickLevel, setPickLevel] = useState<P>(levels[0].value);
  const [error, setError] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const busy = saving || submitting;
  const pickerId = useId();
  const grants = draft ?? serverGrants;
  // Grant order isn't meaningful: removing and re-adding the same access is unchanged.
  const savedPermissions = new Map(serverGrants.map((grant) => [grant.granteeUserId, grant.permission]));
  const hasChanges =
    grants.length !== serverGrants.length ||
    grants.some((grant) => savedPermissions.get(grant.granteeUserId) !== grant.permission);
  const saveDisabled = busy || isLoading || !!loadError || !hasChanges;
  const alreadyShared = new Set(grants.map((g) => g.granteeUserId ?? EVERYONE));

  const recipientOptions = [
    { value: EVERYONE, label: "Everyone" },
    ...roster.map((user) => ({ value: user.id, label: user.email, searchText: user.name })),
  ].filter((option) => !alreadyShared.has(option.value));
  const selectedRecipient = recipientOptions.some((option) => option.value === pickId) ? pickId : "";

  function handleClose(next: boolean) {
    if (!next && busy) return;
    if (!next) {
      setDraft(null);
      setError(null);
    }
    onOpenChange(next);
  }

  function changeLevel(index: number, level: P) {
    if (isLoading || loadError || busy) return;
    setDraft(grants.map((g, i) => (i === index ? { ...g, permission: level } : g)));
  }

  function removeAt(index: number) {
    if (isLoading || loadError || busy) return;
    setDraft(grants.filter((_, i) => i !== index));
  }

  function addGrant() {
    if (!selectedRecipient || isLoading || loadError || busy) return;
    const granteeUserId = selectedRecipient === EVERYONE ? null : selectedRecipient;
    // Replace any existing grant to the same target rather than duplicating.
    setDraft([...grants.filter((g) => g.granteeUserId !== granteeUserId), { granteeUserId, permission: pickLevel }]);
    setPickId("");
  }

  async function save() {
    if (!canManage || saveDisabled) return;
    setError(null);
    setSubmitting(true);
    try {
      await onSave(grants);
      setDraft(null);
      onOpenChange(false);
    } catch (err) {
      setError(errMessage(err, "The sharing settings could not be saved."));
    } finally {
      setSubmitting(false);
    }
  }

  // Read-only rows name the rung from `levels` (never a hardcoded branch, so a
  // third rung can't arrive unlabelled); only the bottom rung sits muted.
  const levelLabel = (permission: P) => levels.find((level) => level.value === permission);

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
        {loadError}

        <div className="flex flex-col gap-3">
          {canManage && (
            <p className="text-detail text-muted-foreground">
              Save applies all additions, removals, and access changes. Cancel discards them.
            </p>
          )}
          {isLoading && <p className="text-muted-foreground text-sm">Loading…</p>}
          {!isLoading && !loadError && grants.length === 0 && (
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
              {canManage && !isLoading && !loadError ? (
                <>
                  <ShareLevelSelect<P>
                    label={`Access for ${g.granteeUserId === null ? "Everyone" : "this user"}`}
                    levels={levels}
                    disabled={busy}
                    value={g.permission}
                    onChange={(level) => changeLevel(i, level)}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-9"
                    disabled={busy}
                    disabledReason="Wait for sharing changes to save."
                    onClick={() => removeAt(i)}
                    aria-label={`Remove access for ${g.granteeUserId === null ? "Everyone" : (roster.find((u) => u.id === g.granteeUserId)?.email ?? "this user")}`}
                  >
                    Remove
                  </Button>
                </>
              ) : (
                <span className={levelLabel(g.permission) === levels[0] ? "text-muted-foreground text-sm" : "text-sm"}>
                  {levelLabel(g.permission)?.label ?? g.permission}
                </span>
              )}
            </div>
          ))}

          {canManage && !isLoading && !loadError && (
            <div className="grid grid-cols-[minmax(0,1fr)_5rem] items-center gap-3 border-t pt-3 sm:grid-cols-[minmax(0,1fr)_9rem_5rem]">
              <fieldset disabled={busy} className="col-span-2 min-w-0 sm:col-span-1">
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
              </fieldset>
              <ShareLevelSelect<P>
                levels={levels}
                disabled={busy}
                label="Access level to grant"
                value={pickLevel}
                onChange={setPickLevel}
              />
              <Button
                variant="outline"
                size="sm"
                className="h-9"
                onClick={addGrant}
                disabled={busy || !selectedRecipient}
                disabledReason={busy ? "Wait for sharing changes to save." : "Choose who to share with first."}
              >
                Add
              </Button>
            </div>
          )}

          {error && <ErrorNotice>{error}</ErrorNotice>}
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            disabled={busy}
            disabledReason="Wait for sharing changes to save."
            onClick={() => handleClose(false)}
          >
            Cancel
          </Button>
          {canManage && (
            <Button
              onClick={() => void save()}
              disabled={saveDisabled}
              disabledReason={
                busy
                  ? "Wait for sharing changes to save."
                  : loadError
                    ? "Retry loading the sharing settings before saving."
                    : isLoading
                      ? "Wait for the current sharing settings to load."
                      : "No sharing changes to save."
              }
            >
              {busy ? "Saving…" : "Save"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
