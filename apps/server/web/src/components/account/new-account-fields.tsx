import { cn, Input, Label } from "@internal/node-admin";
import { useState } from "react";
import { MIN_PASSWORD_LENGTH, PASSWORD_REQUIREMENT, passwordTooShort } from "@/lib/password";

/** Everything asked of someone creating an account, in one state a caller holds. */
export interface NewAccountValue {
  /** Display name — what the roster and the sidebar call this person */
  name: string;
  /** Sign-in identity */
  email: string;
  /** The new password */
  password: string;
  /** Typed a second time; must match before anything can be submitted */
  confirmPassword: string;
}

/** A blank form. Exported so a caller's `useState` and its reset agree. */
export const EMPTY_NEW_ACCOUNT: NewAccountValue = { name: "", email: "", password: "", confirmPassword: "" };

/**
 * What a caller should actually SUBMIT: the same value with name and email
 * trimmed, passwords untouched.
 *
 * It lives here rather than at each call site because the two callers
 * disagreed about it — the Add user dialog trimmed on the way out and setup
 * sent both fields raw, so `"  Ada  "` was stored with its spaces through
 * first run alone. `POST /api/users` normalizes the name server-side, but the
 * setup screen registers through better-auth rather than that route, so this
 * is the only thing covering first run.
 *
 * Passwords are left exactly as typed: a leading or trailing space is a
 * character of the secret, and trimming one would create a password nobody
 * can sign in with.
 */
export function normalizeNewAccount(value: NewAccountValue): NewAccountValue {
  return { ...value, name: value.name.trim(), email: value.email.trim() };
}

/**
 * Whether the form may be submitted: name and email present, password long
 * enough, confirmation matching.
 *
 * Name and email are checked TRIMMED because a run of spaces satisfies a
 * `required` attribute and an HTML `minLength`, and the server trims them
 * before storing — so without this the only thing standing between a person
 * and an account called " " is a round trip that comes back 400.
 */
export function newAccountComplete(value: NewAccountValue): boolean {
  const normalized = normalizeNewAccount(value);
  return (
    normalized.name.length > 0 &&
    normalized.email.length > 0 &&
    !passwordTooShort(value.password) &&
    value.confirmPassword === value.password
  );
}

/**
 * The four fields an account is created from, with the two rules that make
 * them usable.
 *
 * It exists because the first-run wizard and the admin's Add user dialog ask
 * the same question, and the admin's copy used to be a thinner one — email
 * and password only, no confirmation and no statement of the password rule,
 * so an admin creating an account got less help than the person creating the
 * first one. One component instead of two means a fix to either reaches both.
 *
 * It renders NO `<form>` and no submit button: setup's primary action lives in
 * the assistant's footer and the dialog's in `DialogFooter`, so the caller
 * owns the element that submits and this owns only the fields.
 *
 * @param props.idPrefix - Prefixes the input ids so two copies on one page
 *   cannot collide. Omitted, the ids are setup's originals (`name`, `email`,
 *   `password`, `password-confirm`), which its tests and e2e already name.
 * @param props.autoFocus - Focus Name on mount.
 */
export function NewAccountFields({
  value,
  onChange,
  idPrefix,
  autoFocus,
}: {
  value: NewAccountValue;
  onChange: (next: NewAccountValue) => void;
  idPrefix?: string;
  autoFocus?: boolean;
}) {
  // Whether the confirm box has been LEFT. A mismatch is inevitable while a
  // second password is being typed, so complaining on every keystroke tells
  // someone they are wrong for most of the time they are doing it right.
  const [confirmTouched, setConfirmTouched] = useState(false);
  const id = (suffix: string) => (idPrefix ? `${idPrefix}-${suffix}` : suffix);
  const requirementId = id("password-requirement");
  const set = (patch: Partial<NewAccountValue>) => onChange({ ...value, ...patch });

  return (
    <>
      <div className="space-y-2">
        <Label htmlFor={id("name")}>Name</Label>
        <Input
          id={id("name")}
          required
          autoFocus={autoFocus}
          value={value.name}
          onChange={(e) => set({ name: e.target.value })}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor={id("email")}>E-mail</Label>
        <Input
          id={id("email")}
          type="email"
          required
          value={value.email}
          onChange={(e) => set({ email: e.target.value })}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor={id("password")}>Password</Label>
        <Input
          id={id("password")}
          type="password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          autoComplete="new-password"
          aria-describedby={requirementId}
          value={value.password}
          onChange={(e) => set({ password: e.target.value })}
        />
        {/* The requirement, stated BEFORE it is broken. The submit button is
            disabled until it is met, and with nothing here that button was
            simply grey with no way to learn why. It goes red only once
            something has been typed — red under an empty box is telling
            someone off for not having started. */}
        <p
          id={requirementId}
          className={cn(
            "text-detail",
            value.password.length > 0 && passwordTooShort(value.password)
              ? "text-destructive"
              : "text-muted-foreground",
          )}
        >
          {PASSWORD_REQUIREMENT}
        </p>
      </div>
      <div className="space-y-2">
        <Label htmlFor={id("password-confirm")}>Confirm password</Label>
        <Input
          id={id("password-confirm")}
          type="password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          autoComplete="new-password"
          value={value.confirmPassword}
          onChange={(e) => set({ confirmPassword: e.target.value })}
          onBlur={() => setConfirmTouched(true)}
        />
      </div>
      {confirmTouched && value.confirmPassword !== value.password && (
        <p className="text-destructive text-detail">Passwords do not match</p>
      )}
    </>
  );
}
