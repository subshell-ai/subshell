import { apiFetch, Button, errMessage, Input, Label } from "@internal/node-admin";
import { KeyRound, ShieldCheck, ShieldOff, UserCheck, UserX } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { type ActionItem, ActionsMenu } from "@/components/actions-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PASSWORD_REQUIREMENT, passwordTooShort } from "@/lib/password";
import { asUserRole, USER_ROLE_LABELS, type UserRole } from "@/types/user-role";

/**
 * Per-user admin controls on `/settings/users`: one action menu offering the
 * role flip, the password reset, and the disable or re-enable.
 *
 * All three are server-gated (`requireAdmin`, cookie-only); these controls
 * render only for a cookie admin, which is presentation, never the boundary.
 *
 * It is the shared `ActionsMenu` (the Nodes rows drive the same component)
 * because this table sits beside every other roster in the app, and the last
 * one still spreading three inline widgets reads as a different product. The
 * column header it sits under is visually empty for the same reason the Nodes
 * table's is: a `Manage` title above rows whose only content is "Your account"
 * or "Service account" reads as a control that failed to render, not as the
 * statement that the row is not manageable.
 *
 * The copy carries what the mechanism cannot (terse by operator ruling,
 * 2026-09-24 — each fact named once, nothing restored without asking):
 *
 * - a reset and a disable both **sign the user out everywhere**, which is the
 *   point of them and also a surprise if unannounced, and neither notifies
 *   anyone — there is no email on this instance;
 * - since the 2026-09-24 ruling a disable also **takes the account's enrolled
 *   nodes offline** (they reconnect on their own within a minute of a
 *   re-enable), so the one word `nodes` in the confirmation carries that
 *   state: the admin presses it, so the admin hears what it costs;
 * - the new password is shown to the admin ONCE, because they have to be able
 *   to read what they set in order to pass it on;
 * - the last admin cannot be demoted, and the last ENABLED admin cannot be
 *   disabled — two rules, one for each direction of the flip and the disable.
 *   Both are surfaced as the server's own 409 message rather than a client-side
 *   guess, so the two can never disagree about when they apply.
 */
export interface UserRowActionsProps {
  /** The user this row is for. `role` is a raw string (null = no `user_meta`
   * row), narrowed through `asUserRole` below, not a pre-narrowed UserRole.
   * `providers` is the account's sign-in provider ids; when it is PRESENT and
   * lacks `credential` there is no password to reset, so the item is omitted.
   * Absent = an older payload: the item stays and the server's 409 is the
   * backstop. */
  user: { id: string; email: string; role: string | null; disabled?: boolean; providers?: string[] };
  /** The signed-in admin's own id — self gets no controls at all. */
  viewerId: string | null;
  /** Refetch the roster after a change. */
  onChanged: () => void;
}

/** Sessions cut by a reset or a disable, in the one sentence both report it with. */
function sessionsCut(count: number): string {
  return count === 0 ? "They had no active sessions." : `Signed out of ${count} session${count === 1 ? "" : "s"}.`;
}

export function UserRowActions({ user, viewerId, onChanged }: UserRowActionsProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [done, setDone] = useState<{ sessionsRevoked: number } | null>(null);
  const [disabledDone, setDisabledDone] = useState<{ sessionsRevoked: number } | null>(null);
  const isSelf = viewerId !== null && viewerId === user.id;
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The password lives in component state and, once set, in the DOM as text.
  // Unmounting — navigating away with the dialog still open — must not be the
  // one path that leaves it there.
  useEffect(() => {
    return () => {
      setPassword("");
      setDone(null);
      if (errorTimer.current) clearTimeout(errorTimer.current);
    };
  }, []);

  /**
   * Shows an error and retires it.
   *
   * Row-level errors have no dismiss affordance and nothing else clears them,
   * so a failed role change used to sit beside the row indefinitely — long
   * after the state it described stopped being true.
   */
  function reportError(message: string): void {
    if (errorTimer.current) clearTimeout(errorTimer.current);
    setError(message);
    errorTimer.current = setTimeout(() => setError(null), 8000);
  }

  /**
   * Takes back the error AND its retire timer — every path that clears `error`
   * early (dialog close, dialog open) uses this so no orphaned callback can
   * outlive the message it was scheduled to erase.
   */
  function clearError(): void {
    if (errorTimer.current) clearTimeout(errorTimer.current);
    setError(null);
  }

  async function changeRole(role: UserRole): Promise<void> {
    setBusy(true);
    clearError();
    try {
      await apiFetch(`/api/users/${user.id}/role`, { method: "PATCH", body: JSON.stringify({ role }) });
      onChanged();
    } catch (err) {
      // The last-admin refusal lands here. Showing the server's sentence
      // verbatim keeps one explanation of the rule, on the side that enforces
      // it.
      reportError(errMessage(err, "Could not change the role"));
    } finally {
      setBusy(false);
    }
  }

  async function resetPassword(): Promise<void> {
    setBusy(true);
    clearError();
    try {
      const res = await apiFetch<{ sessionsRevoked: number }>(`/api/users/${user.id}/password`, {
        method: "PATCH",
        body: JSON.stringify({ password }),
      });
      setDone({ sessionsRevoked: res.sessionsRevoked });
      onChanged();
    } catch (err) {
      reportError(errMessage(err, "Could not reset the password"));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Flips the account's `disabled` flag.
   *
   * Only the disabling direction is confirmed: it signs someone out of every
   * device and locks them out until an admin comes back, where enabling only
   * widens access and is undone by the button it turns into.
   */
  async function setDisabled(disabled: boolean): Promise<void> {
    setBusy(true);
    clearError();
    try {
      const res = await apiFetch<{ sessionsRevoked: number }>(`/api/users/${user.id}/disabled`, {
        method: "PATCH",
        body: JSON.stringify({ disabled }),
      });
      // Only the disable direction has a dialog to report into; enabling
      // reports by turning back into a Disable button on the refetched row.
      if (disabled) setDisabledDone({ sessionsRevoked: res.sessionsRevoked });
      onChanged();
    } catch (err) {
      // The last-ENABLED-admin refusal lands here, as the same kind of 409 the
      // demotion refusal sends, and is shown the same way: the server's words.
      reportError(errMessage(err, disabled ? "Could not disable the account" : "Could not enable the account"));
    } finally {
      setBusy(false);
    }
  }

  function closeReset(): void {
    setResetOpen(false);
    // Cleared on close, not on open: the password must not survive in memory
    // (or in a re-opened dialog) after the admin has finished with it.
    setPassword("");
    setDone(null);
    clearError();
  }

  function closeDisable(): void {
    setDisableOpen(false);
    setDisabledDone(null);
    clearError();
  }

  // Nothing at all on your own row: every one of the three is a way to remove
  // your own administration, and nothing short of another admin — which an
  // instance need not have — puts it back. The Role column's badge still says
  // what the role is, so this hides no fact, only every lever.
  if (isSelf) {
    return <span className="text-detail text-muted-foreground">Your account</span>;
  }

  // A door-only account has no password to reset — offering the item would
  // promise an act the server refuses. `providers` absent (a payload cached
  // before the field existed) keeps the item: the server's 409 is still the
  // truth there, and hiding it would UNDO a control for accounts that have
  // one, on the strength of a field that never arrived.
  const hasPassword = user.providers === undefined || user.providers.includes("credential");
  const roleTarget: UserRole = asUserRole(user.role) === "admin" ? "user" : "admin";
  const items: ActionItem[] = [
    {
      // One item named by the TARGET role — the flip's answer, not its
      // question — with the word traced to USER_ROLE_LABELS so menu and badge
      // cannot spell a role differently. Sentence-cased into the item the way
      // every menu in the app spells its actions.
      label: `${roleTarget === "admin" ? "Promote to" : "Demote to"} ${USER_ROLE_LABELS[roleTarget].toLowerCase()}`,
      icon: roleTarget === "admin" ? ShieldCheck : ShieldOff,
      onSelect: () => void changeRole(roleTarget),
    },
    ...(hasPassword
      ? [
          {
            // A reset here never applies to the viewer (the self row returned
            // above): Account is the path that requires the current password,
            // and offering both would make the weaker one the obvious choice.
            label: "Reset password",
            icon: KeyRound,
            // Clears the row error first, for the same reason the disable item
            // does: the dialog renders `error` itself, so a stale refusal from
            // another act would be misattributed to this one. closeReset
            // already clears on the way out, but not every open is preceded
            // by a close.
            onSelect: () => {
              clearError();
              setResetOpen(true);
            },
          },
        ]
      : []),
    user.disabled
      ? { label: "Enable account", icon: UserCheck, onSelect: () => void setDisabled(false) }
      : // The only red item: it locks a person out until an admin returns.
        // Demotion loses no session and is undone by the item's other half one
        // click away, so it stays neutral.
        {
          label: "Disable account",
          icon: UserX,
          destructive: true,
          // Clears the row error first: the in-dialog alert shows `error`, so
          // a role-flip refusal still inside its 8 s window would otherwise
          // be misattributed to the act being confirmed here.
          onSelect: () => {
            clearError();
            setDisableOpen(true);
          },
        },
  ];

  return (
    <div className="flex items-center justify-end gap-2">
      <ActionsMenu label={user.email} items={items} disabled={busy} />

      {/* Gated by both modals: a refusal met INSIDE a dialog belongs to the
          dialog (it renders `error` there), not to the row behind the scrim. */}
      {error && !disableOpen && !resetOpen && (
        <span role="alert" className="text-destructive text-detail">
          {error}
        </span>
      )}

      <Dialog open={resetOpen} onOpenChange={(open) => (open ? setResetOpen(true) : closeReset())}>
        <DialogContent>
          <DialogHeader>
            {/* One static title for a repeated act, and the email in the body
                where the sentence needs it: the title says what the dialog IS,
                the body says who it lands on. */}
            <DialogTitle>Reset password</DialogTitle>
            <DialogDescription>
              Sets a new password for {user.email} and signs them out of every device. They won't be notified.
            </DialogDescription>
          </DialogHeader>

          {done ? (
            <div className="space-y-3">
              <p className="text-sm">Password changed. {sessionsCut(done.sessionsRevoked)}</p>
              {/* Shown once, and only here: this is the admin's only chance to
                  read what they set. */}
              <div className="space-y-1">
                <Label>New password</Label>
                <code className="block rounded-md border px-3 py-2 font-mono text-sm">{password}</code>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <Label htmlFor={`pw-${user.id}`}>New password</Label>
              <Input
                id={`pw-${user.id}`}
                // Deliberately not a password field: the admin is setting a
                // value to communicate, not entering their own secret, and
                // masking it would mean they cannot check what they typed.
                type="text"
                autoComplete="off"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={PASSWORD_REQUIREMENT}
              />
              {/* Same rule as the disable dialog: the refusal an admin meets
                  here renders here, not on the row behind the scrim. */}
              {error && (
                <p role="alert" className="text-destructive text-detail">
                  {error}
                </p>
              )}
            </div>
          )}

          <DialogFooter>
            {done ? (
              <Button onClick={closeReset}>Done</Button>
            ) : (
              <>
                <Button variant="ghost" onClick={closeReset} disabled={busy}>
                  Cancel
                </Button>
                <Button onClick={() => void resetPassword()} disabled={busy || passwordTooShort(password.trim())}>
                  Reset and sign out
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={disableOpen} onOpenChange={(open) => (open ? setDisableOpen(true) : closeDisable())}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disable account</DialogTitle>
            <DialogDescription>
              Everything stops for {user.email}: sign-in, their sessions, their keys and subshells, their nodes. They
              won't be notified.
            </DialogDescription>
          </DialogHeader>

          {disabledDone ? (
            <p className="text-sm">Account disabled. {sessionsCut(disabledDone.sessionsRevoked)}</p>
          ) : (
            // Inside the dialog rather than on the row behind it: the refusal
            // an admin meets here — the last enabled admin — arrives while the
            // modal is covering the row.
            error && (
              <p role="alert" className="text-destructive text-detail">
                {error}
              </p>
            )
          )}

          <DialogFooter>
            {disabledDone ? (
              <Button onClick={closeDisable}>Done</Button>
            ) : (
              <>
                <Button variant="ghost" onClick={closeDisable} disabled={busy}>
                  Cancel
                </Button>
                <Button onClick={() => void setDisabled(true)} disabled={busy}>
                  Disable and sign out
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
