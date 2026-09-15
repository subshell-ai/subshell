import { describe, expect, it } from "bun:test";
import { SubshellClient, type TokenStore } from "@/lib/api";
import { ApiError } from "@/lib/api-error";
import { SECURE_SESSION_COOKIE, SESSION_COOKIE } from "@/lib/cookie";
import type { Node } from "@/types/node";
import type { PluginView } from "@/types/plugin";

/** In-memory TokenStore stand-in. */
function memoryStore(initial: string | null = null) {
  let token = initial;
  const store: TokenStore = {
    get: async () => token,
    set: async (t) => {
      token = t;
    },
    clear: async () => {
      token = null;
    },
  };
  return { store, peek: () => token };
}

/** A Response stand-in that can carry multiple Set-Cookie values. */
function fakeResponse(body: string, init: { status?: number; setCookies?: string[] } = {}): Response {
  const status = init.status ?? 200;
  const headers = {
    get: (name: string) => (name.toLowerCase() === "set-cookie" ? (init.setCookies?.[0] ?? null) : null),
    getSetCookie: () => init.setCookies ?? [],
  };
  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    text: async () => body,
    json: async () => JSON.parse(body),
  } as unknown as Response;
}

/** Fetch stand-in recording every call. */
function recordingFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string | URL, init?: RequestInit) => {
    const record = { url: String(url), init: init ?? {} };
    calls.push(record);
    return handler(record.url, record.init);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const BASE = "https://subshell.example";

describe("SubshellClient.signIn", () => {
  it("stores the token returned in the response body", async () => {
    const { store, peek } = memoryStore();
    const { fn } = recordingFetch(() => fakeResponse(JSON.stringify({ token: "srv-token", user: {} })));
    const client = new SubshellClient({ baseUrl: BASE, store, fetchImpl: fn });

    await client.signIn("a@b.c", "pw");

    expect(peek()).toBe("srv-token");
  });

  it("stores the SIGNED cookie token, not the body token, when both are present", async () => {
    // better-auth 1.7.x signs the session cookie ("<token>.<sig>") and accepts
    // ONLY that value as a Cookie credential; the 32-char body token 401s on
    // every guarded route (proven live by the M1 harness: body→401, Set-Cookie→200).
    const { store, peek } = memoryStore();
    const { fn } = recordingFetch(() =>
      fakeResponse(JSON.stringify({ token: "raw32", user: {} }), {
        setCookies: [`${SESSION_COOKIE}=raw32.signedsig; Path=/; HttpOnly`],
      }),
    );
    const client = new SubshellClient({ baseUrl: BASE, store, fetchImpl: fn });

    await client.signIn("a@b.c", "pw");

    expect(peek()).toBe("raw32.signedsig");
  });

  it("falls back to the body token when the response sets no cookie", async () => {
    const { store, peek } = memoryStore();
    const { fn } = recordingFetch(() =>
      fakeResponse(JSON.stringify({ token: "srv-token", user: {} }), { setCookies: [] }),
    );
    const client = new SubshellClient({ baseUrl: BASE, store, fetchImpl: fn });

    await client.signIn("a@b.c", "pw");

    expect(peek()).toBe("srv-token");
  });

  it("sends an explicit Origin on better-auth routes, because RN sends none", async () => {
    const { store } = memoryStore();
    const { fn, calls } = recordingFetch(() => fakeResponse(JSON.stringify({ token: "t" })));
    const client = new SubshellClient({ baseUrl: BASE, store, fetchImpl: fn });

    await client.signIn("a@b.c", "pw");

    const headers = calls[0].init.headers as Headers;
    expect(headers.get("origin")).toBe(BASE);
    expect(headers.get("content-type")).toBe("application/json");
  });
});

describe("SubshellClient.request", () => {
  it("presents the cookie under both spellings on guarded routes", async () => {
    const { store } = memoryStore("tok");
    const { fn, calls } = recordingFetch(() => fakeResponse("[]"));
    const client = new SubshellClient({ baseUrl: BASE, store, fetchImpl: fn });

    await client.subshells();

    const cookie = (calls[0].init.headers as Headers).get("cookie");
    expect(cookie).toContain(`${SESSION_COOKIE}=tok`);
    expect(cookie).toContain(`${SECURE_SESSION_COOKIE}=tok`);
  });

  it("captures better-auth's rotated token from Set-Cookie", async () => {
    const { store, peek } = memoryStore("old");
    const { fn } = recordingFetch(() =>
      fakeResponse("[]", { setCookies: [`${SECURE_SESSION_COOKIE}=rotated; Path=/; HttpOnly`] }),
    );
    const client = new SubshellClient({ baseUrl: BASE, store, fetchImpl: fn });

    await client.subshells();
    await Promise.resolve();

    expect(peek()).toBe("rotated");
  });

  it("ends CLEARED when a 401 response also carries a rotated cookie (write-before-clear)", async () => {
    // The rotation write used to be fire-and-forget: it could land AFTER the
    // 401 path's store.clear() and re-persist the very token the clear was
    // removing. captureRotation is awaited now, so clear() is the last write.
    const { store, peek } = memoryStore("stale");
    const { fn } = recordingFetch(() =>
      fakeResponse(JSON.stringify({ message: "unauthorized", statusCode: 401 }), {
        status: 401,
        setCookies: [`${SESSION_COOKIE}=rotated; Path=/; HttpOnly`],
      }),
    );
    const client = new SubshellClient({ baseUrl: BASE, store, fetchImpl: fn });

    await expect(client.subshells()).rejects.toBeInstanceOf(ApiError);
    await Promise.resolve();

    expect(peek()).toBeNull();
  });

  it("throws ApiError carrying the backend's structured code and errId", async () => {
    const { store } = memoryStore("tok");
    const { fn } = recordingFetch(() =>
      fakeResponse(JSON.stringify({ errId: "E1", code: "ACCESS_DENIED", message: "nope", statusCode: 403 }), {
        status: 403,
      }),
    );
    const client = new SubshellClient({ baseUrl: BASE, store, fetchImpl: fn });

    const err = await client.wsToken().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(403);
    expect((err as ApiError).code).toBe("ACCESS_DENIED");
    expect((err as ApiError).errId).toBe("E1");
  });

  it("survives a non-JSON body, e.g. a proxy error page", async () => {
    const { store } = memoryStore("tok");
    const { fn } = recordingFetch(() => fakeResponse("<html>502 Bad Gateway</html>", { status: 502 }));
    const client = new SubshellClient({ baseUrl: BASE, store, fetchImpl: fn });

    const err = (await client.subshells().catch((e) => e)) as ApiError;
    expect(err.message).toContain("502 Bad Gateway");
    expect(err.code).toBeUndefined();
  });

  it("clears the token and notifies on 401 instead of retrying silently", async () => {
    const { store, peek } = memoryStore("expired");
    let fired = 0;
    const { fn } = recordingFetch(() => fakeResponse(JSON.stringify({ message: "unauthorized" }), { status: 401 }));
    const client = new SubshellClient({
      baseUrl: BASE,
      store,
      fetchImpl: fn,
      onUnauthorized: () => {
        fired += 1;
      },
    });

    await expect(client.subshells()).rejects.toBeInstanceOf(ApiError);
    expect(peek()).toBeNull();
    expect(fired).toBe(1);
  });
});

describe("SubshellClient device enrollment", () => {
  it("enrollDevice POSTs the token and platform to /api/devices", async () => {
    const { store } = memoryStore("tok");
    const { fn, calls } = recordingFetch(() => fakeResponse(JSON.stringify({ ok: true })));
    const client = new SubshellClient({ baseUrl: BASE, store, fetchImpl: fn });

    await expect(client.enrollDevice("ExponentPushToken[X]", "ios")).resolves.toEqual({ ok: true });
    expect(calls[0]?.url).toBe(`${BASE}/api/devices`);
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.body).toBe(JSON.stringify({ token: "ExponentPushToken[X]", platform: "ios" }));
  });

  it("forgetDevice DELETEs with the token in the body", async () => {
    const { store } = memoryStore("tok");
    const { fn, calls } = recordingFetch(() => fakeResponse(JSON.stringify({ ok: true })));
    const client = new SubshellClient({ baseUrl: BASE, store, fetchImpl: fn });

    await expect(client.forgetDevice("ExponentPushToken[X]")).resolves.toEqual({ ok: true });
    expect(calls[0]?.url).toBe(`${BASE}/api/devices`);
    expect(calls[0]?.init.method).toBe("DELETE");
    expect(calls[0]?.init.body).toBe(JSON.stringify({ token: "ExponentPushToken[X]" }));
  });

  it("summary throws 404 on instances without the route (caller derives client-side)", async () => {
    const { store } = memoryStore("tok");
    const { fn } = recordingFetch(() => fakeResponse(JSON.stringify({ message: "not found" }), { status: 404 }));
    const client = new SubshellClient({ baseUrl: BASE, store, fetchImpl: fn });
    const err = (await client.summary().catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(404);
  });
});

describe("SubshellClient subshell verbs", () => {
  const cases: [string, (c: SubshellClient) => Promise<unknown>, string, string][] = [
    ["rename", (c) => c.rename("s 1", "New Name"), "PATCH", `${BASE}/api/subshells/s%201/name`],
    ["restart", (c) => c.restart("s1"), "POST", `${BASE}/api/subshells/s1/restart`],
    ["deleteSubshell", (c) => c.deleteSubshell("s1"), "DELETE", `${BASE}/api/subshells/s1`],
  ];
  for (const [name, call, method, url] of cases) {
    it(`${name} hits ${method} ${url.replace(BASE, "")}`, async () => {
      const { store } = memoryStore("tok");
      const { fn, calls } = recordingFetch(() => fakeResponse(JSON.stringify({ ok: true })));
      const client = new SubshellClient({ baseUrl: BASE, store, fetchImpl: fn });
      await call(client);
      expect(calls[0]?.url).toBe(url);
      expect(calls[0]?.init.method).toBe(method);
    });
  }
});

describe("SubshellClient new-subshell surface", () => {
  it("presets() GETs /api/presets", async () => {
    const { store } = memoryStore("tok");
    const row = {
      id: "pr1",
      userId: "u1",
      harnessId: "claude-code",
      name: "Default",
      description: null,
      restartOnExit: 0,
    };
    const { fn, calls } = recordingFetch(() => fakeResponse(JSON.stringify([row])));
    const client = new SubshellClient({ baseUrl: BASE, store, fetchImpl: fn });
    await expect(client.presets()).resolves.toEqual([row]);
    expect(calls[0]?.url).toBe(`${BASE}/api/presets`);
    expect(calls[0]?.init.method).toBeUndefined();
  });

  it("plugins() GETs /api/plugins and unwraps the { plugins } envelope", async () => {
    const { store } = memoryStore("tok");
    const row: PluginView = {
      id: "claude-code",
      name: "Claude Code",
      type: "agent-harness",
      description: "",
      installed: true,
      enabled: true,
    };
    const { fn, calls } = recordingFetch(() => fakeResponse(JSON.stringify({ plugins: [row] })));
    const client = new SubshellClient({ baseUrl: BASE, store, fetchImpl: fn });
    await expect(client.plugins()).resolves.toEqual([row]);
    expect(calls[0]?.url).toBe(`${BASE}/api/plugins`);
    expect(calls[0]?.init.method).toBeUndefined();
  });

  it("filesExplore encodes the path query", async () => {
    const { store } = memoryStore("tok");
    const { fn, calls } = recordingFetch(() =>
      fakeResponse(JSON.stringify({ path: "/a b", parent: "/", entries: [], recent: [], favorites: [] })),
    );
    const client = new SubshellClient({ baseUrl: BASE, store, fetchImpl: fn });
    const res = await client.filesExplore("/a b");
    expect(calls[0]?.url).toBe(`${BASE}/api/files/explore?path=%2Fa%20b`);
    expect(res.path).toBe("/a b");
  });

  it("createSubshell POSTs the exact harness-first body and returns the new id", async () => {
    const { store } = memoryStore("tok");
    const { fn, calls } = recordingFetch(() =>
      fakeResponse(JSON.stringify({ id: "new-1", tmuxSocket: "s", promptDelivered: true })),
    );
    const client = new SubshellClient({ baseUrl: BASE, store, fetchImpl: fn });
    const res = await client.createSubshell({ harnessId: "h1", workingDir: "/w", prompt: "hi" });
    expect(calls[0]?.url).toBe(`${BASE}/api/subshells`);
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.body).toBe(JSON.stringify({ harnessId: "h1", workingDir: "/w", prompt: "hi" }));
    expect(res.id).toBe("new-1");
  });

  it("createSubshell carries presetId when set; null/absent stays off the wire", async () => {
    const { store } = memoryStore("tok");
    const { fn, calls } = recordingFetch(() =>
      fakeResponse(JSON.stringify({ id: "new-1", tmuxSocket: "s", promptDelivered: false })),
    );
    const client = new SubshellClient({ baseUrl: BASE, store, fetchImpl: fn });

    await client.createSubshell({ harnessId: "h1", presetId: "pr1", workingDir: "/w" });
    expect(calls[0]?.init.body).toBe(JSON.stringify({ harnessId: "h1", workingDir: "/w", presetId: "pr1" }));

    // Presetless launch is ABSENCE on the wire (`presetId?: string`), never
    // null — the caller's chip state is null, the body must not say so.
    await client.createSubshell({ harnessId: "h1", presetId: null, workingDir: "/w" });
    expect(calls[1]?.init.body).toBe(JSON.stringify({ harnessId: "h1", workingDir: "/w" }));

    await client.createSubshell({ harnessId: "h1", workingDir: "/w" });
    expect(calls[2]?.init.body).toBe(JSON.stringify({ harnessId: "h1", workingDir: "/w" }));
  });

  it("createSubshell forwards nodeId when set; omitted stays omitted (local never rides)", async () => {
    const { store } = memoryStore("tok");
    const { fn, calls } = recordingFetch(() =>
      fakeResponse(JSON.stringify({ id: "new-1", tmuxSocket: "s", promptDelivered: false })),
    );
    const client = new SubshellClient({ baseUrl: BASE, store, fetchImpl: fn });

    await client.createSubshell({ harnessId: "h1", workingDir: "/w", nodeId: "n1" });
    expect(calls[0]?.init.body).toBe(JSON.stringify({ harnessId: "h1", workingDir: "/w", nodeId: "n1" }));

    // The screen maps a `local` pick to undefined before calling; whatever
    // reaches here unset must stay unset — single-machine payloads stay
    // byte-identical to pre-nodes ones.
    await client.createSubshell({ harnessId: "h1", workingDir: "/w" });
    expect(calls[1]?.init.body).toBe(JSON.stringify({ harnessId: "h1", workingDir: "/w" }));
  });
});

describe("SubshellClient.nodes", () => {
  it("GETs /api/nodes and unwraps the { nodes } envelope", async () => {
    const { store } = memoryStore("tok");
    const node: Node = {
      id: "n1",
      name: "build-box",
      kind: "agent",
      status: "online",
      access: "owner",
      canLaunch: true,
      agentVersion: "0.2.1",
      protocolVersion: 1,
    };
    const { fn, calls } = recordingFetch(() => fakeResponse(JSON.stringify({ nodes: [node] })));
    const client = new SubshellClient({ baseUrl: BASE, store, fetchImpl: fn });

    await expect(client.nodes()).resolves.toEqual([node]);
    expect(calls[0]?.url).toBe(`${BASE}/api/nodes`);
  });
});
