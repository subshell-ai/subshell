import {
  apiFetch,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
} from "@internal/node-admin";
import { useState } from "react";
import { ErrorBanner } from "@/components/error-banner";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { signOutAndRedirect } from "@/lib/auth";
import { type FieldProblems, fieldError, makeForm, useSubmitDisabled } from "@/lib/form";

type RecoveryDraft = { currentPassword: string; newPassword: string; confirmation: string };

function recoveryProblems(draft: RecoveryDraft): FieldProblems {
  const problems: FieldProblems = {};
  if (!draft.currentPassword) problems.currentPassword = "Enter the temporary password.";
  if (draft.newPassword.length < 8 || draft.newPassword.length > 4096)
    problems.newPassword = "New password must be 8–4096 characters.";
  else if (draft.newPassword === draft.currentPassword)
    problems.newPassword = "Choose a password different from the temporary password.";
  if (!draft.confirmation || draft.newPassword !== draft.confirmation)
    problems.confirmation = "The new passwords do not match.";
  return problems;
}

/** Rendered before application chrome for accounts recovered with a temporary password. */
export function BackupPasswordRecovery() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focusedField, setFocusedField] = useState<string | null>(null);
  const form = makeForm({
    defaultValues: { currentPassword: "", newPassword: "", confirmation: "" },
    validator: recoveryProblems,
    onSubmit: async (draft) => {
      if (busy || Object.keys(recoveryProblems(draft)).length > 0) return;
      setBusy(true);
      setError(null);
      try {
        await apiFetch("/api/account/recovery/password", {
          method: "POST",
          body: JSON.stringify({ currentPassword: draft.currentPassword, newPassword: draft.newPassword }),
        });
        form.reset();
        window.location.href = "/login";
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : "Could not change the password.");
      } finally {
        setBusy(false);
      }
    },
  });
  const disabled = useSubmitDisabled(form, busy);
  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Choose a new password</CardTitle>
          <CardDescription>
            This account was recovered from a backup. Replace the temporary password before continuing.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void form.handleSubmit();
            }}
          >
            <FieldGroup>
              <form.Field name="currentPassword">
                {(field) => {
                  const problem =
                    field.state.meta.isTouched && focusedField !== "currentPassword"
                      ? fieldError(field.state.meta.errors)
                      : null;
                  return (
                    <Field data-invalid={!!problem}>
                      <FieldLabel htmlFor="recovery-current">Temporary password</FieldLabel>
                      <Input
                        id="recovery-current"
                        type="password"
                        autoComplete="current-password"
                        value={field.state.value}
                        onChange={(event) => field.handleChange(event.target.value)}
                        onFocus={() => setFocusedField("currentPassword")}
                        onBlur={() => {
                          field.handleBlur();
                          setFocusedField(null);
                        }}
                        aria-invalid={!!problem}
                        disabled={busy}
                        required
                      />
                      {problem && (
                        <p role="alert" className="text-destructive text-detail">
                          {problem}
                        </p>
                      )}
                    </Field>
                  );
                }}
              </form.Field>
              <form.Field name="newPassword">
                {(field) => {
                  const problem =
                    field.state.meta.isTouched && focusedField !== "newPassword"
                      ? fieldError(field.state.meta.errors)
                      : null;
                  return (
                    <Field data-invalid={!!problem}>
                      <FieldLabel htmlFor="recovery-new">New password</FieldLabel>
                      <Input
                        id="recovery-new"
                        type="password"
                        autoComplete="new-password"
                        value={field.state.value}
                        onChange={(event) => field.handleChange(event.target.value)}
                        onFocus={() => setFocusedField("newPassword")}
                        onBlur={() => {
                          field.handleBlur();
                          setFocusedField(null);
                        }}
                        aria-invalid={!!problem}
                        disabled={busy}
                        minLength={8}
                        maxLength={4096}
                        required
                      />
                      {problem && (
                        <p role="alert" className="text-destructive text-detail">
                          {problem}
                        </p>
                      )}
                    </Field>
                  );
                }}
              </form.Field>
              <form.Field name="confirmation">
                {(field) => {
                  const problem =
                    field.state.meta.isTouched && focusedField !== "confirmation"
                      ? fieldError(field.state.meta.errors)
                      : null;
                  return (
                    <Field data-invalid={!!problem}>
                      <FieldLabel htmlFor="recovery-confirm">Confirm new password</FieldLabel>
                      <Input
                        id="recovery-confirm"
                        type="password"
                        autoComplete="new-password"
                        value={field.state.value}
                        onChange={(event) => field.handleChange(event.target.value)}
                        onFocus={() => setFocusedField("confirmation")}
                        onBlur={() => {
                          field.handleBlur();
                          setFocusedField(null);
                        }}
                        aria-invalid={!!problem}
                        disabled={busy}
                        minLength={8}
                        maxLength={4096}
                        required
                      />
                      {problem && (
                        <p role="alert" className="text-destructive text-detail">
                          {problem}
                        </p>
                      )}
                    </Field>
                  );
                }}
              </form.Field>
              {error && <ErrorBanner message={error} />}
              <Button type="submit" disabled={disabled}>
                {busy ? "Changing password…" : "Change password and sign in"}
              </Button>
              <Button type="button" variant="outline" disabled={busy} onClick={() => void signOutAndRedirect()}>
                Sign out
              </Button>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
