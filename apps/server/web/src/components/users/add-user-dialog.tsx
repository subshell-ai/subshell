import { apiPost, Button, errMessage, Label } from "@internal/node-admin";
import { useEffect, useState } from "react";
import {
  EMPTY_NEW_ACCOUNT,
  NewAccountFields,
  type NewAccountValue,
  newAccountComplete,
  normalizeNewAccount,
} from "@/components/account/new-account-fields";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { USER_ROLE_OPTIONS, type UserRole } from "@/types/user-role";

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

  // Two passwords live in this state and in the DOM, and what clears them is
  // `close` below — every dismissal, Cancel and overlay and successful create
  // alike, resets the form, so a reopened dialog is blank. This unmount
  // cleanup adds nothing to that: React discards a state update on an
  // unmounted component and the state object is released with the fiber
  // either way. It stays because `UserRowActions` does the same for its reset
  // box, and one of the two quietly dropping it would read as a difference
  // that means something.
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
      // One normalization, shared with setup: the two callers used to
      // disagree about whether a typed name kept its spaces.
      const submitted = normalizeNewAccount(account);
      await apiPost("/api/users", {
        name: submitted.name,
        email: submitted.email,
        password: submitted.password,
        role,
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
            {/* Role leads: it is the one decision the admin makes ABOUT this
                person rather than a fact they are transcribing, and a control
                sitting below a password confirmation is a control people
                submit past. `autoFocus` deliberately stays on Name — the
                first thing typed is still a name, and the role has a usable
                default — so the focused field is no longer the first one on
                screen. */}
            <div className="space-y-2">
              <Label htmlFor="new-user-role">Role</Label>
              <Select
                value={role}
                onValueChange={(v) => v !== null && setRole(v as UserRole)}
                // Base UI's Value prints the raw value without this map, so
                // the closed trigger read "user" under an item reading "User".
                // Shared with the per-row select: two role controls on one
                // page must spell the same value the same way.
                items={USER_ROLE_OPTIONS}
              >
                <SelectTrigger id="new-user-role">
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
            </div>
            <NewAccountFields value={account} onChange={setAccount} idPrefix="new-user" autoFocus />
            {/* `role="alert"`, as every other failure line in the app carries:
                without it a screen-reader user submitting a duplicate email
                gets a dialog that appears to do nothing at all. */}
            {error && (
              <p role="alert" className="text-destructive text-sm">
                {error}
              </p>
            )}
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
