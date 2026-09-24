import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SwitchPresetDialog } from "@/components/switch-preset-dialog";
import type { PresetRow } from "@/types/preset";
import type { SubshellView } from "@/types/subshell";

/** Minimal full view (mirrors the clone-dialog fixture) with overrides. */
function makeSubshell(overrides: Partial<SubshellView> = {}): SubshellView {
  return {
    id: "id-1",
    presetId: "preset-1",
    harnessId: "claude",
    nodeOffline: false,
    name: "worker",
    nameLocked: false,
    workingDir: "/tmp/project",
    status: "running",
    createdAt: "2026-09-23T00:00:00.000Z",
    endedAt: null,
    lastOutputAt: null,
    activity: "idle",
    alive: true,
    exitCode: null,
    startedAt: null,
    backoffCount: 0,
    restartOnExit: false,
    nextRestartAt: null,
    notify: false,
    waitingSince: null,
    access: "owner",
    ...overrides,
  };
}

/** A full preset row with overridable fields. */
function presetRow(overrides: Partial<PresetRow> & { id: string }): PresetRow {
  return {
    harnessId: "claude",
    name: "Work",
    description: null,
    envJson: null,
    flagsJson: null,
    settingsJson: null,
    configIsolation: 0,
    restartOnExit: 0,
    createdAt: "2026-09-13T00:00:00.000Z",
    updatedAt: "2026-09-13T00:00:00.000Z",
    ...overrides,
  };
}

const CLAUDE_PRESETS = [presetRow({ id: "preset-1", name: "Work" }), presetRow({ id: "preset-2", name: "Deep" })];
const PI_PRESET = presetRow({ id: "pi-1", harnessId: "pi", name: "Pi fast" });
/** A preset id no list resolves (deleted, or another user's). */
const GONE = "00000000-0000-4000-8000-000000000000";

interface MockOptions {
  /** Rows GET /api/presets answers with (default: the two claude presets) */
  presets?: PresetRow[];
  /** The presets query never answers — pins the in-flight posture */
  presetsHang?: boolean;
  /** GET /api/presets fails — pins the errored posture */
  presetsFail?: boolean;
  /** Status/body the restart POST answers with (default: 200 { id }) */
  restart?: { status: number; body: unknown };
  /** When set, the restart POST resolves only when the caller resolves it */
  restartGate?: Promise<void>;
}

/** Records fetch calls (JSON bodies parsed); presets and restart answer per
 *  options. The presets list defaults to the two same-harness rows. */
function mockFetch(opts: MockOptions = {}) {
  const calls: { method: string; url: string; body: unknown }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    calls.push({
      method,
      url: url.pathname,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    if (url.pathname === "/api/presets") {
      if (opts.presetsHang) return new Promise<Response>(() => {});
      if (opts.presetsFail) return Promise.resolve(new Response(JSON.stringify({ message: "boom" }), { status: 500 }));
      return Promise.resolve(new Response(JSON.stringify(opts.presets ?? CLAUDE_PRESETS)));
    }
    if (url.pathname === "/api/subshells/id-1/restart" && method === "POST") {
      if (opts.restart)
        return Promise.resolve(new Response(JSON.stringify(opts.restart.body), { status: opts.restart.status }));
      const response = () => Promise.resolve(new Response(JSON.stringify({ id: "id-1" })));
      return opts.restartGate ? opts.restartGate.then(response) : response();
    }
    return Promise.resolve(new Response(JSON.stringify({ ok: true })));
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

/** Flush pending query/mutation updates inside act() (the repo-wide pattern). */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
}

const trigger = () => screen.getByRole("combobox", { name: "Preset" });
const confirmButton = () => screen.getByRole("button", { name: /Switch and restart|Switching/ });

/** Renders the dialog (no router needed: it navigates nowhere) and settles
 *  the presets query unless it is hung. */
async function renderDialog(subshell: SubshellView, onOpenChange = (_: boolean) => {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SwitchPresetDialog subshell={subshell} open onOpenChange={onOpenChange} />
    </QueryClientProvider>,
  );
  await settle();
}

/** Opens the Base UI select popup: a click on the trigger opens it (keyboard
 *  events on the trigger do not), measured against this Base UI version. */
async function openSelect(): Promise<void> {
  fireEvent.click(trigger());
  await waitFor(() => expect(screen.getAllByRole("option").length).toBeGreaterThan(0));
}

/** Presses an option the way Base UI's press path requires: a bare
 *  `fireEvent.click` never reaches `onValueChange` under happy-dom; the
 *  pointer triple (down, up, click) does. */
async function pressOption(name: string): Promise<void> {
  const option = screen.getByRole("option", { name });
  fireEvent.pointerDown(option);
  fireEvent.pointerUp(option);
  fireEvent.click(option);
  await settle();
}

function optionNames(): string[] {
  return screen.getAllByRole("option").map((o) => o.textContent ?? "");
}

describe("SwitchPresetDialog", () => {
  afterEach(cleanup);

  it("starts on the row's current preset, named not ided", async () => {
    const { restore } = mockFetch();
    try {
      await renderDialog(makeSubshell());
      await waitFor(() => expect(trigger().textContent).toContain("Work"));
    } finally {
      restore();
    }
  });

  it("a presetless row starts on None", async () => {
    const { restore } = mockFetch();
    try {
      await renderDialog(makeSubshell({ presetId: null }));
      await waitFor(() => expect(trigger().textContent).toContain("None"));
    } finally {
      restore();
    }
  });

  it("offers None first, then only the row's harness's presets", async () => {
    const { restore } = mockFetch({ presets: [...CLAUDE_PRESETS, PI_PRESET] });
    try {
      await renderDialog(makeSubshell());
      await openSelect();
      expect(optionNames().slice(0, 3)).toEqual(["None", "Work", "Deep"]);
      expect(screen.queryByRole("option", { name: "Pi fast" })).toBeNull();
    } finally {
      restore();
    }
  });

  it("a preset the list cannot resolve reads None, never the uuid", async () => {
    const { restore } = mockFetch({ presets: [] });
    try {
      await renderDialog(makeSubshell({ presetId: GONE }));
      await waitFor(() => expect(trigger().textContent).toContain("None"));
      expect(screen.queryByText(GONE)).toBeNull();
    } finally {
      restore();
    }
  });

  it("while the list is in flight the raw id stands and the confirm is inert", async () => {
    const { restore } = mockFetch({ presetsHang: true });
    try {
      await renderDialog(makeSubshell({ presetId: "preset-1" }));
      expect(trigger().textContent).toContain("preset-1");
      expect(trigger().hasAttribute("disabled")).toBe(true);
      expect(confirmButton().hasAttribute("disabled")).toBe(true);
    } finally {
      restore();
    }
  });

  it("a failed presets fetch says so, and the confirm stays inert", async () => {
    const { restore } = mockFetch({ presetsFail: true });
    try {
      await renderDialog(makeSubshell());
      // The errored posture looks like the in-flight one (data stays
      // undefined); the sentence is what separates them.
      expect(await screen.findByText(/could not load presets/i)).toBeDefined();
      expect(trigger().hasAttribute("disabled")).toBe(true);
      expect(confirmButton().hasAttribute("disabled")).toBe(true);
    } finally {
      restore();
    }
  });

  it("confirming an unchanged selection still restarts with that preset", async () => {
    const { calls, restore } = mockFetch();
    try {
      const openArgs: boolean[] = [];
      await renderDialog(makeSubshell(), (o) => openArgs.push(o));
      fireEvent.click(confirmButton());
      await waitFor(() =>
        expect(calls).toContainEqual({
          method: "POST",
          url: "/api/subshells/id-1/restart",
          body: { presetId: "preset-1" },
        }),
      );
      await waitFor(() => expect(openArgs).toContain(false));
    } finally {
      restore();
    }
  });

  it("None posts an explicit null, not an omitted key", async () => {
    const { calls, restore } = mockFetch();
    try {
      await renderDialog(makeSubshell({ presetId: null }));
      fireEvent.click(confirmButton());
      await waitFor(() =>
        expect(calls).toContainEqual({ method: "POST", url: "/api/subshells/id-1/restart", body: { presetId: null } }),
      );
    } finally {
      restore();
    }
  });

  it("a row whose preset vanished posts null too", async () => {
    const { calls, restore } = mockFetch({ presets: CLAUDE_PRESETS });
    try {
      await renderDialog(makeSubshell({ presetId: GONE }));
      await waitFor(() => expect(trigger().textContent).toContain("None"));
      fireEvent.click(confirmButton());
      await waitFor(() =>
        expect(calls).toContainEqual({ method: "POST", url: "/api/subshells/id-1/restart", body: { presetId: null } }),
      );
    } finally {
      restore();
    }
  });

  it("choosing None on a preset row posts the explicit null", async () => {
    const { calls, restore } = mockFetch();
    try {
      await renderDialog(makeSubshell());
      await openSelect();
      await pressOption("None");
      expect(trigger().textContent).toContain("None");
      fireEvent.click(confirmButton());
      await waitFor(() =>
        expect(calls).toContainEqual({ method: "POST", url: "/api/subshells/id-1/restart", body: { presetId: null } }),
      );
    } finally {
      restore();
    }
  });

  it("choosing another preset of the same harness posts its id", async () => {
    const { calls, restore } = mockFetch();
    try {
      await renderDialog(makeSubshell());
      await openSelect();
      await pressOption("Deep");
      expect(trigger().textContent).toContain("Deep");
      fireEvent.click(confirmButton());
      await waitFor(() =>
        expect(calls).toContainEqual({
          method: "POST",
          url: "/api/subshells/id-1/restart",
          body: { presetId: "preset-2" },
        }),
      );
    } finally {
      restore();
    }
  });

  it("a refused swap keeps the dialog open and says why, inline", async () => {
    const { restore } = mockFetch({
      restart: { status: 400, body: { message: "that preset is not yours", code: "INVALID_PRESET" } },
    });
    try {
      let closed = false;
      await renderDialog(makeSubshell(), (o) => {
        closed = closed || !o;
      });
      fireEvent.click(confirmButton());
      // `ApiError` prefixes the status to the server's structured message.
      expect(await screen.findByText(/that preset is not yours/)).toBeDefined();
      expect(closed).toBe(false);
      expect(screen.getByRole("dialog")).toBeDefined();
    } finally {
      restore();
    }
  });

  it("the confirm locks while the restart is in flight, and the row lands closed", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { restore } = mockFetch({ restartGate: gate });
    try {
      const openArgs: boolean[] = [];
      await renderDialog(makeSubshell(), (o) => openArgs.push(o));
      fireEvent.click(confirmButton());
      await waitFor(() => expect(screen.getByText("Switching…")).toBeDefined());
      expect(confirmButton().hasAttribute("disabled")).toBe(true);
      expect(screen.getByRole("button", { name: "Cancel" }).hasAttribute("disabled")).toBe(true);
      expect(openArgs).not.toContain(false);
      release();
      await waitFor(() => expect(openArgs).toContain(false));
    } finally {
      restore();
    }
  });

  it("says what the act is: title, one honest sentence, no em dashes", async () => {
    const { restore } = mockFetch();
    try {
      await renderDialog(makeSubshell());
      expect(screen.getByText("Switch preset")).toBeDefined();
      expect(screen.getByText("The session restarts with the new preset's settings.")).toBeDefined();
      const copy =
        (screen.getByRole("dialog").textContent ?? "") +
        (screen.getByRole("button", { name: "Switch and restart" }).textContent ?? "");
      expect(copy).not.toContain("—");
    } finally {
      restore();
    }
  });
});
