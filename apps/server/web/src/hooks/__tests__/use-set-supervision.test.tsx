import { afterEach, describe, expect, it } from "bun:test";
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
afterEach(() => {
  cleanup();
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
      ok = await result.current.set("app", true);
    });
    expect(ok).toBe(true);
    expect(calls).toEqual([["desktop_set_supervision", { mode: "app", autostart: true }]]);
    // Invalidated, not written: the answer is an ActionResult, and the server
    // that would produce a fresh view has just been replaced.
    expect(qc.getQueryState(SERVER_DEPLOYMENT_QUERY_KEY)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(ADMIN_STATUS_QUERY_KEY)?.isInvalidated).toBe(true);
    expect(result.current.error).toBe(null);
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
      ok = await result.current.set("app", true);
    });
    expect(ok).toBe(false);
    expect(result.current.error).toContain("no subshell-server found");
    expect(qc.getQueryState(SERVER_DEPLOYMENT_QUERY_KEY)?.isInvalidated).toBe(false);
  });

  it("surfaces a refusal that arrived as the command's Err string", async () => {
    installTauri(async () => {
      throw "unknown supervision mode 'sideways'";
    });
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useSetSupervision(), { wrapper: Wrapper });
    await act(async () => {
      await result.current.set("app", true);
    });
    await waitFor(() => expect(result.current.error).toContain("unknown supervision mode"));
  });

  it("says so, rather than failing silently, outside the desktop shell", async () => {
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useSetSupervision(), { wrapper: Wrapper });
    await act(async () => {
      await result.current.set("app", true);
    });
    expect(result.current.error).toContain("not running inside Subshell Server");
  });
});
