import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { ADMIN_STATUS_QUERY_KEY } from "@/hooks/use-admin-status";
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
beforeEach(() => {
  audited.length = 0;
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith("/api/admin/server/supervision")) {
      audited.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ recorded: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
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
  it("invokes the desktop command with the mode and login answer, then invalidates both admin queries", async () => {
    const calls: unknown[] = [];
    installTauri(async (command, args) => {
      calls.push([command, args]);
      return { ok: true, stdout: "subshell-server is running with this app.\n", stderr: "" };
    });
    const { Wrapper, qc } = makeWrapper();
    qc.setQueryData(SERVER_DEPLOYMENT_QUERY_KEY, { stale: true });
    qc.setQueryData(ADMIN_STATUS_QUERY_KEY, { stale: true });
    const { result } = renderHook(() => useSetSupervision(), { wrapper: Wrapper });

    let ok = false;
    await act(async () => {
      ok = await result.current.set("app", true, false);
    });
    expect(ok).toBe(true);
    expect(calls).toEqual([["desktop_set_supervision", { mode: "app", autostart: true, force: false }]]);
    // Invalidated, not written: the answer is an ActionResult, and the server
    // that would produce a fresh view has just been replaced.
    expect(qc.getQueryState(SERVER_DEPLOYMENT_QUERY_KEY)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(ADMIN_STATUS_QUERY_KEY)?.isInvalidated).toBe(true);
    expect(result.current.error).toBe(null);
    // The instance's trail records the act. It cannot be the desktop app's
    // job — that side holds no session — and `server.autostart.update` was
    // already auditing the SMALLER change while this one wrote nothing.
    expect(audited).toEqual([{ mode: "app", autostart: true, force: false }]);
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
