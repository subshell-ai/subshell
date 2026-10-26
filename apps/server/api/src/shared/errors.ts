/**
 * Thrown by guards on missing/invalid credentials; Elysia maps `status`.
 * The message is overridable (it reaches the client via the error handler);
 * the default keeps every generic rejection worded as it always has been.
 */
export class UnauthorizedError extends Error {
  readonly status = 401;
  constructor(message = "Unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}
/** Thrown by guards on insufficient permissions; Elysia maps `status`. */
export class ForbiddenError extends Error {
  readonly status = 403;
  constructor() {
    super("Forbidden");
    this.name = "ForbiddenError";
  }
}
/**
 * Route-level error carrying an HTTP status; Elysia maps `status` to the
 * response code. The shared form for "throw NNN with this message" in any
 * /api route handler — routes need not redeclare it per file.
 */
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}
