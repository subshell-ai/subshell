import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { deploymentView } from "@/components/__tests__/helpers/deployment-view";
import { ServerLogCard } from "@/components/service/server-log-card";
import type { ServerDeployment } from "@/types/server-deployment";

const restore: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const undo of restore.splice(0)) undo();
});

/** Serves one log body for `GET /api/admin/server/logs`. */
function stubLogs(body: unknown) {
  const original = globalThis.fetch;
  restore.push(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = (async (_input: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof globalThis.fetch;
}

/** Serves empty tails and counts how many times the log route was asked. */
function stubCountedLogs(): () => number {
  const original = globalThis.fetch;
  let calls = 0;
  restore.push(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = (async (input: unknown) => {
    if (String(input).includes("/api/admin/server/logs")) calls += 1;
    return new Response(JSON.stringify({ lines: [], file: "/c/logs/server.log", bytes: 0, capBytes: 204_800 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return () => calls;
}

function renderCard(view: ServerDeployment) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      {/* 20ms, not the production second — see NodeLogCard's test: the
          assertion is that the tail polls, and a real-second wait is what
          made these flake under parallel load. */}
      <ServerLogCard view={view} enabled pollMs={20} />
    </QueryClientProvider>,
  );
}

describe("ServerLogCard", () => {
  it("renders each line with its level's colour", async () => {
    stubLogs({
      lines: [
        { ts: "2026-09-12T10:00:00.000Z", level: "info", message: "listening" },
        { ts: "2026-09-12T10:00:01.000Z", level: "error", message: "boom", data: { code: 7 } },
      ],
      file: "/c/logs/server.log",
      bytes: 120,
      capBytes: 204_800,
    });
    renderCard(deploymentView());
    const errorLine = await waitFor(() => screen.getByText(/boom/));
    expect(errorLine.className).toContain("text-destructive");
    // Structured context rides the same line rather than a second row.
    expect(errorLine.textContent).toContain('{"code":7}');
    expect(screen.getByText(/listening/).className).toBe("");
  });

  it("replaces the switch with a sentence while the environment forces debug logging", async () => {
    stubLogs({ lines: [], file: "/c/logs/server.log", bytes: 0, capBytes: 204_800 });
    const view = deploymentView();
    view.logging = { debug: true, source: "process env", file: "/c/logs/server.log", capBytes: 204_800 };
    renderCard(view);
    await waitFor(() => expect(screen.getByText(/Set by the environment \(SUBSHELL_DEBUG_LOGGING\)/)).toBeTruthy());
    expect(screen.queryByLabelText("Debug logging")).toBeNull();
  });

  /**
   * The log follows on its own, and Pause is what makes it hold still.
   *
   * Both halves are asserted against the REQUESTS rather than the label,
   * because the label is the easy half: a toggle wired to nothing but its own
   * `useState` would render "paused" perfectly while the tail kept moving
   * under the reader, which is the whole failure this control exists to
   * prevent.
   */
  it("follows on its own, and pausing stops the asking", async () => {
    const calls = stubCountedLogs();
    renderCard(deploymentView());

    // It polls: a second ask arrives with nobody pressing anything.
    await waitFor(() => expect(calls()).toBeGreaterThan(1), { timeout: 2_000 });

    const pause = screen.getByRole("button", { name: /Pause/ });
    // The NAME carries the state, and `aria-pressed` is deliberately absent:
    // the two together announced "Resume, toggle button, pressed" while
    // paused — which reads as the opposite of the truth. One name, one state.
    expect(pause.getAttribute("aria-pressed")).toBe(null);
    expect(screen.getByText(/following/)).toBeTruthy();
    fireEvent.click(pause);

    await waitFor(() => expect(screen.getByRole("button", { name: /Resume/ })).toBeTruthy());
    expect(screen.getByRole("button", { name: /Resume/ }).getAttribute("aria-pressed")).toBe(null);
    expect(screen.getByText(/paused/)).toBeTruthy();

    // Resume brings the polling BACK — the half the old test never proved.
    // A control that stops a poll and cannot restart it is a worse bug than
    // one that never stopped it.
    const whilePaused = calls();
    fireEvent.click(screen.getByRole("button", { name: /Resume/ }));
    await waitFor(() => expect(calls()).toBeGreaterThan(whilePaused), { timeout: 2_000 });
    fireEvent.click(screen.getByRole("button", { name: /Pause/ }));
    await waitFor(() => expect(screen.getByText(/paused/)).toBeTruthy());

    // Frozen: more than two intervals' worth of grace, and not one more ask.
    const atPause = calls();
    await new Promise((settle) => setTimeout(settle, 2_500));
    expect(calls()).toBe(atPause);
  }, 12_000);
});
