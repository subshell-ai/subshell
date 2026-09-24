import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LogRetentionCard } from "../log-retention-card";

/**
 * The retention card's WIRING: it reads the LOCAL endpoint (no plane route
 * exists for this, so `/api/self/…` is the only honest target), it names the
 * layer each field came from, it disables exactly the field the environment
 * forces while leaving the other writable, and a save sends ONLY what changed
 * (a half-edit must not silently re-assert the half it did not touch). The
 * route's own rules (409 for a forced field, 400 for junk, persistence to
 * config.json) are pinned server-side in the agent's dashboard tests; this
 * covers what the card decides before and after pressing Save.
 */

interface StubState {
  days: { value: number; source: "env" | "stored" | "default"; forced: boolean };
  hours: { value: number; source: "env" | "stored" | "default"; forced: boolean };
  forever: boolean;
  /** Whether the daemon armed its hourly sweep at boot — the endpoint's process fact. */
  scheduled: boolean;
}

const calls: { method: string; body?: string }[] = [];

function stub(state: StubState, refusal?: { status: number; message: string }): void {
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
    if (method === "PUT" && refusal) {
      return new Response(JSON.stringify({ error: refusal.message, message: refusal.message }), {
        status: refusal.status,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify(state), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

function renderCard(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <QueryClientProvider client={client}>
      <LogRetentionCard />
    </QueryClientProvider>,
  );
}

const STORED: StubState = {
  days: { value: 7, source: "stored", forced: false },
  hours: { value: 0, source: "default", forced: false },
  forever: false,
  scheduled: true, // the common boot shape: a finite window armed the hourly timer
};

beforeEach(() => {
  calls.length = 0;
});

afterEach(() => {
  cleanup();
});

describe("LogRetentionCard", () => {
  test("shows the values with the layer that answered each, and the no-restart line", async () => {
    stub(STORED);
    renderCard();
    expect(((await screen.findByLabelText("Days")) as HTMLInputElement).value).toBe("7");
    expect((screen.getByLabelText("Hours") as HTMLInputElement).value).toBe("0");
    expect(screen.getByText("Stored in config.json.")).toBeTruthy();
    expect(screen.getByText("Default, unset in config.json and the environment.")).toBeTruthy();
    expect(screen.getByText(/takes effect at the next sweep without a restart/)).toBeTruthy();
  });

  test("the env-forced field is disabled and names its variable; the other half stays editable", async () => {
    stub({
      days: { value: 3, source: "env", forced: true },
      hours: { value: 0, source: "default", forced: false },
      forever: false,
      scheduled: true,
    });
    renderCard();
    const days = (await screen.findByLabelText("Days")) as HTMLInputElement;
    expect(days.disabled).toBe(true);
    expect(screen.getByText(/SUBSHELL_LOG_RETENTION_DAYS/)).toBeTruthy();
    expect((screen.getByLabelText("Hours") as HTMLInputElement).disabled).toBe(false);
  });

  test("a save PUTs only the touched field to the local endpoint", async () => {
    stub({ ...STORED, days: { value: 14, source: "stored", forced: false } });
    renderCard();
    await screen.findByLabelText("Days");
    fireEvent.change(screen.getByLabelText("Hours"), { target: { value: "6" } });
    fireEvent.click(screen.getByRole("button", { name: "Save window" }));
    await waitFor(() => {
      const put = calls.find((c) => c.method === "PUT");
      expect(put?.body).toBe(JSON.stringify({ hours: 6 }));
    });
    expect(await screen.findByText(/next hourly sweep uses the new window/)).toBeTruthy();
  });

  test("an untouched form cannot save, and junk cannot either", async () => {
    stub(STORED);
    renderCard();
    expect(((await screen.findByRole("button", { name: "Save window" })) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Days"), { target: { value: "-2" } });
    expect((screen.getByRole("button", { name: "Save window" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/whole number of 0 or more/)).toBeTruthy();
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  test("a node that armed no sweep promises the restart, not a sweep (finding 5)", async () => {
    // The defect: the old copy derived this from the STORED forever-ness, so a
    // daemon that booted keep-forever was told "a new window applies when the
    // node next restarts" — right — while a daemon that booted FINITE and was
    // later saved to forever was told the same lie in reverse. The card now
    // reads `scheduled` off the endpoint: this boot shape has no hourly pass
    // to deliver a written window, and says so.
    stub({ ...STORED, scheduled: false });
    renderCard();
    await screen.findByLabelText("Days");
    expect(screen.getByText(/scheduled no sweep when it started/)).toBeTruthy();
    expect(screen.getByText(/applies when the node next restarts/)).toBeTruthy();
    expect(screen.queryByText(/next hourly sweep/)).toBeNull();
  });

  test("keep-forever with no sweep says both truths; with one, the sweep still runs", async () => {
    // Booted forever: nothing is swept AND a move away waits for the restart.
    stub({ ...STORED, forever: true, days: { value: 0, source: "stored", forced: false }, scheduled: false });
    renderCard();
    await screen.findByLabelText("Days");
    expect(screen.getByText(/no sweep is scheduled here/)).toBeTruthy();
    expect(screen.getByText(/next restarts/)).toBeTruthy();
    cleanup();
    // Booted finite, saved forever: the timer is still armed, so leaving
    // forever (and back to a window) lands on the next pass — the sentence the
    // old derived copy got wrong for exactly this daemon.
    stub({ ...STORED, forever: true, days: { value: 0, source: "stored", forced: false }, scheduled: true });
    renderCard();
    await screen.findByLabelText("Days");
    expect(screen.getByText(/hourly sweep runs while this node is up/)).toBeTruthy();
    expect(screen.getByText(/including a move away from keep-forever/)).toBeTruthy();
    expect(screen.queryByText(/next restarts/)).toBeNull();
  });

  test("a save on an unscheduled boot lands on the restart line, not the sweep line", async () => {
    stub({ ...STORED, scheduled: false });
    renderCard();
    await screen.findByLabelText("Days");
    fireEvent.change(screen.getByLabelText("Hours"), { target: { value: "6" } });
    fireEvent.click(screen.getByRole("button", { name: "Save window" }));
    expect(await screen.findByText(/new window applies when the node next restarts/)).toBeTruthy();
    expect(screen.queryByText(/next hourly sweep uses the new window/)).toBeNull();
  });

  test("a refusal prints the sentence the machine answered with", async () => {
    stub(STORED, { status: 409, message: "SUBSHELL_LOG_RETENTION_DAYS is set in this agent's environment" });
    renderCard();
    await screen.findByLabelText("Days");
    fireEvent.change(screen.getByLabelText("Days"), { target: { value: "9" } });
    fireEvent.click(screen.getByRole("button", { name: "Save window" }));
    expect(await screen.findByText(/SUBSHELL_LOG_RETENTION_DAYS is set/)).toBeTruthy();
  });
});
