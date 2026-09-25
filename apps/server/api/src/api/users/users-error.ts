/**
 * The users surface's status-carrying error (the auth-guard classes' shape,
 * scoped to this directory). Default 409: the management refusals that read as
 * conflicts (last-admin, no-password-login) are the common case, and the 400/
 * 404/403 call sites name their status explicitly.
 */
export class UsersError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 409) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
