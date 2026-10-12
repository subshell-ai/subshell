import { afterEach, describe, expect, it } from "bun:test";
import { ApiError, apiFetch } from "../lib/api";

/**
 * apiFetch must surface the backend's structured error body
 * (`{errId, code, message, statusCode}`) as a clean message — not the raw
 * JSON — while legacy plain-text bodies keep working verbatim.
 */
describe("apiFetch error body parsing", () => {
  const savedFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = savedFetch;
  });

  it("extracts message/code/errId from the structured error body", async () => {
    globalThis.fetch = (async () =>
      Response.json(
        { errId: "V1stk9xQ2mLp", code: "NOT_FOUND_ERROR", message: "Subshell not found", statusCode: 404 },
        { status: 404 },
      )) as never;

    const err = await apiFetch<never>("/api/subshells/ghost").catch((e) => e as ApiError);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(404);
    // The historical "API <status>: <detail>" copy survives, with the JSON's
    // message as <detail> — never the raw body.
    expect(err.message).toBe("API 404: Subshell not found");
    expect(err.code).toBe("NOT_FOUND_ERROR");
    expect(err.errId).toBe("V1stk9xQ2mLp");
  });

  it("keeps a legacy plain-text body verbatim", async () => {
    globalThis.fetch = (async () => new Response("recipient is not a member: x", { status: 400 })) as never;

    const err = await apiFetch<never>("/api/channels/c/posts", { method: "POST" }).catch((e) => e as ApiError);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toBe("API 400: recipient is not a member: x");
    expect(err.code).toBeUndefined();
    expect(err.errId).toBeUndefined();
  });

  for (const status of [404, 502, 503, 200]) {
    it(`replaces an HTML response with a readable message (HTTP ${status})`, async () => {
      globalThis.fetch = (async () =>
        new Response("<!DOCTYPE html><html><body>Proxy unavailable</body></html>", {
          status,
          headers: { "content-type": "text/html" },
        })) as never;
      const err = await apiFetch<never>("/api/nodes/n1/update", { method: "POST" }).catch((e) => e as ApiError);
      expect(err).toBeInstanceOf(ApiError);
      expect(err.status).toBe(status);
      expect(err.message).toContain("If it's restarting or updating, wait for it to come back.");
      expect(err.message).not.toContain("<html>");
    });
  }

  it("recognizes an HTML error even without its content type", async () => {
    globalThis.fetch = (async () => new Response("  <h1>Bad gateway</h1>", { status: 502 })) as never;
    const err = await apiFetch<never>("/api/x").catch((e) => e as ApiError);
    expect(err.message).not.toContain("<h1>");
    expect(err.status).toBe(502);
  });

  it("handles a 500-shaped structured body with the generic message", async () => {
    globalThis.fetch = (async () =>
      Response.json(
        {
          errId: "e1",
          code: "INTERNAL_SERVER_ERROR",
          message: "The server couldn't complete the request.",
          statusCode: 500,
        },
        { status: 500 },
      )) as never;

    const err = await apiFetch<never>("/api/subshells").catch((e) => e as ApiError);
    expect(err.message).toBe("API 500: The server couldn't complete the request.");
    expect(err.code).toBe("INTERNAL_SERVER_ERROR");
  });

  it("non-object JSON and JSON with no string message fall back to the raw text", async () => {
    globalThis.fetch = (async () => new Response('"just a string"', { status: 400 })) as never;
    const err1 = await apiFetch<never>("/api/x").catch((e) => e as ApiError);
    expect(err1.message).toBe('API 400: "just a string"');

    globalThis.fetch = (async () => Response.json({ detail: "no message field" }, { status: 422 })) as never;
    const err2 = await apiFetch<never>("/api/x").catch((e) => e as ApiError);
    expect(err2.message).toBe('API 422: {"detail":"no message field"}');
  });
});
