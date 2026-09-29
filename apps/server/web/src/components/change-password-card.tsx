import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label } from "@internal/node-admin";
import { useState } from "react";
import { z } from "zod";
import { authClient } from "@/lib/auth-client";
import { fieldError, makeForm, useSubmitDisabled } from "@/lib/form";
import { MIN_PASSWORD_LENGTH, PASSWORD_REQUIREMENT, passwordTooShort } from "@/lib/password";

/**
 * Change-password as a standalone card (spec 2026-09-02 settings-split §1.2)
 * — lifted verbatim out of the old Settings page; the Account page (/account)
 * is its own home. Gated by the substrate sweep (spec 2026-09-29): Update is
 * DISABLED until the one schema is satisfied; the requirement line and the
 * touched-field sentences explain WHY it is dead (the 2026-09-14 rule: a grey
 * button with no way to learn why was the operator's complaint).
 */
const changePasswordSchema = z
  .object({ current: z.string(), next: z.string(), confirm: z.string() })
  .superRefine((values, ctx) => {
    if (values.current === "") {
      ctx.addIssue({ code: "custom", path: ["current"], message: "This field is required" });
    }
    if (passwordTooShort(values.next)) {
      ctx.addIssue({
        code: "custom",
        path: ["next"],
        message: `New password must be at least ${MIN_PASSWORD_LENGTH} characters`,
      });
    }
    if (values.next !== values.confirm) {
      ctx.addIssue({ code: "custom", path: ["confirm"], message: "New passwords do not match" });
    }
  });

export function ChangePasswordCard() {
  const [pwError, setPwError] = useState<string | null>(null); // the server's sentence only
  const [pwSaved, setPwSaved] = useState(false);
  const [pwBusy, setPwBusy] = useState(false);

  const form = makeForm({
    defaultValues: { current: "", next: "", confirm: "" },
    validator: changePasswordSchema,
    onSubmit: async ({ current, next }) => {
      // The guards behind the gate (Enter-key paths, races).
      if (current === "" || passwordTooShort(next)) return;
      setPwBusy(true);
      setPwError(null);
      setPwSaved(false);
      try {
        // better-auth's own change-password route (session cookie auth), via
        // the shared client. The destructured local is renamed because the
        // component's own error state already owns the `pwError` name.
        const { error: changeErr } = await authClient.changePassword({
          currentPassword: current,
          newPassword: next,
          revokeOtherSessions: true,
        });
        if (changeErr) {
          const details = (changeErr as unknown as { body?: { details?: unknown[] } }).body?.details;
          const detail = Array.isArray(details) && details.length > 0 ? String(details[0]) : null;
          setPwError(detail ?? "Password change failed. Is the current password correct?");
          return;
        }
        form.reset();
        setPwSaved(true);
      } catch {
        setPwError("Network error");
      } finally {
        setPwBusy(false);
      }
    },
  });
  const disabled = useSubmitDisabled(form, pwBusy);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Change password</CardTitle>
        <CardDescription>Update the password for your account.</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void form.handleSubmit();
          }}
          className="space-y-4"
        >
          <form.Field name="current">
            {(field) => (
              <div className="space-y-2">
                <Label htmlFor="current-password">Current password</Label>
                <Input
                  id="current-password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value)}
                  onBlur={field.handleBlur}
                />
                {field.state.meta.isTouched && fieldError(field.state.meta.errors) && (
                  <p role="alert" className="text-destructive text-detail">
                    {fieldError(field.state.meta.errors)}
                  </p>
                )}
              </div>
            )}
          </form.Field>
          <form.Field name="next">
            {(field) => (
              <div className="space-y-2">
                <Label htmlFor="new-password">New password</Label>
                <Input
                  id="new-password"
                  type="password"
                  autoComplete="new-password"
                  required
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value)}
                  onBlur={field.handleBlur}
                />
                {(() => {
                  const error = field.state.meta.isTouched ? fieldError(field.state.meta.errors) : null;
                  return error ? (
                    <p role="alert" className="text-destructive text-detail">
                      {error}
                    </p>
                  ) : (
                    <p className="text-detail text-muted-foreground">{PASSWORD_REQUIREMENT}</p>
                  );
                })()}
              </div>
            )}
          </form.Field>
          <form.Field name="confirm">
            {(field) => (
              <div className="space-y-2">
                <Label htmlFor="confirm-password">Confirm new password</Label>
                <Input
                  id="confirm-password"
                  type="password"
                  autoComplete="new-password"
                  required
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value)}
                  onBlur={field.handleBlur}
                />
                {field.state.meta.isTouched && fieldError(field.state.meta.errors) && (
                  <p role="alert" className="text-destructive text-detail">
                    {fieldError(field.state.meta.errors)}
                  </p>
                )}
              </div>
            )}
          </form.Field>
          {pwError && <p className="text-destructive text-detail">{pwError}</p>}
          {pwSaved && <p className="text-detail text-success">Password updated</p>}
          <Button type="submit" disabled={disabled}>
            {pwBusy ? "Updating…" : "Update password"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
