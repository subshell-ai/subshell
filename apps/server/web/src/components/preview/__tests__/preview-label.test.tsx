import { afterEach, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { previewInfoQueryKey } from "@/hooks/use-subshell-preview";
import { PreviewLabel } from "../preview-label";

afterEach(cleanup);
it("updates a preview label from cached discovery and falls back to its port", async () => {
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <PreviewLabel subshellId="pane" view={{ kind: "app", port: 3401 }} />
    </QueryClientProvider>,
  );
  expect(screen.getByText("App · 3401")).toBeTruthy();
  act(() => {
    client.setQueryData(previewInfoQueryKey("pane"), { ports: [{ port: 3401, title: "Project dashboard" }] });
  });
  await waitFor(() => expect(screen.getByTitle("Project dashboard · 3401")).toBeTruthy());
  expect(client.isFetching()).toBe(0);
  act(() => {
    client.clear();
  });
});

it("keeps the owning subshell in a titled tab's accessible name", () => {
  const client = new QueryClient();
  client.setQueryData(previewInfoQueryKey("pane"), { ports: [{ port: 3401, title: "Dashboard" }] });
  render(
    <QueryClientProvider client={client}>
      <button type="button">
        <PreviewLabel subshellId="pane" view={{ kind: "app", port: 3401 }} suffix="Feature work" />
      </button>
    </QueryClientProvider>,
  );
  expect(screen.getByRole("button", { name: "Dashboard · 3401 · Feature work" })).toBeTruthy();
});
