import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { resetNotificationBannerForTests, useDesktopNotifications } from "@/hooks/use-desktop-notifications";
import * as live from "@/hooks/useLiveSubshells";
import type { SubshellView } from "@/types/subshell";

/**
 * The detection that needs no extra read (spec 2026-09-14 §5.1).
 *
 * Declining the macOS notifications prompt is one click and macOS never asks
 * again — after which this watcher went on firing into nothing and the app
 * silently stopped saying an agent was waiting. `desktop_notify` now reports
 * `{ shown, permission }`, so the failed act is what raises the banner.
 *
 * What these pin is the three ways it must stay quiet: a notification that WAS
 * shown, a shell too old to answer, and the second and every later denial in
 * one session (the watcher fires per idle agent, so a banner per call would
 * stack a strip for every agent on the machine).
 */

const WAITING = {
  id: "a",
  name: "agent",
  access: "owner",
  notify: true,
  status: "running",
  alive: true,
  activity: "idle",
  nodeOffline: false,
  waitingSince: new Date().toISOString(),
} as unknown as SubshellView;

/** Every invoke the hook made, so "it did try to notify" is assertable. */
const invocations: { command: string; args: Record<string, unknown> | undefined }[] = [];

/**
 * Install a fake `window.__TAURI__` answering `desktop_notify` with `answer`.
 * The bridge reads a plain global (it never imports `@tauri-apps/api`), so
 * this is the whole contract to stand in for.
 */
function fakeTauri(answer: unknown) {
  (window as unknown as Record<string, unknown>).__TAURI__ = {
    core: {
      invoke: (command: string, args?: Record<string, unknown>) => {
        invocations.push({ command, args });
        return Promise.resolve(answer);
      },
    },
  };
}

/** The live list the hook reads, swapped between renders to drive a transition. */
let current: SubshellView[] = [];

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // The account-wide switch, seeded so its own query never reaches the wire.
  client.setQueryData(["notify-master-switch"], true);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("the blocked-notifications banner", () => {
  let restore: () => void;

  beforeEach(() => {
    resetNotificationBannerForTests();
    invocations.length = 0;
    current = [];
    const spy = spyOn(live, "useLiveSubshells").mockImplementation(() => ({
      subshells: current,
      connected: true,
      isLoading: false,
      isError: false,
      refetch: async () => null,
    }));
    restore = () => spy.mockRestore();
  });

  afterEach(() => {
    cleanup();
    restore();
    delete (window as unknown as Record<string, unknown>).__TAURI__;
  });

  /**
   * Renders, then flips one subshell into "waiting". The first frame only
   * records the baseline — that is what keeps opening the app from firing one
   * notification per already-idle agent — so the transition needs two.
   */
  async function goIdle() {
    const view = renderHook(() => useDesktopNotifications(), { wrapper });
    current = [WAITING];
    view.rerender();
    await waitFor(() => expect(invocations.some((i) => i.command === "desktop_notify")).toBe(true));
    return view;
  }

  it("raises the banner when macOS refused the notification", async () => {
    fakeTauri({ shown: false, permission: "denied" });
    const { result } = await goIdle();
    await waitFor(() => expect(result.current.blocked).toBe(true));
  });

  it("stays quiet when the notification was shown", async () => {
    fakeTauri({ shown: true, permission: "authorized" });
    const { result } = await goIdle();
    expect(result.current.blocked).toBe(false);
  });

  it("stays quiet when the shell answers nothing — an old shell is not a denial", async () => {
    fakeTauri(null);
    const { result } = await goIdle();
    expect(result.current.blocked).toBe(false);
  });

  it("shows once per session: dismissing it is final, even as more agents go idle", async () => {
    fakeTauri({ shown: false, permission: "denied" });
    const { result, rerender } = await goIdle();
    await waitFor(() => expect(result.current.blocked).toBe(true));

    act(() => result.current.dismiss());
    await waitFor(() => expect(result.current.blocked).toBe(false));

    // A second agent goes idle: it still tries to notify, and still gets
    // nowhere — but the person has already been told.
    const before = invocations.length;
    current = [WAITING, { ...WAITING, id: "b" } as SubshellView];
    rerender();
    await waitFor(() => expect(invocations.length).toBeGreaterThan(before));
    expect(result.current.blocked).toBe(false);
  });
});
