import { apiFetch, Button, errMessage, Input, Label } from "@internal/node-admin";
import { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PASSWORD_REQUIREMENT, passwordTooShort } from "@/lib/password";
import { asUserRole, USER_ROLE_OPTIONS, type UserRole } from "@/types/user-role";

/**
 * Per-user admin controls on `/settings/users`: reassign the role, reset the
 * password, and disable or re-enable the account.
 *
 * All three are server-gated (`requireAdmin`, cookie-only); these controls
 * render only for a cookie admin, which is presentation, never the boundary.
 *
 * The copy carries what the mechanism cannot:
 *
 * - a reset and a disable both **sign the user out everywhere**, which is the
 *   point of them and also a surprise if unannounced, and neither notifies
 *   anyone — there is no email on this instance;
 * - the new password is shown to the admin ONCE, because they have to be able
 *   to read what they set in order to pass it on;
 * - the last admin can be neither demoted nor disabled — surfaced as the
 *   server's own 409 message rather than a guess made client-side, so the two
 *   can never disagree about when it applies.
 */
export interface UserRowActionsProps {
  /** The user this row is for. */
  user: { id: string; email: string; role: UserRole | string | null; disabled?: boolean };
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

  async function changeRole(role: string): Promise<void> {
    if (role === (user.role ?? "user")) return;
    setBusy(true);
    setError(null);
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
    setError(null);
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
    setError(null);
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
    if (errorTimer.current) clearTimeout(errorTimer.current);
    // Cleared on close, not on open: the password must not survive in memory
    // (or in a re-opened dialog) after the admin has finished with it.
    setPassword("");
    setDone(null);
    setError(null);
  }

  function closeDisable(): void {
    setDisableOpen(false);
    setDisabledDone(null);
    setError(null);
  }

  // Nothing at all on your own row. The role select was the last one standing,
  // and it is the worst of them: an admin who demotes or disables themselves
  // has removed their own administration, and nothing short of another admin
  // — which an instance need not have — puts it back. The Role column's badge
  // still says what the role is, so this hides no fact, only every lever.
  if (isSelf) {
    return <span className="text-detail text-muted-foreground">Your account</span>;
  }

  return (
    <div className="flex items-center gap-2">
      <Select
        value={asUserRole(user.role)}
        onValueChange={(v) => void changeRole(v ?? "user")}
        // Base UI's Value prints the raw value without this map, so the closed
        // trigger read "admin" under a menu item reading "Admin".
        items={USER_ROLE_OPTIONS}
        disabled={busy}
      >
        <SelectTrigger className="h-8 w-28" aria-label={`Role for ${user.email}`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {USER_ROLE_OPTIONS.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* A reset here never applies to the viewer (the self row returned
          above): Account is the path that requires the current password, and
          offering both would make the weaker one the obvious choice. */}
      <Button variant="outline" size="sm" disabled={busy} onClick={() => setResetOpen(true)}>
        Reset password
      </Button>

      {user.disabled ? (
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void setDisabled(false)}>
          Enable
        </Button>
      ) : (
        <Button variant="outline" size="sm" disabled={busy} onClick={() => setDisableOpen(true)}>
          Disable
        </Button>
      )}

      {error && !disableOpen && (
        <span role="alert" className="text-destructive text-detail">
          {error}
        </span>
      )}

      <Dialog open={resetOpen} onOpenChange={(open) => (open ? setResetOpen(true) : closeReset())}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reset password for {user.email}</DialogTitle>
            <DialogDescription>
              Sets a new password immediately and signs this user out of every device. They are not notified. There is
              no email on this instance, so pass the password on yourself.
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
            <DialogTitle>Disable {user.email}</DialogTitle>
            <DialogDescription>
              They can no longer sign in, they are signed out of every device immediately, and every credential they
              hold stops working — API keys, and the tokens their running subshells authenticate with. They are not
              notified: there is no email on this instance, so tell them yourself. Enabling the account again restores
              all of it.
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
