import { afterEach, expect, it } from "bun:test";
import { launchWithLocalKey } from "../ssh-local-key";

const originalFetch = globalThis.fetch;
const nativeWindow = window as unknown as {
  __TAURI__?: { core: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> } };
};
const originalNative = nativeWindow.__TAURI__;
afterEach(() => {
  globalThis.fetch = originalFetch;
  nativeWindow.__TAURI__ = originalNative;
});
const prepared = { id: "request", host: "host", port: 22, user: "alice", hostKey: "public-host-key" };
const selected = { id: "native-handle", publicKey: "public-user-key", expiresAt: Date.now() + 90_000 };
const json = (value: unknown) => new Response(JSON.stringify(value));
it("routes only public replies and closes both sides after a single signature", async () => {
  const calls: string[] = [];
  const bodies: unknown[] = [];
  let exchanges = 0;
  nativeWindow.__TAURI__ = {
    core: {
      invoke: async (command) => {
        calls.push(command);
        if (command === "desktop_ssh_key_available") return true;
        if (command === "desktop_ssh_key_pick") return selected;
        if (command === "desktop_ssh_key_request") return { response: "Dg==", done: true };
        return null;
      },
    },
  };
  globalThis.fetch = (async (url, init) => {
    calls.push(String(url));
    if (init?.body) bodies.push(JSON.parse(String(init.body)));
    if (String(url).endsWith("/local-key")) return json(prepared);
    if (String(url).endsWith("/exchange"))
      return json(
        ++exchanges === 1 ? { done: false, request: { seq: 0, payload: "DQ==" } } : { done: true, request: null },
      );
    return json({ closed: true });
  }) as typeof fetch;
  let launched: string | undefined;
  const result = await launchWithLocalKey(
    { node: "n", destination: "original-alias", expectedDestination: "alice@host:22" },
    async (request) => {
      expect(request.localKeyId).toBe("request");
      expect(request.expectedDestination).toBe("alice@host:22");
      return { subshell: { id: "pane" } };
    },
    (id) => {
      launched = id;
    },
    new AbortController().signal,
  );
  expect(result?.subshell.id).toBe("pane");
  expect(launched).toBe("pane");
  expect(bodies).toContainEqual({ node: "n", destination: "original-alias", expectedDestination: "alice@host:22" });
  expect(bodies).toContainEqual({ reply: { seq: 0, payload: "Dg==" } });
  expect(JSON.stringify(bodies)).not.toContain("native-handle");
  expect(calls).toContain("desktop_ssh_key_close");
  expect(calls.at(-1)).toContain("/local-key/request");
});
it("cancelling the file picker never launches and deletes the preparation", async () => {
  const calls: string[] = [];
  nativeWindow.__TAURI__ = {
    core: { invoke: async (command) => (command === "desktop_ssh_key_available" ? true : null) },
  };
  globalThis.fetch = (async (url) => {
    calls.push(String(url));
    return json(prepared);
  }) as typeof fetch;
  const result = await launchWithLocalKey(
    { node: "n", destination: "alice@host" },
    async () => {
      throw new Error("must not launch");
    },
    () => {},
    new AbortController().signal,
  );
  expect(result).toBeNull();
  expect(calls).toHaveLength(2);
  expect(calls.at(-1)).toContain("/local-key/request");
});
it("releases the native key when launch fails", async () => {
  const calls: string[] = [];
  nativeWindow.__TAURI__ = {
    core: {
      invoke: async (command) => {
        calls.push(command);
        return command === "desktop_ssh_key_available" ? true : command === "desktop_ssh_key_pick" ? selected : null;
      },
    },
  };
  globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => json(prepared)) as typeof fetch;
  await expect(
    launchWithLocalKey(
      { node: "n", destination: "alice@host" },
      async () => {
        throw new Error("launch refused");
      },
      () => {},
      new AbortController().signal,
    ),
  ).rejects.toThrow("launch refused");
  expect(calls).toContain("desktop_ssh_key_close");
});

it("cancels native unlock while selection is pending without waiting for a handle", async () => {
  const picking = Promise.withResolvers<void>();
  const selection = Promise.withResolvers<null>();
  const closes: unknown[] = [];
  const abort = new AbortController();
  nativeWindow.__TAURI__ = {
    core: {
      invoke: async (command, args) => {
        if (command === "desktop_ssh_key_available") return true;
        if (command === "desktop_ssh_key_pick") {
          picking.resolve();
          return selection.promise;
        }
        if (command === "desktop_ssh_key_close") closes.push(args);
        return null;
      },
    },
  };
  globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => json(prepared)) as typeof fetch;
  let launches = 0;
  const result = launchWithLocalKey(
    { node: "n", destination: "alice@host" },
    async () => {
      launches++;
      return { subshell: { id: "unexpected" } };
    },
    () => {},
    abort.signal,
  );
  await picking.promise;
  abort.abort();
  expect(closes).toEqual([{}]);
  selection.resolve(null);
  await expect(result).rejects.toThrow("cancelled");
  expect(launches).toBe(0);
});

it("declining browser destination confirmation never reads the key or calls native IPC", async () => {
  const calls: string[] = [];
  nativeWindow.__TAURI__ = {
    core: {
      invoke: async () => {
        throw new Error("Unexpected native IPC");
      },
    },
  };
  globalThis.fetch = (async (url) => {
    calls.push(String(url));
    return json(prepared);
  }) as typeof fetch;
  const result = await launchWithLocalKey(
    { node: "n", destination: "alice@host" },
    async () => {
      throw new Error("Must not launch");
    },
    () => {},
    new AbortController().signal,
    {
      confirm: async (target) => {
        expect(target).toEqual(prepared);
        return false;
      },
      take: () => {
        throw new Error("Must not read the key");
      },
    },
  );
  expect(result).toBeNull();
  expect(calls).toEqual(["/api/ssh/local-key", "/api/ssh/local-key/request"]);
});

it("cancellation while browser confirmation is pending prevents reading the key", async () => {
  const asked = Promise.withResolvers<void>();
  const answer = Promise.withResolvers<boolean>();
  const abort = new AbortController();
  nativeWindow.__TAURI__ = undefined;
  globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => json(prepared)) as typeof fetch;
  const operation = launchWithLocalKey(
    { node: "n", destination: "alice@host" },
    async () => {
      throw new Error("Must not launch");
    },
    () => {},
    abort.signal,
    {
      confirm: async () => {
        asked.resolve();
        return answer.promise;
      },
      take: () => {
        throw new Error("Must not read the key");
      },
    },
  );
  await asked.promise;
  abort.abort();
  answer.resolve(true);
  await expect(operation).rejects.toThrow("cancelled");
});

for (const outcome of ["unsigned", "signed", "cleanup-failed"] as const) {
  it(`handles failed initial authentication safely when ${outcome}`, async () => {
    nativeWindow.__TAURI__ = {
      core: {
        invoke: async (command) => {
          if (command === "desktop_ssh_key_available") return true;
          if (command === "desktop_ssh_key_pick") return selected;
          if (command === "desktop_ssh_key_request") return { response: "Dg==", done: true };
          return null;
        },
      },
    };
    const deletions: string[] = [];
    let exchanges = 0;
    let discarded = false;
    globalThis.fetch = (async (url, init) => {
      const path = String(url);
      if (path === "/api/ssh/local-key") return json(prepared);
      if (path.endsWith("/exchange")) {
        if (outcome === "signed") {
          if (++exchanges === 1) return json({ done: false, request: { seq: 0, payload: "DQ==" } });
          throw new Error("Connection interrupted");
        }
        return json({ done: true, request: null });
      }
      if (path === "/api/subshells/pane" && init?.method === "DELETE") {
        deletions.push(path);
        if (outcome === "cleanup-failed") return new Response("Unavailable", { status: 503 });
      }
      return json({ ok: true });
    }) as typeof fetch;
    await expect(
      launchWithLocalKey(
        { node: "n", destination: "alice@host" },
        async () => ({ subshell: { id: "pane" } }),
        () => {},
        new AbortController().signal,
        undefined,
        () => {
          discarded = true;
        },
      ),
    ).rejects.toThrow(
      outcome === "signed"
        ? "Connection interrupted"
        : outcome === "cleanup-failed"
          ? "couldn't be removed"
          : "ended before requesting a signature",
    );
    expect(deletions).toEqual(outcome === "signed" ? [] : ["/api/subshells/pane"]);
    expect(discarded).toBe(outcome === "unsigned");
  });
}

it("keeps the pane after a signature even when a later answer fails and the next post breaks", async () => {
  // The desktop bridge answers a CLOSED signer's request with a normal
  // {done:true, response:"BQ=="} reply: the loop must not let that later
  // negative answer un-record the signature already delivered, or the catch
  // block would delete a pane that may have authenticated.
  let invoke = 0;
  nativeWindow.__TAURI__ = {
    core: {
      invoke: async (command) => {
        if (command === "desktop_ssh_key_available") return true;
        if (command === "desktop_ssh_key_pick") return selected;
        if (command === "desktop_ssh_key_request") return { response: ++invoke === 1 ? "Dg==" : "BQ==", done: true };
        return null;
      },
    },
  };
  const deletions: string[] = [];
  let exchanges = 0;
  globalThis.fetch = (async (url, init) => {
    const path = String(url);
    if (path === "/api/ssh/local-key") return json(prepared);
    if (path.endsWith("/exchange")) {
      if (++exchanges === 1) return json({ done: false, request: { seq: 0, payload: "DQ==" } });
      if (exchanges === 2) return json({ done: false, request: { seq: 1, payload: "DQ==" } });
      throw new Error("Connection interrupted");
    }
    if (path === "/api/subshells/pane" && init?.method === "DELETE") deletions.push(path);
    return json({ ok: true });
  }) as typeof fetch;
  await expect(
    launchWithLocalKey(
      { node: "n", destination: "alice@host" },
      async () => ({ subshell: { id: "pane" } }),
      () => {},
      new AbortController().signal,
      undefined,
      () => {},
    ),
  ).rejects.toThrow("Connection interrupted");
  expect(deletions).toEqual([]);
});
