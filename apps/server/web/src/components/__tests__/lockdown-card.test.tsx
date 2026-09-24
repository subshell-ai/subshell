import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { LockdownCard } from "@/components/settings/lockdown-card";

/**
 * The Lockdown card (operator ask 2026-09-24). What it exists to prove:
 * NEITHER direction is a bare click — both open the typed ask, the confirm
 * button answers only to the exact machine name, the PATCH carries what was
 * typed, and the server's refusal (reached only by a rename mid-dialog)
 * keeps the ask open.
 *
 * Props-only mount: the card owns its PATCH and the settings invalidation,
 * so the test mocks the fetch it makes rather than the whole page.
 */

interface Call {
  method: string;
  body?: string;
  status: number;
}

function mockPatch(handler: (body: Record<string, unknown>) => { status: number; json: unknown }) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((_input: unknown, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    if (method === "GET") {
      // The settings read an invalidation provokes — answer it neutrally so
      // the observer settles; the assertion is that it HAPPENED.
      calls.push({ method, status: 200 });
      return Promise.resolve(new Response(JSON.stringify({ lockdown: false, localNodeName: "Testbox" })));
    }
    const res = handler(body);
    calls.push({ method, body: init?.body as string, status: res.status });
    return Promise.resolve(new Response(JSON.stringify(res.json), { status: res.status }));
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

const ok = (over: Record<string, unknown> = {}) => ({
  status: 200,
  json: { lockdown: true, stopped: [], ...over },
});

function renderCard(over: Partial<ComponentProps<typeof LockdownCard>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <LockdownCard lockdown={false} machineName="Testbox" {...over} />
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe("the Lockdown card", () => {
  it("the OFF button opens the dialog and does NOT PATCH — the ask comes first", async () => {
    const m = mockPatch(() => ok());
    try {
      renderCard();
      fireEvent.click(screen.getByRole("button", { name: "Lock down instance" }));
      // The ask, not the act: a name field appeared, nothing was written.
      expect(await screen.findByLabelText(/machine name/i)).toBeTruthy();
      expect(m.calls.length).toBe(0);
    } finally {
      m.restore();
    }
  });

  it("the confirm button waits for the RIGHT name, then PATCHes ON with it", async () => {
    const m = mockPatch(() => ok({ stopped: ["a", "b"] }));
    try {
      renderCard();
      fireEvent.click(screen.getByRole("button", { name: "Lock down instance" }));
      const confirm = screen.getByRole("button", { name: "Lock down" });
      expect(confirm.hasAttribute("disabled")).toBe(true);
      // Operator ruling 2026-09-24: a wrong name is not a submitable one. The
      // ask is to TYPE the machine name, and typing something else has not
      // done that.
      fireEvent.change(screen.getByLabelText(/machine name/i), { target: { value: "wrong" } });
      expect(screen.getByRole("button", { name: "Lock down" }).hasAttribute("disabled")).toBe(true);
      fireEvent.change(screen.getByLabelText(/machine name/i), { target: { value: "Testbox" } });
      expect(screen.getByRole("button", { name: "Lock down" }).hasAttribute("disabled")).toBe(false);
      fireEvent.click(screen.getByRole("button", { name: "Lock down" }));
      await waitFor(() => expect(m.calls.length).toBe(1));
      const sent = JSON.parse(m.calls[0]?.body ?? "{}") as Record<string, unknown>;
      expect(sent.lockdown).toBe(true);
      expect(sent.lockdownConfirm).toBe("Testbox");
      // The stopped-count line is gone (operator call 2026-09-24): the banner
      // and the empty list ARE the report; the ids stay in the audit.
      expect(screen.queryByText(/stopped \d+ subshell/i)).toBeNull();
    } finally {
      m.restore();
    }
  });

  it("a server refusal keeps the dialog open and says why", async () => {
    // The button now gates on equality, so a 400 reaching the dialog means
    // the name CHANGED between opening and submitting — the server re-checks
    // live precisely for that race, and the refusal belongs beside the
    // button that can fix it.
    const m = mockPatch(() => ({
      status: 400,
      json: { message: 'Type the machine name "Renamed" to confirm the lockdown.' },
    }));
    try {
      renderCard();
      fireEvent.click(screen.getByRole("button", { name: "Lock down instance" }));
      fireEvent.change(screen.getByLabelText(/machine name/i), { target: { value: "Testbox" } });
      fireEvent.click(screen.getByRole("button", { name: "Lock down" }));
      expect(await screen.findByText(/to confirm the lockdown/i)).toBeTruthy();
      expect(screen.getByLabelText(/machine name/i)).toBeTruthy(); // still open
    } finally {
      m.restore();
    }
  });

  it("the ON state ends through the SAME typed ask (operator ruling 2026-09-24)", async () => {
    const m = mockPatch(() => ({ status: 200, json: { lockdown: false, stopped: [] } }));
    try {
      renderCard({ lockdown: true, machineName: "Testbox" });
      // No switch anywhere; the only trigger is the way out — and it opens a
      // dialog rather than PATCHing, exactly like the way in.
      expect(screen.queryByRole("switch")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "End lockdown" }));
      expect(await screen.findByLabelText(/machine name/i)).toBeTruthy();
      expect(m.calls.length).toBe(0);

      const dialog = screen.getByRole("dialog");
      const confirm = within(dialog).getByRole("button", { name: "End lockdown" });
      expect(confirm.hasAttribute("disabled")).toBe(true);
      fireEvent.change(screen.getByLabelText(/machine name/i), { target: { value: "wrong" } });
      expect(within(dialog).getByRole("button", { name: "End lockdown" }).hasAttribute("disabled")).toBe(true);
      fireEvent.change(screen.getByLabelText(/machine name/i), { target: { value: "Testbox" } });
      fireEvent.click(within(dialog).getByRole("button", { name: "End lockdown" }));
      await waitFor(() => expect(m.calls.length).toBe(1));
      expect(JSON.parse(m.calls[0]?.body ?? "{}")).toEqual({ lockdown: false, lockdownConfirm: "Testbox" });
    } finally {
      m.restore();
    }
  });

  // ── Review round 2026-09-24 (SPA) ──────────────────────────────────────

  it("a refusal refetches the settings read, so a rename cannot deadlock the dialog", async () => {
    // The deadlock (finding I-1): the dialog gates on the machineName PROP.
    // A rename while it is open makes the server 400 with the NEW name while
    // the button still demands the OLD one — typing what the error says gets
    // a dark button, and re-typing loops the 400 forever, because the app
    // never refetches on focus. The catch invalidates now; the observer
    // below stands in for the page's own ["settings"] query.
    const m = mockPatch(() => ({
      status: 400,
      json: { message: 'Type the machine name "Renamed" to confirm.' },
    }));
    try {
      renderWithObserver();
      // The observer's own mount read is not the proof — count GETs, and the
      // assertion is that the REFUSAL provoked another one.
      await waitFor(() => expect(m.calls.filter((c) => c.method === "GET").length).toBe(1));
      fireEvent.click(screen.getByRole("button", { name: "Lock down instance" }));
      fireEvent.change(screen.getByLabelText(/machine name/i), { target: { value: "Testbox" } });
      fireEvent.click(screen.getByRole("button", { name: "Lock down" }));
      await waitFor(() => expect(m.calls.filter((c) => c.method === "GET").length).toBeGreaterThanOrEqual(2));
      // Let the refetched observer settle inside act — the invalidation lands
      // its result one microtask after the waitFor clears, and an un-settled
      // update at cleanup is exactly the "not wrapped in act" noise that
      // hides the NEXT real warning.
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    } finally {
      m.restore();
    }
  });

  it("a success settles BOTH reads the flag drives", async () => {
    const m = mockPatch(() => ok());
    try {
      renderWithObserver();
      await waitFor(() => expect(m.calls.filter((c) => c.method === "GET").length).toBe(1));
      fireEvent.click(screen.getByRole("button", { name: "Lock down instance" }));
      fireEvent.change(screen.getByLabelText(/machine name/i), { target: { value: "Testbox" } });
      fireEvent.click(screen.getByRole("button", { name: "Lock down" }));
      // The card's claim is "invalidates both reads"; the observer proves the
      // admin one refetched, and the PATCH response settling proves it ran.
      await waitFor(() => expect(m.calls.filter((c) => c.method === "GET").length).toBeGreaterThanOrEqual(2));
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    } finally {
      m.restore();
    }
  });

  it("surfaces the rows that could NOT be stopped", async () => {
    // Finding I-2: the stopped-count echo is gone by operator ruling, but
    // `failed` is not a count — it is the difference between a full stop and
    // a quiet escape. The maintenance precedent in AGENTS: dropping it tells
    // someone a machine is quiet while panes are still alive on it.
    const m = mockPatch(() => ok({ stopped: [], failed: ["escaped-pane"] }));
    try {
      renderCard();
      fireEvent.click(screen.getByRole("button", { name: "Lock down instance" }));
      fireEvent.change(screen.getByLabelText(/machine name/i), { target: { value: "Testbox" } });
      fireEvent.click(screen.getByRole("button", { name: "Lock down" }));
      expect(await screen.findByText(/could not be stopped/i)).toBeTruthy();
    } finally {
      m.restore();
    }
  });

  it("Enter obeys the same gate as the button, and a double-click PATCHes once", async () => {
    let release: (() => void) | null = null;
    const original = globalThis.fetch;
    globalThis.fetch = ((_input: unknown, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") return Promise.resolve(new Response("{}"));
      return new Promise((resolve) => {
        release = () => resolve(new Response(JSON.stringify({ lockdown: true, stopped: [] })));
      });
    }) as typeof fetch;
    try {
      renderCard();
      fireEvent.click(screen.getByRole("button", { name: "Lock down instance" }));
      const input = screen.getByLabelText(/machine name/i);
      // Enter with the wrong name: the gate, or Enter would be a way around it.
      fireEvent.change(input, { target: { value: "nope" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(release).toBeNull());
      // Enter with the right name submits.
      fireEvent.change(input, { target: { value: "Testbox" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(release).not.toBeNull());
      // Pending now: the button went dark (its label became the progress
      // name), so a second Enter or click cannot send a second PATCH.
      // The read needs an ASSERTION, not just an annotated type: TS narrows
      // `release` to `null` at this point because the real assignment happens
      // in a promise executor it cannot see through, and that narrowing
      // travels through const aliases regardless of annotation.
      const first = release as (() => void) | null;
      release = null;
      fireEvent.keyDown(input, { key: "Enter" });
      fireEvent.click(screen.getByRole("button", { name: /Locking down/ }));
      expect(release).toBeNull();
      // Settle the in-flight PATCH INSIDE act — resolving it bare lets the
      // card's success continuation land after the test's last assertion,
      // which is the "not wrapped in act" noise that masks the next real one.
      await act(async () => {
        first?.();
        await new Promise((r) => setTimeout(r, 0));
      });
    } finally {
      const pending = release as (() => void) | null;
      pending?.();
      globalThis.fetch = original;
    }
  });
});

/** Card + an observer for the page's ["settings"] query, one cache shared. */
function renderWithObserver() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Observer() {
    useQuery({
      queryKey: ["settings"],
      queryFn: async () => (await fetch("/api/settings")).json(),
    });
    return null;
  }
  return render(
    <QueryClientProvider client={client}>
      <Observer />
      <LockdownCard lockdown={false} machineName="Testbox" />
    </QueryClientProvider>,
  );
}
