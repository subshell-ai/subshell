import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { CreatePresetDialog } from "@/components/presets/create-preset-dialog";
import { PRESETS_QUERY_KEY } from "@/hooks/use-presets";
import type { PresetRow } from "@/types/preset";

/**
 * The create dialog in both postures (spec 2026-09-13 §5): the launch form's
 * NESTED one locks the agent (static text, id on the wire without asking),
 * the /presets one opens with the Agent select; both post the shared
 * `toPresetPayload` body, feed the list cache from the returned row (the
 * race the launch form's selection depends on), and hand the row out.
 */
const ROW: PresetRow = {
  id: "p-new",
  harnessId: "claude-code",
  name: "Fast",
  description: null,
  envJson: null,
  flagsJson: null,
  settingsJson: null,
  configIsolation: 0,
  restartOnExit: 0,
  createdAt: "2026-09-13T00:00:00.000Z",
  updatedAt: "2026-09-13T00:00:00.000Z",
};

function mockFetch() {
  const calls: { method: string; url: string; body: unknown }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    calls.push({ method, url: url.pathname, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    if (url.pathname === "/api/plugins") {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            plugins: [
              {
                id: "claude-code",
                name: "Claude Code",
                description: "",
                installed: true,
                enabled: true,
                builtIn: true,
              },
              // A second usable agent, so the single-usable auto-pick does NOT
              // fire — the unlocked posture must really start agent-less.
              { id: "pi", name: "Pi", description: "", installed: true, enabled: true, builtIn: true },
            ],
          }),
        ),
      );
    }
    if (url.pathname === "/api/presets" && method === "POST") return Promise.resolve(new Response(JSON.stringify(ROW)));
    // The list a page with a live usePresets() would read — an ARRAY, like
    // the real endpoint; the {} fallthrough below is for the schema route.
    if (url.pathname === "/api/presets" && method === "GET") return Promise.resolve(new Response(JSON.stringify([])));
    return Promise.resolve(new Response(JSON.stringify({})));
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

function renderDialog(props: {
  lockedHarness?: string;
  onCreated?: (row: PresetRow) => void;
  onClose?: (o: boolean) => void;
}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Seed the list cache the way a page with a live usePresets() would have it.
  client.setQueryData(PRESETS_QUERY_KEY, []);
  function Harness() {
    const [open, setOpen] = useState(true);
    return (
      <CreatePresetDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          props.onClose?.(next);
        }}
        lockedHarness={props.lockedHarness}
        onCreated={props.onCreated}
      />
    );
  }
  return {
    ...render(
      <QueryClientProvider client={client}>
        <Harness />
      </QueryClientProvider>,
    ),
    client,
  };
}

afterEach(cleanup);

describe("CreatePresetDialog — locked (launch form)", () => {
  afterEach(cleanup);

  it("titles with the agent, locks it as static text, posts the locked harnessId, and hands out the row", async () => {
    const m = mockFetch();
    const created: PresetRow[] = [];
    try {
      const { client } = renderDialog({ lockedHarness: "claude-code", onCreated: (r) => created.push(r) });
      const dialog = await screen.findByRole("dialog", { name: "New preset for Claude Code" });
      expect(
        screen.getByText(
          "Saved flags, env vars and restart policy. Every subshell you start with it launches Claude Code this way.",
        ),
      ).toBeDefined();
      expect(dialog.querySelector("#preset-harness")).toBeNull();
      expect(dialog.textContent).toContain("Claude Code");

      fireEvent.change(dialog.querySelector("#preset-name") as HTMLInputElement, { target: { value: "Fast" } });
      fireEvent.click(screen.getByRole("button", { name: "Create preset" }));

      await waitFor(() =>
        expect(m.calls).toContainEqual({
          method: "POST",
          url: "/api/presets",
          body: {
            harnessId: "claude-code",
            name: "Fast",
            env: {},
            flags: [],
            settings: {},
            configIsolation: false,
            restartOnExit: false,
          },
        }),
      );
      // The row lands in the LIST CACHE — the launch form's mismatch guard
      // reads it, and a bare invalidation would null the new selection.
      await waitFor(() =>
        expect((client.getQueryData<PresetRow[]>(PRESETS_QUERY_KEY) ?? []).map((r) => r.id)).toContain("p-new"),
      );
      await waitFor(() => expect(created.map((r) => r.id)).toEqual(["p-new"]));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    } finally {
      m.restore();
    }
  });
});

describe("CreatePresetDialog — unlocked (/presets page)", () => {
  afterEach(cleanup);

  it("titles 'Create preset' and offers the Agent select with the frozen copy", async () => {
    const m = mockFetch();
    try {
      const { container } = renderDialog({});
      const dialog = await screen.findByRole("dialog", { name: "Create preset" });
      expect(dialog.querySelector("#preset-harness")).not.toBeNull();
      expect(dialog.textContent).toContain("Which agent CLI subshells started with this preset will run.");
      // No agent yet → no second description sentence, and no submit.
      expect(screen.queryByText("Every subshell you start with it launches Claude Code this way.")).toBeNull();
      expect((screen.getByRole("button", { name: "Create preset" }) as HTMLButtonElement).disabled).toBe(true);
      void container;
    } finally {
      m.restore();
    }
  });
});
