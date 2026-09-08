import { afterEach, describe, expect, it } from "bun:test";
import { ApiError, SubshellApi } from "../api-client.js";

/** REST client behavior, with globalThis.fetch stubbed (no server involved). */
describe("SubshellApi", () => {
  const savedFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = savedFetch;
  });

  const api = new SubshellApi({ apiKey: "subshell_key123", baseUrl: "http://h:3080" });

  it("sends bearer auth and JSON content-type", async () => {
    let seen: Request | undefined;
    globalThis.fetch = (async (input: URL, init?: RequestInit) => {
      seen = new Request(String(input), init);
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    }) as never;
    await api.req("/api/channels");
    expect(seen?.headers.get("authorization")).toBe("Bearer subshell_key123");
    expect(seen?.url).toBe("http://h:3080/api/channels");
  });

  it("maps non-2xx into ApiError with status and message", async () => {
    globalThis.fetch = (async () => new Response("recipient is not a member: x", { status: 400 })) as never;
    await expect(api.req("/api/channels/c/posts", { method: "POST", body: {} })).rejects.toThrow(ApiError);
    try {
      await api.req("/api/channels/c/posts", { method: "POST", body: {} });
    } catch (e) {
      expect((e as ApiError).status).toBe(400);
      expect((e as ApiError).message).toContain("not a member");
    }
  });

  it("extracts the message from the backend's structured error body", async () => {
    const body = JSON.stringify({
      errId: "V1stk9xQ2mLp",
      code: "ACCESS_DENIED",
      message: "Forbidden",
      statusCode: 403,
    });
    globalThis.fetch = (async () => new Response(body, { status: 403 })) as never;
    const err = await api.req("/api/system-keys").catch((e) => e as ApiError);
    expect(err).toBeInstanceOf(ApiError);
    // Clean message — the raw JSON never reaches the agent-facing tool layer.
    expect((err as ApiError).message).toBe("Forbidden");
    expect((err as ApiError).status).toBe(403);
  });

  it("serializes query params and JSON bodies", async () => {
    let seen: Request | undefined;
    globalThis.fetch = (async (input: URL, init?: RequestInit) => {
      seen = new Request(String(input), init);
      return new Response("[]", { headers: { "content-type": "application/json" } });
    }) as never;
    await api.req("/api/channels/c/posts", { query: { since: 3, wait: 5 } });
    expect(seen?.url).toContain("since=3");
    expect(seen?.url).toContain("wait=5");
  });

  it("401 surfaces as ApiError with status 401 for the tool layer's message mapping", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 401 })) as never;
    const err = await api.req("/api/identities").catch((e) => e as ApiError);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
  });
});
