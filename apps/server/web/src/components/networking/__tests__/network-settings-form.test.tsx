import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NetworkSettingsForm } from "@/components/networking/network-settings-form";
import type { NetworkRow } from "@/types/network";

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
    expect(saveButton().disabled).toBe(true);
    expect(screen.getByText("Control server URL is required.")).toBeTruthy();
  });

  it("opens Save once the required field has a value", () => {
    renderForm(rowWith({ settingsFields: CONTROL as unknown as NetworkRow["settingsFields"] }));
    const field = screen.getByLabelText(/Control server URL/) as HTMLInputElement;
    fireEvent.change(field, { target: { value: "https://control.example" } });
    expect(saveButton().disabled).toBe(false);
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
    expect(saveButton().disabled).toBe(false);
  });
});
