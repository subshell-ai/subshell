import { useEffect, useRef, useState } from "react";
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
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiFetch, errMessage } from "@/lib/api";
import type { UserRole } from "@/types/user-role";

/**
 * Per-user admin controls on `/users`: reassign the role, and reset the
 * password.
 *
 * Both are server-gated (`requireAdmin`, cookie-only); these controls render
 * only for a cookie admin, which is presentation, never the boundary.
 *
 * The copy carries three things the mechanism cannot:
 *
 * - a reset **signs the user out everywhere**, which is the point of it and
 *   also a surprise if unannounced;
 * - the new password is shown to the admin ONCE, because there is no email
 *   delivery here and they have to be able to read what they set in order to
 *   pass it on;
 * - the last admin cannot be demoted — surfaced as the server's own 409
 *   message rather than a guess made client-side, so the two can never
 *   disagree about when it applies.
 */
export interface UserRowActionsProps {
  /** The user this row is for. */
  user: { id: string; email: string; role: UserRole | string | null };
  /** The signed-in admin's own id — self gets a role control but no reset. */
  viewerId: string | null;
  /** Refetch the roster after a change. */
  onChanged: () => void;
}

export function UserRowActions({ user, viewerId, onChanged }: UserRowActionsProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [done, setDone] = useState<{ sessionsRevoked: number } | null>(null);
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

  function closeReset(): void {
    setResetOpen(false);
    if (errorTimer.current) clearTimeout(errorTimer.current);
    // Cleared on close, not on open: the password must not survive in memory
    // (or in a re-opened dialog) after the admin has finished with it.
    setPassword("");
    setDone(null);
    setError(null);
  }

  return (
    <div className="flex items-center gap-2">
      <Select value={user.role ?? "user"} onValueChange={(v) => void changeRole(v ?? "user")} disabled={busy}>
        <SelectTrigger className="h-8 w-28" aria-label={`Role for ${user.email}`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="admin">Admin</SelectItem>
          <SelectItem value="user">User</SelectItem>
        </SelectContent>
      </Select>

      {/* No self-reset: Account is the path that requires the current
          password, and offering both here would make the weaker one the
          obvious choice. */}
      {!isSelf && (
        <Button variant="outline" size="sm" disabled={busy} onClick={() => setResetOpen(true)}>
          Reset password
        </Button>
      )}

      {error && (
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
              <p className="text-sm">
                Password changed.{" "}
                {done.sessionsRevoked === 0
                  ? "They had no active sessions."
                  : `Signed out of ${done.sessionsRevoked} session${done.sessionsRevoked === 1 ? "" : "s"}.`}
              </p>
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
                placeholder="At least 8 characters"
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
                <Button onClick={() => void resetPassword()} disabled={busy || password.trim().length < 8}>
                  Reset and sign out
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
