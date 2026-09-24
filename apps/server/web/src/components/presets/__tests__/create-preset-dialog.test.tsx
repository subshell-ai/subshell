import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { CreatePresetDialog } from "@/components/presets/create-preset-dialog";
import { PRESETS_QUERY_KEY } from "@/hooks/use-presets";
import { type PresetFormValue, presetFormFromRow } from "@/lib/preset-form";
import type { PresetRow } from "@/types/preset";

/**
 * The create dialog in its postures (spec 2026-09-13 §5): the launch form's
 * NESTED one locks the agent (static text, id on the wire without asking),
 * the /presets one opens with the Agent select; both post the shared
 * `toPresetPayload` body, feed the list cache from the returned row (the
 * race the launch form's selection depends on), and hand the row out.
 * The third posture is the CLONE: an `initialForm` seed ALONE — titled
 * "Clone preset", still a plain create, and the harness locks itself off the
 * seed, so no second prop pairs with it.
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

/** A stored preset with one env var, one flag with a value, auto-restart on —
 *  the SOURCE a clone posture starts from. */
const SOURCE: PresetRow = {
  id: "src-1",
  harnessId: "claude-code",
  name: "Work",
  description: null,
  envJson: '{"ANTHROPIC_MODEL":"sonnet"}',
  flagsJson: '["--effort","xhigh"]',
  settingsJson: null,
  configIsolation: 0,
  restartOnExit: 1,
  createdAt: "2026-09-13T00:00:00.000Z",
  updatedAt: "2026-09-13T00:00:00.000Z",
};

function mockFetch(post: { status?: number; body?: unknown } = {}) {
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
    if (url.pathname === "/api/presets" && method === "POST") {
      return Promise.resolve(new Response(JSON.stringify(post.body ?? ROW), { status: post.status ?? 200 }));
    }
    // The list a page with a live usePresets() would read — an ARRAY, like
    // the real endpoint; the {} fallthrough below is for the schema route.
    if (url.pathname === "/api/presets" && method === "GET") return Promise.resolve(new Response(JSON.stringify([])));
    return Promise.resolve(new Response(JSON.stringify({})));
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

function renderDialog(props: {
  lockedHarness?: string;
  initialForm?: PresetFormValue;
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
        initialForm={props.initialForm}
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
            // ON by default since 2026-09-18 — a preset is a way of running
            // something repeatedly, so recovering from an exit is expected.
            restartOnExit: true,
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

describe("CreatePresetDialog — clone (initialForm)", () => {
  afterEach(cleanup);

  it("titles Clone preset, seeds the source's values with the suggested name, keeps the locked agent, and posts a plain create", async () => {
    const m = mockFetch();
    try {
      // `initialForm` ALONE — no `lockedHarness` pairs with it. The lock is
      // derived from the seed; this test is what pins that guarantee.
      renderDialog({
        initialForm: { ...presetFormFromRow(SOURCE), name: "Work (2)" },
      });
      const dialog = await screen.findByRole("dialog", { name: "Clone preset" });
      // The seeded name rides the Name field; the source's own name would be
      // the collision the caller's suggestCloneName just avoided.
      expect((dialog.querySelector("#preset-name") as HTMLInputElement).value).toBe("Work (2)");
      // Locked posture: no select, and the agent shows as static text naming
      // itself — the name comes from the catalog, so it has to have landed.
      expect(dialog.querySelector("#preset-harness")).toBeNull();
      expect(await screen.findByText("Claude Code")).toBeDefined();

      fireEvent.click(screen.getByRole("button", { name: "Create preset" }));
      // The payload is a plain create carrying the seeded fields: harness
      // preserved, name suggested, env/flags/restart copied from the source.
      await waitFor(() =>
        expect(m.calls).toContainEqual({
          method: "POST",
          url: "/api/presets",
          body: {
            harnessId: "claude-code",
            name: "Work (2)",
            env: { ANTHROPIC_MODEL: "sonnet" },
            flags: ["--effort", "xhigh"],
            settings: {},
            configIsolation: false,
            restartOnExit: true,
          },
        }),
      );
    } finally {
      m.restore();
    }
  });

  it("surfaces a duplicate-name 409 inline and keeps the dialog open", async () => {
    // The raced collision the clone posture is built to expect: the suggestion
    // was computed against a cache another tab had not written yet. The
    // server's shape is `{ message }`, which `apiFetch` lifts into an
    // ApiError's message, so `create.error` renders it verbatim — and the
    // dialog stays open on the mutation error so the name can be edited and
    // the same button pressed again.
    const m = mockFetch({
      status: 409,
      body: { message: 'You already have a claude-code preset named "Work (2)"' },
    });
    const closes: boolean[] = [];
    try {
      renderDialog({
        initialForm: { ...presetFormFromRow(SOURCE), name: "Work (2)" },
        onClose: (o) => closes.push(o),
      });
      const dialog = await screen.findByRole("dialog", { name: "Clone preset" });
      fireEvent.click(screen.getByRole("button", { name: "Create preset" }));
      await screen.findByText(/You already have a claude-code preset named "Work \(2\)"/);
      // Still open: the same dialog node, and `onOpenChange(false)` never fired.
      expect(screen.getByRole("dialog")).toBe(dialog);
      expect(closes).not.toContain(false);
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
