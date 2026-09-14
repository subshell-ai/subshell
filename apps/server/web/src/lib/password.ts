/**
 * The password rule, in one place.
 *
 * The number was spelled six times across four files — the setup form's
 * disabled rule and both of its `minLength`s, the admin's create-user and
 * reset-password forms, and the change-password card — so the requirement and
 * the copy describing it could drift apart, and did: nothing on the setup
 * screen said what it was, leaving a greyed Create Account button and no way
 * to learn why (operator's report, 2026-09-14).
 *
 * **It mirrors better-auth's own default**, which `apps/server/api/src/auth.ts`
 * does not override. If the server ever sets `minPasswordLength`, this is the
 * value that has to move with it — a form that asks for less than the server
 * accepts fails on submit with the server's words instead of its own.
 */
export const MIN_PASSWORD_LENGTH = 8;

/** The requirement, as the line under a password box states it. */
export const PASSWORD_REQUIREMENT = `At least ${MIN_PASSWORD_LENGTH} characters`;

/**
 * Whether what has been typed is still too short to submit.
 *
 * Note this is true of an EMPTY box as well: it answers "can this be
 * submitted", not "should the person be told off yet". A form showing the
 * requirement in red before anything is typed is nagging, so callers that
 * colour the line check for content themselves.
 * @param password - What is in the box right now
 */
export function passwordTooShort(password: string): boolean {
  return password.length < MIN_PASSWORD_LENGTH;
}
