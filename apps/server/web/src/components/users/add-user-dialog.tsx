import { useEffect, useState } from "react";
import {
  EMPTY_NEW_ACCOUNT,
  NewAccountFields,
  type NewAccountValue,
  newAccountComplete,
} from "@/components/account/new-account-fields";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiFetch, errMessage } from "@/lib/api";
import { USER_ROLES, type UserRole } from "@/types/user-role";

/** How the role picker spells each role — matching `UserRowActions`' select. */
const ROLE_LABELS: Record<UserRole, string> = { admin: "Admin", user: "User" };

/**
 * Creates a credential account, from the page header of `/settings/users`
 * (spec 2026-09-14 §3).
 *
 * The body is the SAME component the first-run wizard asks with
 * (`NewAccountFields`), plus the one field setup has no use for: a role, since
 * the first account is an admin by definition. Before this, the admin's form
 * was a thinner second copy — email and password, no confirmation and no
 * statement of the password rule — so the person creating an account for
 * someone else got less help than the person creating their own.
 *
 * It is a dialog rather than the card that used to sit above the roster
 * because adding a user is occasional, and a permanent form pushed the thing
 * the page is actually for below the fold.
 */
export function AddUserDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  /** Whether the dialog is shown */
  open: boolean;
  /** Open/close from inside (Cancel, the overlay, a successful create) */
  onOpenChange: (open: boolean) => void;
  /** A user now exists — the caller refreshes the roster and the sharing picker */
  onCreated: () => void;
}) {
  const [account, setAccount] = useState<NewAccountValue>(EMPTY_NEW_ACCOUNT);
  const [role, setRole] = useState<UserRole>("user");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Two passwords live in this state and in the DOM. Unmounting — navigating
  // away with the dialog still open — must not be the one path that leaves
  // them there, the same rule `UserRowActions` follows for the reset box.
  useEffect(() => {
    return () => setAccount(EMPTY_NEW_ACCOUNT);
  }, []);

  function close(): void {
    onOpenChange(false);
    setAccount(EMPTY_NEW_ACCOUNT);
    setRole("user");
    setError(null);
  }

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiFetch("/api/users", {
        method: "POST",
        body: JSON.stringify({
          name: account.name.trim(),
          email: account.email.trim(),
          password: account.password,
          role,
        }),
      });
      close();
      onCreated();
    } catch (err) {
      // The duplicate-email 409 lands here, and the dialog STAYS open: the
      // form is the only copy of what was typed, and closing it to report a
      // fixable refusal would throw that away.
      setError(errMessage(err, "Couldn't create the user."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent>
        <form onSubmit={(e) => void submit(e)}>
          <DialogHeader>
            <DialogTitle>Add user</DialogTitle>
            <DialogDescription>Creates a credential account that can sign in immediately.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <NewAccountFields value={account} onChange={setAccount} idPrefix="new-user" autoFocus />
            <div className="space-y-2">
              <Label htmlFor="new-user-role">Role</Label>
              <Select value={role} onValueChange={(v) => v !== null && setRole(v as UserRole)}>
                <SelectTrigger id="new-user-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {/* Capitalised like the per-row role select in
                      `UserRowActions`: two role controls on one page must
                      spell the same value the same way. */}
                  {USER_ROLES.map((r) => (
                    <SelectItem key={r} value={r}>
                      {ROLE_LABELS[r]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {error && <p className="text-destructive text-sm">{error}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={close} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !newAccountComplete(account)}>
              {busy ? "Creating…" : "Add user"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
