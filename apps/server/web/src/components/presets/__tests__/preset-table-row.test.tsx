import { afterEach, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { PresetRow } from "@/types/preset";
import { PresetTableRow } from "../preset-table-row";

/**
 * The agent table row's Enabled column: the switch is the owner/edit grant's
 * control, PATCHes its own row, and a parked (disabled) preset stays fully
 * inspectable — its command preview and row menu are NOT gated by `enabled`.
 * The toggle runs through the real `useTogglePresetEnabled` hook against a
 * mocked fetch, so the mutation wiring (route, method, body) is under test
 * too, not just the click.
 */

function rowPreset(over: Partial<PresetRow> = {}): PresetRow {
  return {
    id: "p1",
    harnessId: "claude-code",
    name: "Fast",
    description: null,
    envJson: '{"ANTHROPIC_MODEL":"sonnet"}',
    flagsJson: '["--model","sonnet"]',
    settingsJson: null,
    configIsolation: 0,
    restartOnExit: 0,
    enabled: 1,
    crossCommEnabled: 0,
    nodeId: null,
    workingDir: null,
    promptBlocks: null,
    createdAt: "2026-10-01",
    updatedAt: "2026-10-01",
    ...over,
  };
}

/** Mocks fetch and records every call; the PATCH answers with the row it updated. */
function mockFetch() {
  const calls: { method: string; url: string; body?: string }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    calls.push({
      method: init?.method ?? "GET",
      url: new URL(String(input), "http://localhost").pathname,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    return Promise.resolve(new Response(JSON.stringify(rowPreset())));
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

function renderRow(preset: PresetRow) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <table>
        <tbody>
          <PresetTableRow preset={preset} binary="claude" items={[]} />
        </tbody>
      </table>
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

it("patches the row enabled when the switch is flipped", async () => {
  const mock = mockFetch();
  renderRow(rowPreset({ enabled: 0 }));
  const toggle = screen.getByRole("switch", { name: "Fast enabled" });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(toggle);
  await waitFor(() => {
    const patch = mock.calls.find((c) => c.method === "PATCH");
    expect(patch).toBeTruthy();
    expect(patch?.url).toBe("/api/presets/p1");
    expect(patch?.body).toBe(JSON.stringify({ enabled: true }));
  });
  mock.restore();
});

it("flips an enabled preset off through the same PATCH", async () => {
  const mock = mockFetch();
  renderRow(rowPreset({ enabled: 1 }));
  const toggle = screen.getByRole("switch", { name: "Fast enabled" });
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  fireEvent.click(toggle);
  await waitFor(() => {
    expect(mock.calls.some((c) => c.method === "PATCH" && c.body === JSON.stringify({ enabled: false }))).toBe(true);
  });
  mock.restore();
});

it("gives a view-only viewer a plain yes instead of a switch", () => {
  const mock = mockFetch();
  renderRow(rowPreset({ access: "view", enabled: 1 }));
  expect(screen.queryByRole("switch")).toBeNull();
  // The Enabled cell reads "Yes"; the Auto-restart cell's "No" is a separate cell.
  expect(screen.getByText("Yes")).toBeTruthy();
  mock.restore();
});

it("still previews the launch command for a disabled preset", () => {
  const mock = mockFetch();
  renderRow(rowPreset({ enabled: 0 }));
  fireEvent.click(screen.getByRole("button", { name: "Fast" }));
  expect(screen.getByText("ANTHROPIC_MODEL=sonnet claude --model sonnet")).toBeTruthy();
  mock.restore();
});
