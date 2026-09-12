import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { deploymentView } from "@/components/__tests__/helpers/deployment-view";
import { ServerLogCard } from "@/components/service/server-log-card";
import type { ServerDeployment } from "@/types/server-deployment";

const restore: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const undo of restore.splice(0)) undo();
});

/** Serves one log body for `GET /api/admin/server/logs`. */
function stubLogs(body: unknown) {
  const original = globalThis.fetch;
  restore.push(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = (async (_input: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof globalThis.fetch;
}

function renderCard(view: ServerDeployment) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ServerLogCard view={view} enabled />
    </QueryClientProvider>,
  );
}

describe("ServerLogCard", () => {
  it("renders each line with its level's colour", async () => {
    stubLogs({
      lines: [
        { ts: "2026-09-12T10:00:00.000Z", level: "info", message: "listening" },
        { ts: "2026-09-12T10:00:01.000Z", level: "error", message: "boom", data: { code: 7 } },
      ],
      file: "/c/logs/server.log",
      bytes: 120,
      capBytes: 204_800,
    });
    renderCard(deploymentView());
    const errorLine = await waitFor(() => screen.getByText(/boom/));
    expect(errorLine.className).toContain("text-destructive");
    // Structured context rides the same line rather than a second row.
    expect(errorLine.textContent).toContain('{"code":7}');
    expect(screen.getByText(/listening/).className).toBe("");
  });

  it("replaces the switch with a sentence while the environment forces debug logging", async () => {
    stubLogs({ lines: [], file: "/c/logs/server.log", bytes: 0, capBytes: 204_800 });
    const view = deploymentView();
    view.logging = { debug: true, source: "process env", file: "/c/logs/server.log", capBytes: 204_800 };
    renderCard(view);
    await waitFor(() => expect(screen.getByText(/Set by the environment \(SUBSHELL_DEBUG_LOGGING\)/)).toBeTruthy());
    expect(screen.queryByLabelText("Debug logging")).toBeNull();
  });
});
