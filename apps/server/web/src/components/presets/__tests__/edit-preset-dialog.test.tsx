import { afterEach, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PRESETS_QUERY_KEY } from "@/hooks/use-presets";
import type { PresetRow } from "@/types/preset";
import { EditPresetDialog } from "../edit-preset-dialog";

const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});
const preset: PresetRow = {
  id: "p1",
  name: "Original",
  harnessId: "claude-code",
  description: null,
  envJson: null,
  flagsJson: null,
  settingsJson: null,
  configIsolation: 0,
  restartOnExit: 0,
  crossCommEnabled: 0,
  nodeId: null,
  workingDir: null,
  promptBlocks: null,
  createdAt: "2026-10-01",
  updatedAt: "2026-10-01",
};
function setup(reply: () => Promise<Response>) {
  const writes: Record<string, unknown>[] = [];
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    if (init?.method === "PUT") {
      expect(String(input)).toContain("/api/presets/p1");
      writes.push(JSON.parse(String(init.body)));
      return reply();
    }
    return Promise.resolve(
      new Response(
        JSON.stringify(
          String(input).includes("/plugins")
            ? {
                plugins: [{ id: "claude-code", name: "Claude Code", installed: true, enabled: true, builtIn: true }],
              }
            : {},
        ),
      ),
    );
  }) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(PRESETS_QUERY_KEY, [preset]);
  const applied: PresetRow[] = [];
  let closed = false;
  const view = render(
    <QueryClientProvider client={client}>
      <EditPresetDialog
        preset={preset}
        onSaved={(row) => applied.push(row)}
        onClose={() => {
          closed = true;
        }}
      />
    </QueryClientProvider>,
  );
  return { view, client, applied, writes, isClosed: () => closed };
}
it("saves the existing preset and applies the returned row after updating the cache", async () => {
  const updated = { ...preset, name: "Updated", flagsJson: '["--model","sonnet"]' };
  const state = setup(async () => new Response(JSON.stringify(updated)));
  fireEvent.click(screen.getByRole("button", { name: "Save and apply" }));
  await waitFor(() => expect(state.applied).toEqual([updated]));
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0]).not.toHaveProperty("harnessId");
  expect(state.client.getQueryData<PresetRow[]>(PRESETS_QUERY_KEY)).toEqual([updated]);
  expect(state.isClosed()).toBe(true);
});
it("cancel leaves the stored and selected preset alone", () => {
  const state = setup(async () => new Response(JSON.stringify(preset)));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(state.writes).toEqual([]);
  expect(state.applied).toEqual([]);
  expect(state.isClosed()).toBe(true);
});
it("a rejected save keeps the editor open without applying", async () => {
  const state = setup(async () => new Response(JSON.stringify({ message: "Name already exists" }), { status: 409 }));
  fireEvent.click(screen.getByRole("button", { name: "Save and apply" }));
  await waitFor(() => expect(screen.getByText(/Name already exists/)).toBeTruthy());
  expect(state.applied).toEqual([]);
  expect(state.isClosed()).toBe(false);
});
it("a late save after switching away does not reapply an old selection", async () => {
  let resolve!: (response: Response) => void;
  const state = setup(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Save and apply" }));
  await waitFor(() => expect(state.writes).toHaveLength(1));
  state.view.unmount();
  const updated = { ...preset, name: "Updated" };
  resolve(new Response(JSON.stringify(updated)));
  await waitFor(() => expect(state.client.getQueryData<PresetRow[]>(PRESETS_QUERY_KEY)).toEqual([updated]));
  expect(state.applied).toEqual([]);
});
