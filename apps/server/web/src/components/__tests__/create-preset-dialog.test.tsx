import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CreatePresetDialog } from "@/components/presets/create-preset-dialog";
import { type PresetFormValue, presetFormFromRow } from "@/lib/preset-form";
import type { PresetRow } from "@/types/preset";

/** A stored preset with one env var, one flag, and auto-restart on. */
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

/** Records every fetch (JSON bodies parsed); the catalog answers with one
 *  agent so the locked posture has a name to show; the POST echoes a row. */
function mockFetch() {
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
    if (url.pathname === "/api/plugins")
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
            ],
          }),
        ),
      );
    if (url.pathname === "/api/presets" && method === "POST")
      return Promise.resolve(new Response(JSON.stringify({ ...SOURCE, id: "new-1" })));
    return Promise.resolve(new Response("{}"));
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

/** Renders the dialog (no router needed) settled, so the catalog and schema
 *  reads have landed before the caller asserts (repo pattern from
 *  clone-subshell-dialog.test.tsx). */
async function renderDialog(props: { lockedHarness?: string; initialForm?: PresetFormValue }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <CreatePresetDialog open onOpenChange={() => {}} {...props} />
    </QueryClientProvider>,
  );
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
}

describe("CreatePresetDialog", () => {
  afterEach(cleanup);

  it("an initialForm seeds the form, keeps the locked agent, and titles the dialog Clone preset", async () => {
    const { calls, restore } = mockFetch();
    try {
      await renderDialog({
        lockedHarness: SOURCE.harnessId,
        initialForm: { ...presetFormFromRow(SOURCE), name: "Work (2)" },
      });
      expect(await screen.findByRole("heading", { name: "Clone preset" })).toBeDefined();
      expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Work (2)");
      // Locked posture: the agent shows as static text naming itself.
      expect(screen.getByText("Claude Code")).toBeDefined();
      fireEvent.click(screen.getByRole("button", { name: "Create preset" }));
      await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url === "/api/presets")).toBe(true));
      const post = calls.find((c) => c.method === "POST" && c.url === "/api/presets");
      // The payload is a plain create carrying the seeded fields: harness
      // preserved, name suggested, env/flags/restart copied, no description.
      expect(post?.body).toMatchObject({
        harnessId: "claude-code",
        name: "Work (2)",
        env: { ANTHROPIC_MODEL: "sonnet" },
        flags: ["--effort", "xhigh"],
        restartOnExit: true,
      });
    } finally {
      restore();
    }
  });

  it("without initialForm the create posture and its title are untouched", async () => {
    const { restore } = mockFetch();
    try {
      await renderDialog({});
      expect(await screen.findByRole("heading", { name: "Create preset" })).toBeDefined();
      expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("");
    } finally {
      restore();
    }
  });
});
