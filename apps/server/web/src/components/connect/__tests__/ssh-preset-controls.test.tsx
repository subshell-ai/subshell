import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { SshPresetPicker } from "@/components/connect/ssh-preset-controls";
import type { SshPreset } from "@/types/preset";

/**
 * The connect panel's saved-connection picker. Launch offers only enabled
 * presets (spec 2026-10-24): the filter sits on the query's rows, so a
 * disabled row can neither appear in the options nor auto-apply from the
 * URL intent - the existing "no longer available" alert is what a deep
 * link onto one reads as.
 */
function sshPreset(overrides: Partial<SshPreset> & { id: string }): SshPreset {
  return {
    kind: "ssh",
    name: "Box",
    description: null,
    nodeId: "desk",
    destination: "user@box.example:22",
    alias: null,
    authentication: "connecting",
    keyHome: null,
    fingerprints: [],
    forwards: [],
    enabled: 1,
    createdAt: "2026-10-25T00:00:00.000Z",
    updatedAt: "2026-10-25T00:00:00.000Z",
    ...overrides,
  };
}

function mockFetch(rows: SshPreset[]) {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/presets" && url.searchParams.get("kind") === "ssh") {
      return Promise.resolve(new Response(JSON.stringify(rows)));
    }
    return Promise.resolve(new Response(JSON.stringify({ message: "unexpected" }), { status: 404 }));
  }) as typeof fetch;
  return () => (globalThis.fetch = original);
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
}

/** The Base UI press path happy-dom needs: pointer down/up, not a bare click. */
function openPicker(): void {
  const input = screen.getByPlaceholderText("Choose a preset");
  act(() => {
    for (const type of ["pointerdown", "pointerup"]) {
      input.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "mouse" }));
    }
    for (const type of ["mousedown", "mouseup", "click"]) {
      input.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
    }
  });
}

async function renderPicker(props: { initialId?: string; onApply: (preset: SshPreset) => void }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SshPresetPicker disabled={false} {...props} />
    </QueryClientProvider>,
  );
  await settle();
}

describe("SshPresetPicker enabled filter (spec 2026-10-24)", () => {
  afterEach(cleanup);

  it("offers only the enabled presets", async () => {
    const restore = mockFetch([
      sshPreset({ id: "sp-on", name: "Live box", destination: "ada@live.example:22" }),
      sshPreset({ id: "sp-off", name: "Parked box", destination: "ada@parked.example:22", enabled: 0 }),
    ]);
    try {
      await renderPicker({ onApply: () => {} });
      openPicker();
      await settle();
      const list = screen.getByRole("listbox");
      expect(within(list).getByText("Live box")).toBeDefined();
      expect(within(list).queryByText("Parked box")).toBeNull();
    } finally {
      restore();
    }
  });

  it("a URL intent naming a disabled preset never applies it, and the alert names it gone", async () => {
    const applied: SshPreset[] = [];
    const restore = mockFetch([sshPreset({ id: "sp-off", name: "Parked box", enabled: 0 })]);
    try {
      await renderPicker({ initialId: "sp-off", onApply: (p) => applied.push(p) });
      await settle();
      expect(applied).toHaveLength(0);
      expect(screen.getByText(/This SSH preset is no longer available/)).toBeDefined();
      // With that one row the only one there is, the picker has nothing to
      // offer - so it draws nothing rather than an empty control.
      expect(screen.queryByPlaceholderText("Choose a preset")).toBeNull();
    } finally {
      restore();
    }
  });

  it("an enabled preset named by the URL intent still applies itself", async () => {
    const applied: SshPreset[] = [];
    const restore = mockFetch([sshPreset({ id: "sp-on", name: "Live box" })]);
    try {
      await renderPicker({ initialId: "sp-on", onApply: (p) => applied.push(p) });
      await settle();
      expect(applied.map((p) => p.id)).toEqual(["sp-on"]);
      expect(screen.queryByText(/no longer available/)).toBeNull();
    } finally {
      restore();
    }
  });
});
