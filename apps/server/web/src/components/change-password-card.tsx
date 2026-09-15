import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";
import { MIN_PASSWORD_LENGTH, passwordTooShort } from "@/lib/password";

/**
 * Change-password as a standalone card (spec 2026-09-02 settings-split §1.2) —
 * lifted verbatim out of the old Settings page; the Account page (/account)
 * is its only home since the split landed.
 */
export function ChangePasswordCard() {
  // Change-password form state.
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwSaved, setPwSaved] = useState(false);
  const [pwBusy, setPwBusy] = useState(false);

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    if (passwordTooShort(newPassword)) {
      setPwError(`New password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      return;
    }
    if (newPassword !== confirmPassword) {
      setPwError("New passwords do not match");
      return;
    }
    setPwBusy(true);
    setPwError(null);
    setPwSaved(false);
    try {
      // better-auth's own change-password route (session cookie auth), via
      // the shared client. The destructured local is renamed because the
      // component's own error state already owns the `pwError` name.
      const { error: changeErr } = await authClient.changePassword({
        currentPassword,
        newPassword,
        revokeOtherSessions: true,
      });
      if (changeErr) {
        const details = (changeErr as unknown as { body?: { details?: unknown[] } }).body?.details;
        const detail = Array.isArray(details) && details.length > 0 ? String(details[0]) : null;
        setPwError(detail ?? "Password change failed. Is the current password correct?");
        return;
      }
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setPwSaved(true);
    } catch {
      setPwError("Network error");
    } finally {
      setPwBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Change password</CardTitle>
        <CardDescription>Update the password for your account.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={changePassword} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="current-password">Current password</Label>
            <Input
              id="current-password"
              type="password"
              autoComplete="current-password"
              required
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="new-password">New password</Label>
            <Input
              id="new-password"
              type="password"
              autoComplete="new-password"
              required
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="confirm-password">Confirm new password</Label>
            <Input
              id="confirm-password"
              type="password"
              autoComplete="new-password"
              required
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
            />
          </div>
          {pwError && <p className="text-destructive text-sm">{pwError}</p>}
          {pwSaved && <p className="text-detail text-success">Password updated</p>}
          <Button type="submit" disabled={pwBusy}>
            {pwBusy ? "Updating…" : "Update password"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
