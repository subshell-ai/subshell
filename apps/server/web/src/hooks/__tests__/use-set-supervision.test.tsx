import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { deploymentView } from "@/components/__tests__/helpers/deployment-view";
import { useSetSupervision } from "@/hooks/use-set-supervision";
import { SERVER_DEPLOYMENT_QUERY_KEY } from "@/lib/query-keys";

/**
 * The desktop bridge is `window.__TAURI__`; a test installs a fake one and
 * removes it after, so a later file does not find itself "inside the app".
 */
type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
function installTauri(invoke: Invoke): void {
  (globalThis.window as unknown as Record<string, unknown>).__TAURI__ = { core: { invoke } };
}
/**
 * The audit POST the hook makes before invoking. Stubbed for every test here
 * — without it each one reaches for a real socket and the suite prints a wall
 * of ECONNREFUSED while still passing, which is how a genuine network call
 * added later would go unnoticed.
 */
const audited: unknown[] = [];
let realFetch: typeof globalThis.fetch;
/** What `GET /api/admin/server` answers the settle wait; set per test. */
let machine: () => unknown = () => {
  throw new Error("server down");
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

/** A deployment view reporting the machine in `mode`. */
function viewIn(mode: "service" | "app") {
  const view = deploymentView();
  if (mode === "app") {
    view.service.manager = "app";
  } else {
    view.service.manager = "launchd";
    view.service.installed = true;
  }
  return view;
}

beforeEach(() => {
  audited.length = 0;
  machine = () => {
    throw new Error("server down");
  };
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith("/api/admin/server/supervision")) {
      audited.push(JSON.parse(String(init?.body)));
      return json({ recorded: true });
    }
    if (url.endsWith("/api/admin/server")) return json(machine());
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  delete (globalThis.window as unknown as Record<string, unknown>).__TAURI__;
});

function makeWrapper(): { Wrapper: (p: { children: ReactNode }) => ReactElement; qc: QueryClient } {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    qc,
    Wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    ),
  };
}

describe("useSetSupervision", () => {
  it("invokes the desktop command, then WAITS for the machine to report the new mode", async () => {
    const calls: unknown[] = [];
    installTauri(async (command, args) => {
      calls.push([command, args]);
      return { ok: true, stdout: "subshell-server is running with this app.\n", stderr: "" };
    });
    const { Wrapper, qc } = makeWrapper();
    qc.setQueryData(SERVER_DEPLOYMENT_QUERY_KEY, { stale: true });
    const { result } = renderHook(() => useSetSupervision(), { wrapper: Wrapper });

    let ok = false;
    await act(async () => {
      ok = await result.current.set("app", true, false);
    });
    expect(ok).toBe(true);
    expect(calls).toEqual([["desktop_set_supervision", { mode: "app", autostart: true, force: false }]]);
    expect(result.current.error).toBe(null);
    // The instance's trail records the act. It cannot be the desktop app's
    // job — that side holds no session — and `server.autostart.update` was
    // already auditing the SMALLER change while this one wrote nothing.
    expect(audited).toEqual([{ mode: "app", autostart: true, force: false }]);

    // The command has returned and the server has NOT come back. This is the
    // window that used to be silent: the dialog closed, the card still showed
    // the old mode, and nothing said the page was waiting on anything.
    expect(result.current.pending).toBe(false);
    expect(result.current.settling).toBe("app");

    // The server answers, in the new mode.
    machine = () => viewIn("app");
    await waitFor(() => expect(result.current.settling).toBe(null), { timeout: 5_000 });
    // Written rather than invalidated: this response IS the fresh view, and
    // invalidating alone would leave the card on the old mode for one more
    // round trip — the exact gap the wait exists to close.
    expect(qc.getQueryData(SERVER_DEPLOYMENT_QUERY_KEY)).toMatchObject({ service: { manager: "app" } });
  }, 10_000);

  it("does not settle on a view that still reports the OLD mode", async () => {
    installTauri(async () => ({ ok: true, stdout: "", stderr: "" }));
    // The old server answering one last time, or a memoized view from just
    // before the switch — neither is the machine having moved.
    machine = () => viewIn("service");
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useSetSupervision(), { wrapper: Wrapper });
    await act(async () => {
      await result.current.set("app", true, false);
    });
    expect(result.current.settling).toBe("app");
    await new Promise((settle) => setTimeout(settle, 1_500));
    expect(result.current.settling).toBe("app");
  }, 10_000);

  it("needs no wait when the machine was already where it was asked to go", async () => {
    installTauri(async () => ({ ok: true, stdout: "Nothing to change.\n", stderr: "", mode: "app", noop: true }));
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useSetSupervision(), { wrapper: Wrapper });
    let ok = false;
    await act(async () => {
      ok = await result.current.set("app", true, false);
    });
    // Nothing ran, so nothing is coming back — a spinner here would be a lie.
    expect(ok).toBe(true);
    expect(result.current.settling).toBe(null);
  });

  it("switches anyway when the audit row cannot be written", async () => {
    installTauri(async () => ({ ok: true, stdout: "", stderr: "" }));
    globalThis.fetch = (async () => {
      throw new Error("NetworkError");
    }) as unknown as typeof globalThis.fetch;
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useSetSupervision(), { wrapper: Wrapper });
    let ok = false;
    await act(async () => {
      ok = await result.current.set("app", true, false);
    });
    // A missing audit row is not a reason to refuse the act — and this is
    // exactly the moment the server is least likely to answer.
    expect(ok).toBe(true);
  });

  it("reports a no-op the page did not expect, rather than closing on silence", async () => {
    installTauri(async () => ({
      ok: true,
      stdout: "Nothing to change.\n",
      stderr: "",
      mode: "app",
      noop: true,
    }));
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useSetSupervision(), { wrapper: Wrapper });
    let ok = true;
    await act(async () => {
      // The page thought this machine was in service mode. Rust, reading its
      // settings file corrected by a definition probe, says it is already in
      // app mode — so the request landed on a same-mode branch and nothing
      // ran. Folding that into success closed the dialog on a radio that
      // never moved, and the person's whole report was silence.
      ok = await result.current.set("service", true, false);
    });
    expect(ok).toBe(false);
    expect(result.current.error).toContain("already running the server with the app");
  });

  it("surfaces a half-run's last line, and does not invalidate", async () => {
    installTauri(async () => ({
      ok: false,
      stdout: "Removed the launchd agent.\n",
      stderr: "subshell-server: could not start: no subshell-server found\n",
    }));
    const { Wrapper, qc } = makeWrapper();
    qc.setQueryData(SERVER_DEPLOYMENT_QUERY_KEY, { stale: true });
    const { result } = renderHook(() => useSetSupervision(), { wrapper: Wrapper });
    let ok = true;
    await act(async () => {
      ok = await result.current.set("app", true, false);
    });
    expect(ok).toBe(false);
    expect(result.current.error).toContain("no subshell-server found");
    expect(qc.getQueryState(SERVER_DEPLOYMENT_QUERY_KEY)?.isInvalidated).toBe(false);
  });

  it("passes force through, so a deliberate override reaches the command", async () => {
    const calls: unknown[] = [];
    installTauri(async (_c, args) => {
      calls.push(args);
      return { ok: true, stdout: "", stderr: "" };
    });
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useSetSupervision(), { wrapper: Wrapper });
    await act(async () => {
      await result.current.set("app", true, true);
    });
    // `force` is the person's answer to the pane-safety refusal; dropping it
    // here would make that consent unreachable and the refusal permanent.
    expect(calls).toEqual([{ mode: "app", autostart: true, force: true }]);
  });

  it("surfaces a refusal that arrived as the command's Err string", async () => {
    installTauri(async () => {
      throw "unknown supervision mode 'sideways'";
    });
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useSetSupervision(), { wrapper: Wrapper });
    await act(async () => {
      await result.current.set("app", true, false);
    });
    await waitFor(() => expect(result.current.error).toContain("unknown supervision mode"));
  });

  it("says so, rather than failing silently, outside the desktop shell", async () => {
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useSetSupervision(), { wrapper: Wrapper });
    await act(async () => {
      await result.current.set("app", true, false);
    });
    expect(result.current.error).toContain("not running inside Subshell Server");
  });
});
