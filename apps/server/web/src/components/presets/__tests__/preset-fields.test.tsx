import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { type PresetEntryMode, PresetFields } from "@/components/presets/preset-fields";
import type { InstancePluginRow } from "@/hooks/use-instance-plugins";
import { emptyPresetForm, type PresetFormValue } from "@/lib/preset-form";

/**
 * The preset editor's AGENT block. The Node pin block these tests used to
 * carry is gone with the pin (spec 2026-09-13 §2.3); what is pinned here is
 * the frozen id/copy surface: `preset-harness` + "Agent" unlocked, static
 * text locked, the progressive-disclosure gate, and the single-usable-agent
 * auto-pick.
 */
function plugin(p: {
  id: string;
  name?: string;
  installed?: boolean;
  enabled?: boolean;
  broken?: string;
  binary?: string;
}): InstancePluginRow {
  return {
    id: p.id,
    name: p.name ?? p.id,
    description: "",
    installed: p.installed ?? true,
    enabled: p.enabled ?? true,
    builtIn: true,
    ...(p.broken !== undefined ? { broken: p.broken } : {}),
    ...(p.binary !== undefined ? { binary: p.binary } : {}),
  };
}

const CLAUDE = plugin({ id: "claude-code", name: "Claude Code", binary: "claude" });
const PI = plugin({ id: "pi", name: "Pi" });

function mockFetch(plugins: InstancePluginRow[]) {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown) => {
    const path = new URL(String(input), "http://localhost").pathname;
    if (path === "/api/plugins") return Promise.resolve(new Response(JSON.stringify({ plugins })));
    return Promise.resolve(new Response(JSON.stringify({})));
  }) as typeof fetch;
  return () => (globalThis.fetch = original);
}

/** Stateful controlled parent (like the create dialog / edit page). */
function renderEditor(
  initial: PresetFormValue,
  seen: PresetFormValue[],
  lockedHarness?: string,
  defaultEntryMode?: PresetEntryMode,
) {
  function Wrapper() {
    const [value, setValue] = useState(initial);
    return (
      <PresetFields
        value={value}
        lockedHarness={lockedHarness}
        defaultEntryMode={defaultEntryMode}
        onChange={(v) => {
          seen.push(v);
          setValue(v);
        }}
      />
    );
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Wrapper />
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe("PresetFields agent select (unlocked)", () => {
  it("carries the frozen ids and copy, and hides everything else until an agent is chosen", async () => {
    const restore = mockFetch([CLAUDE, PI]);
    try {
      const seen: PresetFormValue[] = [];
      renderEditor(emptyPresetForm(), seen);
      expect(await screen.findByText("Agent")).toBeDefined();
      expect(document.getElementById("preset-harness")).not.toBeNull();
      expect(screen.getByText("Which agent CLI subshells started with this preset will run.")).toBeDefined();
      expect(screen.getByText("Select an agent to see the rest of the options.")).toBeDefined();
      // Progressive disclosure: Name/Env/Flags/restart are not on screen yet.
      expect(document.getElementById("preset-name")).toBeNull();
      expect(screen.queryByText("Name")).toBeNull();
    } finally {
      restore();
    }
  });

  it("reveals the fields with the frozen ids once an agent is held", async () => {
    const restore = mockFetch([CLAUDE]);
    try {
      renderEditor({ ...emptyPresetForm(), harnessId: "claude-code" }, []);
      await screen.findByText("Agent");
      expect(document.getElementById("preset-name")).not.toBeNull();
      expect(document.getElementById("preset-restart")).not.toBeNull();
      // Creating opens on the command view; the row editors are one click away.
      expect(document.getElementById("preset-command")).not.toBeNull();
      expect(document.getElementById("preset-env")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Custom command" }));
      expect(document.getElementById("preset-env")).not.toBeNull();
      expect(document.getElementById("preset-flags")).not.toBeNull();
      expect((document.getElementById("preset-name") as HTMLInputElement).placeholder).toBe("e.g. Fast model");
      // The gated hint is gone.
      expect(screen.queryByText("Select an agent to see the rest of the options.")).toBeNull();
    } finally {
      restore();
    }
  });

  it("auto-picks the ONLY usable agent rather than forcing a one-option decision", async () => {
    const restore = mockFetch([plugin({ id: "gone", name: "Gone", installed: false }), CLAUDE]);
    try {
      const seen: PresetFormValue[] = [];
      renderEditor(emptyPresetForm(), seen);
      await waitFor(() => expect(seen.some((v) => v.harnessId === "claude-code")).toBe(true));
    } finally {
      restore();
    }
  });

  it("does NOT auto-pick when several are usable — that is a real decision", async () => {
    const restore = mockFetch([CLAUDE, PI]);
    try {
      const seen: PresetFormValue[] = [];
      renderEditor(emptyPresetForm(), seen);
      await screen.findByText("Agent");
      // Let any (wrong) effect fire, then check nothing was written.
      await new Promise((r) => setTimeout(r, 60));
      expect(seen.filter((v) => v.harnessId !== "")).toHaveLength(0);
    } finally {
      restore();
    }
  });
});

describe("PresetFields locked agent", () => {
  it("renders the agent as static text with the lock explanation, and no select", async () => {
    const restore = mockFetch([CLAUDE]);
    try {
      renderEditor({ ...emptyPresetForm(), harnessId: "claude-code", name: "P" }, [], "claude-code");
      expect(
        await screen.findByText("An agent is chosen when a preset is created and cannot change afterwards."),
      ).toBeDefined();
      // The name shows; the control does not.
      expect(screen.getByText("Claude Code")).toBeDefined();
      expect(document.getElementById("preset-harness")).toBeNull();
      // The rest of the form is already open (the locked agent is always set).
      expect(document.getElementById("preset-name")).not.toBeNull();
    } finally {
      restore();
    }
  });

  it("falls back to the id when the catalog cannot name the locked harness", async () => {
    const restore = mockFetch([]); // catalog knows nothing
    try {
      renderEditor({ ...emptyPresetForm(), harnessId: "acme", name: "P" }, [], "acme");
      expect(await screen.findByText("acme")).toBeDefined();
    } finally {
      restore();
    }
  });
});

/**
 * The two entry modes (2026-09-18). What is pinned here is that they are two
 * VIEWS of one set of rows — a paste reaches the row editors, a row edit
 * reaches the command text — plus the two things only this panel says: that
 * the command name is ignored, and when it is not the selected agent's.
 */
describe("PresetFields entry modes", () => {
  const held = { ...emptyPresetForm(), harnessId: "claude-code" };

  function pasteInto(text: string) {
    const box = screen.getByRole("textbox", { name: "Paste a command" });
    fireEvent.change(box, { target: { value: text } });
    return box as HTMLTextAreaElement;
  }

  it("parses a pasted command into the rows the other view edits", async () => {
    const restore = mockFetch([CLAUDE]);
    try {
      const seen: PresetFormValue[] = [];
      renderEditor(held, seen);
      await screen.findByText("Agent");
      pasteInto('ANTHROPIC_MODEL=sonnet \\\n claude --effort "very high"');

      const last = seen[seen.length - 1];
      expect(last.envRows).toEqual([{ key: "ANTHROPIC_MODEL", value: "sonnet" }]);
      expect(last.flagRows).toEqual([{ flag: "--effort", value: "very high" }]);

      // The preview states what was read, counts first.
      expect(screen.getByText("1 env var · 1 flag")).toBeDefined();

      // And the row editors hold it — this is one set of values, not two.
      fireEvent.click(screen.getByRole("button", { name: "Custom command" }));
      expect(screen.getByRole("combobox", { name: "Variable 1" })).toHaveProperty("value", "ANTHROPIC_MODEL");
      expect(screen.getByRole("combobox", { name: "Flag 1" })).toHaveProperty("value", "--effort");
    } finally {
      restore();
    }
  });

  it("renders the rows back as a command when the command view is re-entered", async () => {
    const restore = mockFetch([CLAUDE]);
    try {
      renderEditor(
        {
          ...held,
          envRows: [{ key: "ANTHROPIC_MODEL", value: "sonnet" }],
          flagRows: [{ flag: "--effort", value: "xhigh" }],
        },
        [],
        undefined,
        "custom",
      );
      await screen.findByText("Agent");
      fireEvent.click(screen.getByRole("button", { name: "Paste command" }));
      const box = screen.getByRole("textbox", { name: "Paste a command" }) as HTMLTextAreaElement;
      expect(box.value).toBe("ANTHROPIC_MODEL=sonnet \\\nclaude --effort xhigh");
    } finally {
      restore();
    }
  });

  it("names the pasted command and says it is ignored", async () => {
    const restore = mockFetch([CLAUDE]);
    try {
      renderEditor(held, []);
      await screen.findByText("Agent");
      pasteInto("/usr/local/bin/claude --effort xhigh");
      expect(
        screen.getByText("“claude” is ignored: subshells run Claude Code as resolved on the machine they start on."),
      ).toBeDefined();
    } finally {
      restore();
    }
  });

  it("warns when the pasted command is not the selected agent's", async () => {
    const restore = mockFetch([CLAUDE]);
    try {
      renderEditor(held, []);
      await screen.findByText("Agent");
      pasteInto("codex --effort xhigh");
      expect(
        screen.getByText("“codex” isn't Claude Code's command — the agent selected above is what runs."),
      ).toBeDefined();
    } finally {
      restore();
    }
  });

  it("keeps the rows and shows the message when the text cannot be read", async () => {
    const restore = mockFetch([CLAUDE]);
    try {
      const seen: PresetFormValue[] = [];
      renderEditor(held, seen);
      await screen.findByText("Agent");
      pasteInto("FOO=bar claude --effort xhigh");
      const good = seen[seen.length - 1];
      pasteInto('FOO=bar claude --p "oops');
      expect(screen.getByText(/quote/i)).toBeDefined();
      // Nothing was written over the last good parse.
      expect(seen[seen.length - 1]).toEqual(good);
    } finally {
      restore();
    }
  });

  it("opens on the row editors when the caller asks for them (the edit page)", async () => {
    const restore = mockFetch([CLAUDE]);
    try {
      renderEditor(held, [], "claude-code", "custom");
      await screen.findByText("Agent");
      expect(document.getElementById("preset-env")).not.toBeNull();
      expect(document.getElementById("preset-command")).toBeNull();
    } finally {
      restore();
    }
  });
});
