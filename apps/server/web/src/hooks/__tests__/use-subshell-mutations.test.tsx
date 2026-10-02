import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { setConfirmHandler } from "@internal/node-admin";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useSubshellMutations } from "@/hooks/use-subshell-mutations";
import type { SubshellView } from "@/types/subshell";

/**
 * The invalidation-set contract of the shared lifecycle hook (operator bug
 * audit 2026-09-27): a subshell act done from the rail, a card or the table
 * must refresh EVERY surface that renders the fact it changed — including
 * the per-workspace detail, whose pane rows copy the name/status/alive the
 * dock tiles render and which has no poll of its own. `TitleDialog`'s rename
 * invalidated the workspace key all along; these actions are now held to the
 * same rule, and the bell — no pane-visible field — is pinned to the NARROW
 * refresh so a future broadening is a decision, not an accident.
 */

function row(over: Partial<SubshellView> = {}): SubshellView {
  return { id: "s1", status: "running", alive: true, activity: "idle", ...over } as SubshellView;
}

const originalFetch = globalThis.fetch;
let restoreConfirm: (() => void) | null = null;

/**
 * The key ROOT each `invalidateQueries` was called with, in order — as its
 * array-`toString` spelling ("subshells", "subshell", "workspace"), which
 * sidesteps comparing `readonly` tuples against mutable arrays while still
 * pinning the prefix the invalidation carries (a spread of a constant is the
 * same string; a wrong key is a different one).
 */
function spyInvalidations(client: QueryClient): string[] {
  const keys: string[] = [];
  spyOn(client, "invalidateQueries").mockImplementation((query) => {
    keys.push(String((query as { queryKey?: unknown[] }).queryKey ?? ""));
    return Promise.resolve();
  });
  return keys;
}

function stubFetch() {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ ok: true, id: "s1" }), {
      status: 200,
    })) as unknown as typeof fetch;
}

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidated = spyInvalidations(client);
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, invalidated, wrapper };
}

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  restoreConfirm?.();
  restoreConfirm = null;
});

describe("useSubshellMutations invalidation sets (bug audit 2026-09-27)", () => {
  it("Close re-reads the workspace detail — the dock tile that a pane CASCADE emptied must close", async () => {
    stubFetch();
    // The close confirmation resolves true: this test is about what the
    // SUCCESS does, not about the prompt.
    restoreConfirm = () => void setConfirmHandler(null);
    setConfirmHandler(() => Promise.resolve(true));
    const { invalidated, wrapper } = mount();
    let deleted = 0;
    const { result } = renderHook(() => useSubshellMutations("s1", row(), { onDeleted: () => deleted++ }), {
      wrapper,
    });

    await act(async () => {
      await result.current.remove();
    });
    // `remove()` resolves once the PROMPT was answered — the DELETE and its
    // `onSuccess` (invalidations, `onDeleted`) ride the mutation's own clock.
    await waitFor(() => expect(deleted).toBe(1));

    expect(invalidated).toEqual(expect.arrayContaining(["subshells", "subshell", "workspace"]));
  });

  it("a declined Close spawns nothing — not even an invalidation", async () => {
    stubFetch();
    restoreConfirm = () => void setConfirmHandler(null);
    setConfirmHandler(() => Promise.resolve(false));
    const { invalidated, wrapper } = mount();
    const { result } = renderHook(() => useSubshellMutations("s1", row()), { wrapper });

    await act(() => result.current.remove());

    expect(invalidated).toHaveLength(0);
  });

  it("Restart re-reads the workspace detail too — pane rows copy the status/alive the revival flips", async () => {
    stubFetch();
    // A DEAD row: the revive asks nothing (ruling 2026-10-02 splits restart
    // by liveness), so this exercises the mutation without a confirm stub.
    const { invalidated, wrapper } = mount();
    const { result } = renderHook(() => useSubshellMutations("s1", row({ alive: false }), {}), { wrapper });

    act(() => result.current.restart());
    await waitFor(() => expect(invalidated.length).toBe(3));

    expect(invalidated).toEqual(expect.arrayContaining(["subshells", "subshell", "workspace"]));
  });

  it("a restart of a LIVE row asks, and a declined prompt fires nothing", async () => {
    const requests: string[] = [];
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      requests.push(`${String(init?.method ?? "GET")} ${String(input)}`);
      return new Response(JSON.stringify({ ok: true, id: "s1" }), { status: 200 });
    }) as unknown as typeof fetch;
    restoreConfirm = () => void setConfirmHandler(null);
    setConfirmHandler(() => Promise.resolve(false));
    const { invalidated, wrapper } = mount();
    const { result } = renderHook(() => useSubshellMutations("s1", row({ alive: true }), {}), { wrapper });

    await act(async () => {
      result.current.restart();
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(requests).toHaveLength(0);
    expect(invalidated).toHaveLength(0);
  });

  it("a restart of a LIVE row goes through once the prompt is confirmed", async () => {
    stubFetch();
    restoreConfirm = () => void setConfirmHandler(null);
    setConfirmHandler(() => Promise.resolve(true));
    const { invalidated, wrapper } = mount();
    const { result } = renderHook(() => useSubshellMutations("s1", row({ alive: true }), {}), { wrapper });

    act(() => result.current.restart());
    await waitFor(() => expect(invalidated.length).toBe(3));

    expect(invalidated).toEqual(expect.arrayContaining(["subshells", "subshell", "workspace"]));
  });

  it("the bell stays narrow — no pane row carries it, so the workspace read is NOT touched", async () => {
    stubFetch();
    const { invalidated, wrapper } = mount();
    const { result } = renderHook(() => useSubshellMutations("s1", row({ notify: true })), { wrapper });

    await act(() => result.current.toggleNotify());

    expect(invalidated).toEqual(["subshells", "subshell"]);
    expect(invalidated).not.toContain("workspace");
  });
});
