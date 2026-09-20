import { describe, expect, it } from "bun:test";
import { ApiError } from "@internal/node-admin";
import { isNotFoundSubshellError } from "@/lib/subshell-not-found";

describe("isNotFoundSubshellError", () => {
  it("is true only for a 404 — the backend's single answer for gone AND unshared", () => {
    expect(isNotFoundSubshellError(new ApiError(404, "Not Found"))).toBe(true);
  });

  it("is false for every other failure (transient errors must stay on the reconnect path)", () => {
    expect(isNotFoundSubshellError(new ApiError(403, "no"))).toBe(false);
    expect(isNotFoundSubshellError(new ApiError(500, "boom"))).toBe(false);
    expect(isNotFoundSubshellError(new TypeError("fetch failed"))).toBe(false);
    expect(isNotFoundSubshellError(undefined)).toBe(false);
  });
});
