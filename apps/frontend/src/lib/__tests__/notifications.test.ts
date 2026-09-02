import { afterEach, describe, expect, it } from "bun:test";

/**
 * Push glue lib tests. happy-dom provides NO Notification, NO PushManager and
 * no navigator.serviceWorker — which is exactly the "unsupported" world the
 * lib must degrade into, so that suite stubs nothing. The success/blocked/
 * unconfigured paths defineProperty the three APIs in and restore them in
 * afterEach. fetch is always stubbed (no real backend here).
 */

import { disablePush, enablePush, getPushState, type PushState, urlBase64ToUint8Array } from "@/lib/notifications";

const G = globalThis as Record<string, unknown>;

/** Stubs a global and returns its undo. */
function stubGlobal(key: string, value: unknown): () => void {
  const prev = Object.getOwnPropertyDescriptor(G, key);
  Object.defineProperty(G, key, { value, configurable: true, writable: true });
  return () => {
    if (prev) Object.defineProperty(G, key, prev);
    else delete G[key];
  };
}

const undoers: (() => void)[] = [];
afterEach(() => {
  while (undoers.length) undoers.pop()?.();
});

// Shaped like the real PushSubscription surface the lib touches.
const fakeSub = {
  endpoint: "https://push.example/sub/abc",
  toJSON: () => ({ endpoint: "https://push.example/sub/abc", keys: { p256dh: "P256DH", auth: "AUTHE" } }),
  unsubscribe: () => Promise.resolve(true),
};

type StubOptions = {
  /** Notification.permission / requestPermission() result. */
  permission?: string;
  /** What pushManager.getSubscription() resolves to. */
  subscription?: unknown;
  /** Body of GET /api/notifications/config. */
  config?: { publicKey: string; vapidConfigured: boolean };
};

/** Records fetch calls and install the browser push APIs. Returns the log. */
function installBrowser(overrides: StubOptions = {}) {
  const {
    permission = "granted",
    subscription = fakeSub,
    config = { publicKey: "BKw4_7zY", vapidConfigured: true },
  } = overrides;
  const subscribeCalls: Record<string, unknown>[] = [];
  const fetchLog: { path: string; body?: Record<string, unknown> }[] = [];
  const reg = {
    pushManager: {
      subscribe: async (opts: Record<string, unknown>) => {
        subscribeCalls.push(opts);
        return fakeSub;
      },
      getSubscription: async () => subscription,
    },
  };
  undoers.push(
    stubGlobal("PushManager", class {}),
    stubGlobal("Notification", {
      permission,
      requestPermission: async () => permission,
    }),
    stubGlobal("navigator", {
      ...navigator,
      serviceWorker: { register: async () => reg, getRegistration: async () => reg },
    }),
    stubGlobal("fetch", async (path: unknown, init?: { body?: string }) => {
      const p = String(path);
      const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
      fetchLog.push({ path: p, body });
      const payload: unknown = p.endsWith("/config") ? config : { ok: true };
      return new Response(JSON.stringify(payload), { status: 200 });
    }),
  );
  return { fetchLog, subscribeCalls };
}

describe("urlBase64ToUint8Array", () => {
  it("decodes a plain base64url string (padding added)", () => {
    // "hi" without its "=" padding, still valid base64url input.
    expect(Array.from(urlBase64ToUint8Array("aGk"))).toEqual([104, 105]);
  });

  it("maps '-' and '_' to base64 values 62 and 63", () => {
    // "z-_" → sextets 51,62,63 → bytes 0xCF 0xEF (cross-checked with Python base64).
    expect(Array.from(urlBase64ToUint8Array("z-_"))).toEqual([0xcf, 0xef]);
  });

  it("decodes a full-length VAPID key to 65 raw bytes", () => {
    // 87 base64url chars (unpadded) = 65 bytes — an uncompressed P-256 point.
    const key = `${"A".repeat(85)}-_`;
    expect(urlBase64ToUint8Array(key)).toHaveLength(65);
  });
});

describe("push state without browser push APIs (happy-dom defaults)", () => {
  it("every entry point degrades to 'unsupported' without touching the network", async () => {
    expect("serviceWorker" in navigator).toBe(false);
    expect("PushManager" in G).toBe(false);
    let fetched = 0;
    undoers.push(
      stubGlobal("fetch", async () => {
        fetched++;
        return new Response("{}", { status: 200 });
      }),
    );
    expect(await getPushState()).toBe("unsupported");
    expect(await enablePush()).toBe("unsupported");
    expect(await disablePush()).toBe("unsupported");
    expect(fetched).toBe(0);
  });
});

describe("enablePush", () => {
  it("registers, subscribes with the decoded VAPID key, POSTs the subscription, returns 'on'", async () => {
    const { fetchLog, subscribeCalls } = installBrowser();
    expect(await enablePush()).toBe("on");
    expect(subscribeCalls[0]).toEqual({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array("BKw4_7zY"),
    });
    const post = fetchLog.find((c) => c.path === "/api/notifications/subscribe");
    expect(post?.body).toEqual({ endpoint: fakeSub.endpoint, p256dh: "P256DH", auth: "AUTHE" });
  });

  it("re-binds a stale subscription: tears it down (local + server) before subscribing with the current key", async () => {
    // The real-world failure this guards: the server rotated its VAPID key,
    // but pushManager.subscribe() returns the EXISTING subscription even
    // though applicationServerKey changed — every send then 403s at the
    // gateway forever. enablePush must unsubscribe first, both locally and
    // server-side (the disablePush teardown), then subscribe fresh.
    let unsubscribed = false;
    const staleSub = {
      endpoint: "https://push.example/stale",
      toJSON: () => ({ endpoint: "https://push.example/stale", keys: { p256dh: "P", auth: "A" } }),
      unsubscribe: () => {
        unsubscribed = true;
        return Promise.resolve(true);
      },
    };
    const { fetchLog } = installBrowser({ subscription: staleSub });
    expect(await enablePush()).toBe("on");
    expect(unsubscribed).toBe(true);
    const paths = fetchLog.map((c) => c.path);
    expect(paths.indexOf("/api/notifications/unsubscribe")).toBeLessThan(paths.indexOf("/api/notifications/subscribe"));
    expect(fetchLog.find((c) => c.path === "/api/notifications/unsubscribe")?.body).toEqual({
      endpoint: "https://push.example/stale",
    });
  });

  it("returns 'blocked' when the permission prompt is refused (no subscribe POST)", async () => {
    const { fetchLog, subscribeCalls } = installBrowser({ permission: "denied" });
    expect(await enablePush()).toBe("blocked");
    expect(subscribeCalls).toHaveLength(0);
    expect(fetchLog.some((c) => c.path.endsWith("/subscribe"))).toBe(false);
  });

  it("returns 'unconfigured' before prompting when the instance has no VAPID key", async () => {
    const { fetchLog, subscribeCalls } = installBrowser({ config: { publicKey: "", vapidConfigured: false } });
    expect(await enablePush()).toBe("unconfigured");
    expect(subscribeCalls).toHaveLength(0);
    expect(fetchLog.map((c) => c.path)).toEqual(["/api/notifications/config"]);
  });
});

describe("getPushState", () => {
  const cases: [StubOptions, PushState][] = [
    [{ permission: "granted", subscription: fakeSub }, "on"],
    [{ permission: "granted", subscription: null }, "off"],
    [{ permission: "default", subscription: null }, "off"],
    [{ permission: "denied", subscription: null }, "blocked"],
    [{ config: { publicKey: "", vapidConfigured: false } }, "unconfigured"],
  ];
  for (const [options, expected] of cases) {
    it(`reports '${expected}'`, async () => {
      installBrowser(options);
      expect(await getPushState()).toBe(expected);
    });
  }
});

describe("disablePush", () => {
  it("unsubscribes locally, forgets the endpoint server-side, returns 'off'", async () => {
    let unsubbed = false;
    const sub = {
      ...fakeSub,
      unsubscribe: async () => {
        unsubbed = true;
        return true;
      },
    };
    const { fetchLog } = installBrowser({ subscription: sub });
    expect(await disablePush()).toBe("off");
    expect(unsubbed).toBe(true);
    const post = fetchLog.find((c) => c.path === "/api/notifications/unsubscribe");
    expect(post?.body).toEqual({ endpoint: fakeSub.endpoint });
  });

  it("still converges to 'off' when there is no local subscription", async () => {
    const { fetchLog } = installBrowser({ subscription: null });
    expect(await disablePush()).toBe("off");
    expect(fetchLog.some((c) => c.path.endsWith("/unsubscribe"))).toBe(false);
  });
});
