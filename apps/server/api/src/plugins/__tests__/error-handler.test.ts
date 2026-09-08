import { describe, expect, it } from "bun:test";
import { Elysia, t } from "elysia";
import { ForbiddenError, HttpError, UnauthorizedError } from "@/api/auth-guard.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";

/**
 * The global error handler is tested against a minimal probe app rather than
 * subshell's real routes: the handler duck-types on `.status`, so locally declared
 * carrier classes exercise exactly the same branch the real `FilesError`
 * and friends hit in production. The three classes auth-guard actually throws
 * (HttpError / UnauthorizedError / ForbiddenError) ARE imported for real — they
 * are the contract every /api route relies on.
 */

/** A route-local status carrier shaped like FilesError: `.status` plus a private `.code`. */
class LocalCarrierError extends Error {
  readonly status = 409;
  /** Local, non-contract code — the handler must NOT propagate it. */
  readonly code = "PATH_EXISTS";
  constructor() {
    super("path already exists");
    this.name = "LocalCarrierError";
  }
}

/** A status with no dedicated BackendErrorCodes entry — exercises the fallback rule. */
class TeapotError extends Error {
  readonly status = 418;
  constructor() {
    super("i am a teapot");
    this.name = "TeapotError";
  }
}

/** A 5xx carrier: the status must survive and the code must map to INTERNAL_SERVER_ERROR. */
class DownstreamError extends Error {
  readonly status = 503;
  constructor() {
    super("upstream tmux is down");
    this.name = "DownstreamError";
  }
}

const app = new Elysia()
  .use(errorHandlerPlugin)
  .get("/http404", () => {
    throw new HttpError(404, "nope");
  })
  .get("/http400", () => {
    throw new HttpError(400, "bad input");
  })
  .get("/unauthorized", () => {
    throw new UnauthorizedError();
  })
  .get("/forbidden", () => {
    throw new ForbiddenError();
  })
  .get("/carrier-local-code", () => {
    throw new LocalCarrierError();
  })
  .get("/teapot", () => {
    throw new TeapotError();
  })
  .get("/downstream", () => {
    throw new DownstreamError();
  })
  .post("/validated", () => "ok", {
    body: t.Object({ name: t.String({ description: "probe name" }) }),
  })
  .get("/boom", () => {
    throw new Error("boom-secret-detail");
  });

async function call(path: string, init?: RequestInit) {
  const res = await app.handle(new Request(`http://localhost${path}`, init));
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, contentType: res.headers.get("content-type") ?? "", body };
}

function jsonInit(body: unknown): RequestInit {
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

/** Shape every structured error body must satisfy, whatever produced it. */
function expectContract(body: Record<string, unknown>) {
  expect(typeof body.errId).toBe("string");
  expect(typeof body.code).toBe("string");
  expect(typeof body.message).toBe("string");
  expect(typeof body.statusCode).toBe("number");
}

describe("errorHandlerPlugin", () => {
  it("maps HttpError(404) to 404 NOT_FOUND_ERROR with the thrown message", async () => {
    const { status, contentType, body } = await call("/http404");
    expect(status).toBe(404);
    expect(contentType).toContain("application/json");
    expectContract(body);
    expect(body.code).toBe("NOT_FOUND_ERROR");
    expect(body.message).toBe("nope");
    expect(body.statusCode).toBe(404);
  });

  it("maps HttpError(400) to 400 BAD_REQUEST", async () => {
    const { status, body } = await call("/http400");
    expect(status).toBe(400);
    expect(body.code).toBe("BAD_REQUEST");
    expect(body.message).toBe("bad input");
    expect(body.statusCode).toBe(400);
  });

  it("maps UnauthorizedError to 401 INVALID_CREDENTIALS", async () => {
    const { status, body } = await call("/unauthorized");
    expect(status).toBe(401);
    expect(body.code).toBe("INVALID_CREDENTIALS");
    expect(body.message).toBe("Unauthorized");
    expect(body.statusCode).toBe(401);
  });

  it("maps ForbiddenError to 403 ACCESS_DENIED", async () => {
    const { status, body } = await call("/forbidden");
    expect(status).toBe(403);
    expect(body.code).toBe("ACCESS_DENIED");
    expect(body.message).toBe("Forbidden");
    expect(body.statusCode).toBe(403);
  });

  it("maps a 409 status-carrier to EXISTS_ERROR and ignores its private .code", async () => {
    const { status, body } = await call("/carrier-local-code");
    expect(status).toBe(409);
    // The local `PATH_EXISTS` code must not leak onto the wire — the
    // contract code is derived from the status alone.
    expect(body.code).toBe("EXISTS_ERROR");
    expect(body.message).toBe("path already exists");
    expect(body.statusCode).toBe(409);
  });

  it("keeps an unmapped carrier status and falls back to BAD_REQUEST for 4xx", async () => {
    const { status, body } = await call("/teapot");
    // The HTTP status is preserved unchanged — the ONE exception to the
    // "validation only" status change; a carrier keeps whatever it carries.
    expect(status).toBe(418);
    expect(body.code).toBe("BAD_REQUEST");
    expect(body.statusCode).toBe(418);
  });

  it("keeps a 5xx carrier status and maps its code to INTERNAL_SERVER_ERROR", async () => {
    const { status, body } = await call("/downstream");
    expect(status).toBe(503);
    expect(body.code).toBe("INTERNAL_SERVER_ERROR");
    // The message survives, as it did before the handler existed.
    expect(body.message).toBe("upstream tmux is down");
    expect(body.statusCode).toBe(503);
  });

  it("rewrites Elysia body validation (native 422) into 400 INPUT_VALIDATION_ERROR", async () => {
    const { status, body } = await call("/validated", jsonInit({}));
    expect(status).toBe(400);
    expect(body.code).toBe("INPUT_VALIDATION_ERROR");
    expect(body.statusCode).toBe(400);
    const validationError = body.validationError as { validation: unknown[]; validationContext: string };
    expect(Array.isArray(validationError.validation)).toBe(true);
    expect(validationError.validation.length).toBeGreaterThan(0);
  });

  it("turns unknown throws into 500 INTERNAL_SERVER_ERROR without leaking the message", async () => {
    const { status, body } = await call("/boom");
    expect(status).toBe(500);
    expectContract(body);
    expect(body.code).toBe("INTERNAL_SERVER_ERROR");
    // The generic message goes to the client; "boom" may still appear in the
    // dev-only `causedBy`/`stack` extras (IS_PROD is false under tests).
    expect(body.message).toBe("An internal server error occurred.");
    expect(body.message).not.toContain("boom");
  });

  it("maps Elysia's own NotFoundError (unmatched route) to 404 NOT_FOUND_ERROR", async () => {
    const { status, body } = await call("/no-such-route");
    expect(status).toBe(404);
    expect(body.code).toBe("NOT_FOUND_ERROR");
    expect(body.statusCode).toBe(404);
  });
});
