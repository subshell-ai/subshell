import { expect, test } from "bun:test";

test("authClient signUp against mocked fetch", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    console.log("FETCH", init?.method ?? "GET", String(input).slice(0, 80));
    return Promise.resolve(new Response(JSON.stringify({ user: { id: "u1", name: "Ada" } }), { status: 200 }));
  }) as typeof fetch;
  try {
    const { authClient } = await import("@/lib/auth-client");
    const r = await authClient.signUp.email({ name: "Ada", email: "a@b.c", password: "x".repeat(10) });
    console.log("RESULT", JSON.stringify(r).slice(0, 200));
    expect(r.error).toBeFalsy();
  } finally {
    globalThis.fetch = original;
  }
});
