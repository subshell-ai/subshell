import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  crossCommEnabled: 0,
  nodeId: null,
  workingDir: null,
  promptBlocks: null,
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
  crossCommEnabled: 0,
  nodeId: null,
  workingDir: null,
  promptBlocks: null,
  createdAt: "2026-09-13T00:00:00.000Z",
  updatedAt: "2026-09-13T00:00:00.000Z",
};

function mockFetch(post: { status?: number; body?: unknown } = {}, nodes: unknown[] = []) {
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
    if (url.pathname === "/api/nodes" && method === "GET") {
      return Promise.resolve(new Response(JSON.stringify({ nodes })));
    }
    // The prompt picker's feeds (opened via the launch-defaults section):
    // empty own/shared views, the shape both queries expect.
    if (url.pathname === "/api/prompts" || url.pathname === "/api/prompts/stacks") {
      return Promise.resolve(new Response(JSON.stringify({ own: [], shared: [] })));
    }
    return Promise.resolve(new Response(JSON.stringify({})));
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

async function renderDialog(props: {
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
  const utils = render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );
  // The dialog renders before the plugins catalog query lands; its arrival is
  // what re-renders the Base UI Select. Drain it inside act() before returning.
  await settle();
  return { ...utils, client };
}

/** Flush pending query/effect updates inside act() (the repo-wide pattern
 *  from new-subshell-form.test.tsx): Base UI's Select defers state updates to
 *  effects and its own scheduler, so the catalog load's re-render lands
 *  outside the findByRole retries' act scopes and warns. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
}

afterEach(cleanup);

describe("CreatePresetDialog — locked (launch form)", () => {
  afterEach(cleanup);

  it("titles with the agent, locks it as static text, posts the locked harnessId, and hands out the row", async () => {
    const m = mockFetch();
    const created: PresetRow[] = [];
    try {
      const { client } = await renderDialog({ lockedHarness: "claude-code", onCreated: (r) => created.push(r) });
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
            crossCommEnabled: false,
            // The launch trio posts as empty nulls until the editor says
            // otherwise (spec 2026-09-29).
            nodeId: null,
            workingDir: null,
            promptBlocks: null,
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
      await renderDialog({
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
            crossCommEnabled: false,
            nodeId: null,
            workingDir: null,
            promptBlocks: null,
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
      await renderDialog({
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
      const { container } = await renderDialog({});
      const dialog = await screen.findByRole("dialog", { name: "Create preset" });
      expect(dialog.querySelector("#preset-harness")).not.toBeNull();
      expect(dialog.textContent).toContain("Which agent CLI subshells started with this preset will run.");
      // No agent and no name yet → no second description sentence, and no submit.
      expect(screen.queryByText("Every subshell you start with it launches Claude Code this way.")).toBeNull();
      expect((screen.getByRole("button", { name: "Create preset" }) as HTMLButtonElement).disabled).toBe(true);
      void container;
    } finally {
      m.restore();
    }
  });
});

describe("launch defaults fields (spec 2026-09-29 preset-launch-fields)", () => {
  afterEach(cleanup);

  it("renders the launch defaults with the amber requirement checklist", async () => {
    const m = mockFetch();
    try {
      await renderDialog({ lockedHarness: "claude-code" });
      const dialog = await screen.findByRole("dialog");
      expect(dialog.querySelector("#preset-launch-node")).toBeDefined();
      expect(within(dialog).getByText("Working directory")).toBeDefined();
      // The stack section stands on its own behind the divider: titled,
      // described, with the add button visible WITHOUT any checkbox first.
      expect(within(dialog).getByText("Add prompts")).toBeDefined();
      expect(within(dialog).getByText("Prompts to inject on subshell creation.")).toBeDefined();
      expect(within(dialog).getByRole("button", { name: "Add prompt" })).toBeDefined();
      // The empty directory reads as a choice, exactly like the Machine
      // select's "Decide at launch" empty state.
      expect((dialog.querySelector("#preset-launch-dir") as HTMLInputElement).placeholder).toBe("Decide at launch");
      // Nothing set yet: the two requirements show as a checklist, every item
      // amber (the warning colour), and the switch cannot arm (migration 0043).
      expect(Array.from(dialog.querySelectorAll("li"))).toHaveLength(2);
      expect((dialog.querySelectorAll("li")[0] as HTMLElement).className).toContain("text-amber-600");
      expect((dialog.querySelector("#preset-cross-comm") as HTMLButtonElement).disabled).toBe(true);
    } finally {
      m.restore();
    }
  });

  it("the cross-subshell switch arms only on machine + directory, and a broken pair blocks Save", async () => {
    const m = mockFetch();
    try {
      await renderDialog({ lockedHarness: "claude-code" });
      const dialog = await screen.findByRole("dialog");
      const toggle = () => dialog.querySelector("#preset-cross-comm") as HTMLButtonElement;
      const save = () => screen.getByRole("button", { name: "Create preset" }) as HTMLButtonElement;
      // Set all three through the form: name + dir typed, prompt added.
      fireEvent.change(dialog.querySelector("#preset-name") as HTMLInputElement, { target: { value: "Fast" } });
      fireEvent.change(dialog.querySelector("#preset-launch-dir") as HTMLInputElement, {
        target: { value: "/srv/app" },
      });
      fireEvent.click(within(dialog).getByRole("button", { name: "Add prompt" }));
      fireEvent.click(await within(dialog).findByRole("button", { name: /Write your own/ }));
      fireEvent.change(within(dialog).getByPlaceholderText("The text to type into the pane"), {
        target: { value: "go" },
      });
      fireEvent.click(within(dialog).getByRole("button", { name: "Add prompt" }));
      // Node left on "Decide at launch": only the machine is MISSING - met
      // requirements leave the list. The prompt was never a requirement
      // (re-ruling 2026-09-30).
      await waitFor(() => expect(Array.from(dialog.querySelectorAll("#preset-cross-comm-gaps li"))).toHaveLength(1));
      const first = dialog.querySelector("#preset-cross-comm-gaps li") as HTMLLIElement;
      expect(first.textContent).toBe("A machine");
      expect(first.className).toContain("text-amber-600");
      expect(toggle().disabled).toBe(true);
      expect(save().disabled).toBe(false);
    } finally {
      m.restore();
    }
  });

  it("the machine picker lists EVERY node, split Online/Offline, and offline rows arm the switch", async () => {
    // A preset names a machine instance-scoped: the box that is down now may
    // host this preset's launches later, so it is a CHOICE, not a hidden row.
    const desk = {
      id: "a1",
      name: "desk",
      kind: "agent",
      status: "online",
      os: null,
      arch: null,
      maintenance: false,
      inventoryStale: false,
      canLaunch: true,
      harnesses: [{ harnessId: "claude-code", name: "Claude Code", installed: true }],
    };
    const oldLaptop = {
      id: "a2",
      name: "old laptop",
      kind: "agent",
      status: "offline",
      os: null,
      arch: null,
      maintenance: false,
      inventoryStale: false,
      canLaunch: true,
      harnesses: [],
    };
    const m = mockFetch({}, [desk, oldLaptop]);
    try {
      await renderDialog({ lockedHarness: "claude-code" });
      const dialog = await screen.findByRole("dialog");
      // The help sentence is gone: the select says "Decide at launch" and the
      // section below says everything else.
      expect(screen.queryByText(/Where subshells started/)).toBeNull();
      fireEvent.click(dialog.querySelector("#preset-launch-node") as HTMLElement);
      const offline = await screen.findByRole("option", { name: /old laptop \(offline\)/ });
      // The list holds MACHINES only (ruling 2026-09-30): no "Decide at
      // launch" row; emptiness is the placeholder plus the X.
      expect(screen.queryByRole("option", { name: "Decide at launch" })).toBeNull();
      expect(screen.getByRole("option", { name: /desk/ })).toBeDefined();
      // Section headers, in order, and the offline row is SELECTABLE.
      expect(screen.getByText("Online")).toBeDefined();
      expect(screen.getByText("Offline")).toBeDefined();
      expect(offline.getAttribute("aria-disabled")).toBeNull();
      // Base UI commits a pick on the full pointer sequence (see the
      // provider dialog's pickOption).
      fireEvent.pointerDown(offline);
      fireEvent.pointerUp(offline);
      fireEvent.click(offline);
      // The picked machine earns its X (2026-09-30): clearing is an act on
      // the field, not a row in the list.
      fireEvent.click(screen.getByRole("button", { name: "Clear machine" }));
      await waitFor(() => expect(dialog.querySelector('[aria-label="Clear machine"]')).toBeNull());
      expect((dialog.querySelector("#preset-launch-node") as HTMLElement).textContent).toContain("Decide at launch");
      // Re-pick: the gap checks below need the machine chosen again.
      fireEvent.click(dialog.querySelector("#preset-launch-node") as HTMLElement);
      const offline2 = await screen.findByRole("option", { name: /old laptop \(offline\)/ });
      fireEvent.pointerDown(offline2);
      fireEvent.pointerUp(offline2);
      fireEvent.click(offline2);
      // Chosen: the machine gap closes even though the node is DOWN.
      await waitFor(() =>
        expect(dialog.querySelector("#preset-cross-comm-gaps")?.textContent).toBe("A working directory"),
      );
      expect((dialog.querySelector("#preset-cross-comm") as HTMLButtonElement).disabled).toBe(true); // dir still missing
      fireEvent.change(dialog.querySelector("#preset-launch-dir") as HTMLInputElement, {
        target: { value: "/srv/app" },
      });
      // Both met: the list empties and the switch arms.
      await waitFor(() => expect(dialog.querySelector("#preset-cross-comm-gaps")).toBeNull());
      expect((dialog.querySelector("#preset-cross-comm") as HTMLButtonElement).disabled).toBe(false);
    } finally {
      m.restore();
    }
  });

  it("a real toggle-click reaches the POST: creating with the switch on stores it on", async () => {
    const desk = {
      id: "a1",
      name: "desk",
      kind: "agent",
      status: "online",
      os: null,
      arch: null,
      maintenance: false,
      inventoryStale: false,
      canLaunch: true,
      harnesses: [{ harnessId: "claude-code", name: "Claude Code", installed: true }],
    };
    const m = mockFetch({}, [desk]);
    try {
      await renderDialog({ lockedHarness: "claude-code" });
      const dialog = await screen.findByRole("dialog");
      fireEvent.change(dialog.querySelector("#preset-name") as HTMLInputElement, { target: { value: "cc-live" } });
      fireEvent.change(dialog.querySelector("#preset-launch-dir") as HTMLInputElement, {
        target: { value: "/srv/app" },
      });
      fireEvent.click(dialog.querySelector("#preset-launch-node") as HTMLElement);
      const option = await screen.findByRole("option", { name: /desk/ });
      fireEvent.pointerDown(option);
      fireEvent.pointerUp(option);
      fireEvent.click(option);
      const toggle = () => dialog.querySelector("#preset-cross-comm") as HTMLButtonElement;
      await waitFor(() => expect(toggle().disabled).toBe(false));
      fireEvent.click(toggle());
      fireEvent.click(screen.getByRole("button", { name: "Create preset" }));
      await waitFor(() =>
        expect(m.calls.filter((c) => c.method === "POST" && c.url === "/api/presets")).toHaveLength(1),
      );
      const post = m.calls.find((c) => c.method === "POST" && c.url === "/api/presets");
      expect(post?.body).toMatchObject({
        name: "cc-live",
        crossCommEnabled: true,
        nodeId: "a1",
        workingDir: "/srv/app",
      });
    } finally {
      m.restore();
    }
  });

  it("Create stays disabled while the Name is blank, even with the agent locked", async () => {
    const m = mockFetch();
    try {
      await renderDialog({ lockedHarness: "claude-code" });
      const dialog = await screen.findByRole("dialog");
      const save = () => screen.getByRole("button", { name: "Create preset" }) as HTMLButtonElement;
      const name = () => dialog.querySelector("#preset-name") as HTMLInputElement;
      expect(save().disabled).toBe(true);
      // At rest the field is marked required (the gold star); the sentence
      // waits for the caret to leave an empty field (ruling 2026-09-30).
      expect(dialog.querySelector('label[for="preset-name"]')).not.toBeNull();
      fireEvent.blur(name());
      expect(dialog.textContent).toContain("A name is required.");
      fireEvent.change(name(), { target: { value: "   " } });
      fireEvent.blur(name());
      expect(save().disabled).toBe(true);
      expect(dialog.textContent).toContain("A name is required.");
      fireEvent.change(name(), { target: { value: "Fast" } });
      fireEvent.blur(name());
      expect(save().disabled).toBe(false);
      expect(dialog.textContent).not.toContain("A name is required.");
    } finally {
      m.restore();
    }
  });

  it("clicking out or pressing Escape does NOT close the form; Close (X) does", async () => {
    // The live-test loss this pins: a click outside silently discarded a
    // half-filled preset (operator ruling 2026-09-30).
    const closed: boolean[] = [];
    await renderDialog({ lockedHarness: "claude-code", onClose: (o) => closed.push(o) });
    const dialog = await screen.findByRole("dialog");
    const backdrop = document.querySelector('[data-slot="dialog-overlay"]') as HTMLElement;
    fireEvent.mouseDown(backdrop);
    fireEvent.mouseUp(backdrop);
    fireEvent.keyDown(dialog, { key: "Escape" });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("dialog")).not.toBeNull();
    expect(closed).toEqual([]);
    fireEvent.click(screen.getByLabelText("Close"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(closed).toEqual([false]);
  });

  it("the always-shown Add prompt button opens the picker", async () => {
    const m = mockFetch();
    try {
      await renderDialog({ lockedHarness: "claude-code" });
      const dialog = await screen.findByRole("dialog");
      fireEvent.click(within(dialog).getByRole("button", { name: "Add prompt" }));
      await within(dialog).findByRole("button", { name: /Write your own/ });
    } finally {
      m.restore();
    }
  });
});
