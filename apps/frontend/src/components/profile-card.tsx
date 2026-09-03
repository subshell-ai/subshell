import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCurrentUser } from "@/lib/auth";
import { authClient } from "@/lib/auth-client";

/**
 * The Profile card's only rule (spec 2026-09-02 settings-split §1.1): the
 * display name saves trimmed and must not be blank.
 * @param raw - the input's raw value
 * @returns the trimmed name, or null when blank (not saveable)
 */
export function nameIsUsable(raw: string): string | null {
  const t = raw.trim();
  return t === "" ? null : t;
}

/** Input to the name-save mutation — mirrors better-auth's `updateUser`. */
export interface ProfileUpdateInput {
  /** Trimmed display name */
  name: string;
}

/** Result shape the card reads: better-auth's `error` (message or null). */
export interface ProfileUpdateResult {
  /** null/undefined on success; carries `message` for the error line */
  error?: { message?: string } | null;
}

export interface ProfileCardProps {
  /**
   * Name-save mutation, injectable for tests (the real `authClient` is a
   * proxy whose methods cannot be spied). Defaults to better-auth's
   * `updateUser` — same pattern NotificationsCard uses for its lib hooks.
   */
  updateUser?: (input: ProfileUpdateInput) => Promise<ProfileUpdateResult>;
}

/**
 * Account: the user's own identity. Name is editable through
 * better-auth's `updateUser`; email is the credential and stays read-only.
 * Saving invalidates the `["current-user"]` query so the sidebar user menu
 * (and this card's fallback) pick up the new name.
 */
export function ProfileCard({ updateUser = (input) => authClient.updateUser(input) }: ProfileCardProps) {
  const queryClient = useQueryClient();
  const { data: user } = useCurrentUser();
  // Edit buffer: null until the user touches the field, so the input always
  // shows the server-reported name first (no prefill race with the query).
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const shown = nameDraft ?? user?.name ?? "";

  async function save() {
    const name = nameIsUsable(shown);
    if (name === null) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const { error: updateErr } = await updateUser({ name });
      if (updateErr) {
        setError(updateErr.message ?? "Couldn't update your profile.");
        return;
      }
      // Show exactly what was saved: the draft still holds the raw input
      // (padding and all) — normalize it to the trimmed name the server kept.
      // First, so the field settles even while the cache refresh below is in
      // flight (the UI must not wait on an unrelated query to be truthful).
      setNameDraft(name);
      setSaved(true);
      // One source of truth: the sidebar menu and this card both read the
      // ["current-user"] query — refresh it and the new name shows everywhere.
      await queryClient.invalidateQueries({ queryKey: ["current-user"] });
    } catch {
      setError("Network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Profile</CardTitle>
        <CardDescription>Your display name and sign-in email.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Unknown ≠ shown: the fields appear only once the session query has
            answered — the form never claims a state the server hasn't reported
            (same posture as the Registration switch). */}
        {!user ? (
          <p className="text-muted-foreground text-sm">Loading…</p>
        ) : (
          <>
            <div className="flex items-end gap-2">
              <div className="flex-1 space-y-2">
                <Label htmlFor="profile-name">Name</Label>
                <Input
                  id="profile-name"
                  value={shown}
                  onChange={(e) => {
                    setNameDraft(e.target.value);
                    setSaved(false);
                  }}
                />
              </div>
              <Button onClick={() => void save()} disabled={busy || nameIsUsable(shown) === null}>
                {busy ? "Saving…" : "Save"}
              </Button>
              {saved && <span className="text-success text-xs">saved</span>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="profile-email">Email</Label>
              {/* Read-only by design: the email IS the credential; changing it
                  is not offered here (muted to say so at a glance). */}
              <Input id="profile-email" value={user.email} readOnly className="text-muted-foreground" />
            </div>
            {error && <p className="text-destructive text-sm">{error}</p>}
          </>
        )}
      </CardContent>
    </Card>
  );
}
