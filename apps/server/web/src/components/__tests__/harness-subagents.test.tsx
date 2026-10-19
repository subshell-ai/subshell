import { afterEach, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { setFetchRouter } from "@/test-setup";
import { HarnessSubagentTitle } from "../harness-subagents";

afterEach(cleanup);

test("the compact header uses confirmed native selection and returns through the parent endpoint", async () => {
  const state = {
    pane: {
      agents: [{ id: "child", name: "Review changes", status: "running" }],
      selectedId: "child",
      canSelect: true,
    },
  };
  const sent: unknown[] = [];
  setFetchRouter(async (url, init) => {
    if (String(url).endsWith("/subagents/select")) {
      sent.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true });
    }
    return Response.json(state);
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["harness-subagents"], state);
  render(
    <QueryClientProvider client={client}>
      <HarnessSubagentTitle id="pane" parentName="Build feature" />
    </QueryClientProvider>,
  );
  expect(screen.getByText("Review changes")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Subagent of Build feature" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Back to main agent" }));
  await waitFor(() => expect(sent).toEqual([{ agentId: null }]));
  // A queued command is not confirmation that the harness changed views.
  expect(screen.getByText("Review changes")).toBeTruthy();
  client.clear();
});
