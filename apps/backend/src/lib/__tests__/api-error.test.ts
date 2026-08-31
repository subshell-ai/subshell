import { describe, expect, it, spyOn } from "bun:test";
import { BackendErrorCodes, createApiError } from "@internal/backend-errors";
import { apiErrorBody } from "@/lib/api-error.js";
import { logger } from "@/utils/logger.js";

describe("apiErrorBody", () => {
  it("returns the standard error body", () => {
    const body = apiErrorBody({ code: BackendErrorCodes.NOT_FOUND_ERROR, message: "nope" });

    expect(body.code).toBe(BackendErrorCodes.NOT_FOUND_ERROR);
    expect(body.message).toBe("nope");
    expect(body.statusCode).toBe(404);
    expect(typeof body.errId).toBe("string");
  });

  it("does not log when doNotLog is set", () => {
    // Every logging path in apiErrorBody funnels through a fresh child (the
    // `child()`-before-`withContext` guard), so spying on the shared
    // singleton's child() sees exactly the attempted emissions.
    const childSpy = spyOn(logger, "child");

    childSpy.mockClear();
    apiErrorBody({ code: BackendErrorCodes.NOT_FOUND_ERROR, message: "silent", doNotLog: true });
    expect(childSpy).not.toHaveBeenCalled();

    childSpy.mockClear();
    apiErrorBody({ code: BackendErrorCodes.NOT_FOUND_ERROR, message: "loud" });
    expect(childSpy).toHaveBeenCalledTimes(1);

    childSpy.mockRestore();
  });

  it("does not leak errId onto the shared logger", () => {
    // `withContext` mutates the LogLayer instance it is called on; using the
    // shared logger would leave the errId attached to every later line.
    apiErrorBody({ code: BackendErrorCodes.NOT_FOUND_ERROR });

    expect(logger.getContext()).not.toHaveProperty("errId");
  });

  it("dev shape carries stack, production shape (toJSONSafe) omits it", () => {
    // IS_PROD is frozen at module load (false under tests), so the branch
    // itself is checked here as the two serializations it picks between.
    const err = createApiError({
      code: BackendErrorCodes.INTERNAL_SERVER_ERROR,
      message: "boom",
      causedBy: new Error("inner detail"),
    });

    const body = apiErrorBody({ code: BackendErrorCodes.NOT_FOUND_ERROR, message: "nope" });
    expect("stack" in body).toBe(true); // dev shape
    expect("stack" in err.toJSON()).toBe(true);
    expect("stack" in err.toJSONSafe()).toBe(false);
    expect("causedBy" in err.toJSONSafe()).toBe(false);
  });
});
