import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NetworkSettingsForm } from "@/components/networking/network-settings-form";
import type { NetworkRow } from "@/types/network";

const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

/**
 * The gating sweep (spec 2026-09-29): Save settings is disabled while a
 * required non-secret is empty — the SAME rule the card's Connect gate
 * applies — and the reason sits under the box it is about, shown once the
 * caret leaves (the addresses-card caret rule).
 */

afterEach(cleanup);

function rowWith(over: Partial<NetworkRow> = {}): NetworkRow {
  return {
    id: "headscale",
    name: "Headscale",
    description: "",
    exposure: "private",
    labels: { credential: "", publish: "" },
    platforms: ["linux"],
    supported: true,
    enabled: true,
    interactiveLogin: false,
    publishImplicit: false,
    privileged: [],
    settings: {},
    published: false,
    status: { state: "needs-login", addresses: [], hints: [] },
    ...over,
  } as NetworkRow;
}

function renderForm(row: NetworkRow) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <NetworkSettingsForm row={row} />
    </QueryClientProvider>,
  );
}

const CONTROL = [{ key: "controlUrl", label: "Control server URL", type: "string", required: true }] as const;

const saveButton = () => screen.getByRole("button", { name: "Save settings" }) as HTMLButtonElement;

describe("NetworkSettingsForm gating", () => {
  it("keeps Save disabled while a required field is empty, and says which under its box", () => {
    renderForm(rowWith({ settingsFields: CONTROL as unknown as NetworkRow["settingsFields"] }));
    const field = screen.getByLabelText(/Control server URL/) as HTMLInputElement;
    // Touch the required field and leave it empty: the button stays dead and
    // the reason is beside the box (blur == finished thought).
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: " " } });
    fireEvent.blur(field);
    expect(saveButton().matches(":disabled, [aria-disabled=true]")).toBe(true);
    expect(screen.getByText("Control server URL is required.")).toBeTruthy();
  });

  it("opens Save once the required field has a value", () => {
    renderForm(rowWith({ settingsFields: CONTROL as unknown as NetworkRow["settingsFields"] }));
    const field = screen.getByLabelText(/Control server URL/) as HTMLInputElement;
    fireEvent.change(field, { target: { value: "https://control.example" } });
    expect(saveButton().matches(":disabled, [aria-disabled=true]")).toBe(false);
    expect(screen.queryByText("Control server URL is required.")).toBeNull();
  });

  it("is quiet while the caret is in the empty required box", () => {
    renderForm(rowWith({ settingsFields: CONTROL as unknown as NetworkRow["settingsFields"] }));
    const field = screen.getByLabelText(/Control server URL/) as HTMLInputElement;
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: "not-a-url" } }); // valid-ish text, still focused
    expect(screen.queryByText("Control server URL is required.")).toBeNull();
  });

  it("a row whose required field is already saved opens Save on any unrelated touch", () => {
    renderForm(
      rowWith({
        settingsFields: [
          { key: "controlUrl", label: "Control server URL", type: "string", required: true },
          { key: "noise", label: "Tailscale port", type: "number" },
        ] as unknown as NetworkRow["settingsFields"],
        settings: { controlUrl: "https://control.example" },
      }),
    );
    // Touching the optional field does not make the required one missing, so
    // the button turns live (dirty, and no requirement unmet).
    fireEvent.change(screen.getByLabelText(/Tailscale port/), { target: { value: "3478" } });
    expect(saveButton().matches(":disabled, [aria-disabled=true]")).toBe(false);
  });

  it("sends only the keys that still differ from saved, not a reverted one", async () => {
    // THE payload change this PR made: the body used to be every touched draft
    // (a reverted key rode along); now it is the effective-diff set. A
    // comparison bug here would silently write the reverted value back, so it
    // is pinned at the wire, not just on the button.
    let patched: Record<string, string> | null = null;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      patched = JSON.parse(String(init?.body)) as Record<string, string>;
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;
    renderForm(
      rowWith({
        settingsFields: [
          { key: "controlUrl", label: "Control server URL", type: "string", required: true },
          { key: "noise", label: "Tailscale port", type: "number" },
        ] as unknown as NetworkRow["settingsFields"],
        settings: { controlUrl: "https://control.example" },
      }),
    );
    const control = screen.getByLabelText(/Control server URL/);
    const noise = screen.getByLabelText(/Tailscale port/);
    // Change controlUrl, then put it back; change noise and leave it.
    fireEvent.change(control, { target: { value: "https://other.example" } });
    fireEvent.change(control, { target: { value: "https://control.example" } });
    fireEvent.change(noise, { target: { value: "3478" } });
    expect(saveButton().matches(":disabled, [aria-disabled=true]")).toBe(false);
    fireEvent.click(saveButton());
    await waitFor(() => expect(patched).not.toBeNull());
    // `patched` is only ever assigned from the fetch closure, so TypeScript
    // still reads its flow-narrowed type as null; the value is the wire body.
    expect(patched as Record<string, string> | null).toEqual({ noise: "3478" });
  });

  it("a boolean or secret reverted to its saved state is not a change at all", () => {
    renderForm(
      rowWith({
        settingsFields: [
          { key: "autoStart", label: "Start on boot", type: "boolean" },
          { key: "token", label: "Tunnel token", type: "secret" },
        ] as unknown as NetworkRow["settingsFields"],
        settings: { autoStart: "true", token: { set: true } },
      }),
    );
    // Toggling the switch and typing into the secret make it dirty; putting
    // both back — the switch to its saved true, the secret cleared to empty —
    // returns Save to dead, because neither is a change from what is stored.
    fireEvent.click(screen.getByRole("switch", { name: "Start on boot" }));
    fireEvent.change(screen.getByLabelText(/Tunnel token/), { target: { value: "typed" } });
    expect(saveButton().matches(":disabled, [aria-disabled=true]")).toBe(false);
    fireEvent.click(screen.getByRole("switch", { name: "Start on boot" }));
    fireEvent.change(screen.getByLabelText(/Tunnel token/), { target: { value: "" } });
    expect(saveButton().matches(":disabled, [aria-disabled=true]")).toBe(true);
  });

  it("says so when nothing changed, in the reverted case included", () => {
    renderForm(
      rowWith({
        settingsFields: [
          { key: "noise", label: "Tailscale port", type: "number" },
        ] as unknown as NetworkRow["settingsFields"],
        settings: { noise: "2000" },
      }),
    );
    // Untouched, and touched-then-reverted, wear the same sentence: Save is
    // dead with "No network setting changes to save." both times (the wording
    // this PR settled on across the nine surfaces).
    expect(saveButton().matches(":disabled, [aria-disabled=true]")).toBe(true);
    expect(saveButton().getAttribute("aria-description")).toBe("No network setting changes to save.");
    fireEvent.change(screen.getByLabelText(/Tailscale port/), { target: { value: "2000" } });
    expect(saveButton().matches(":disabled, [aria-disabled=true]")).toBe(true);
    expect(saveButton().getAttribute("aria-description")).toBe("No network setting changes to save.");
  });
});
