import { UsersError } from "@/api/users/users-error.js";

/**
 * Minimum password length, enforced in the HANDLERS rather than as a
 * `minLength` on the schema.
 *
 * Elysia renders a schema failure by putting the offending VALUE in the error
 * message, and `error-handler.plugin.ts` copies that message into the response
 * body — so a `minLength: 8` here would echo a rejected password back in the
 * 400. It reaches only the admin who typed it, so the disclosure is small, but
 * a password in a response body is a password in every proxy log and browser
 * devtools panel between here and them, and this route's whole contract is
 * that it never echoes one.
 *
 * The cost is that the bound is no longer in the OpenAPI schema; the field
 * descriptions state it instead.
 */
export const MIN_PASSWORD_LENGTH = 8;

/** Refuses a too-short password WITHOUT naming it. */
export function assertPasswordLength(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new UsersError("bad_request", `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`, 400);
  }
}
