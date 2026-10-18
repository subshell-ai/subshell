import { expect, test } from "@playwright/test";
import { ADMIN_STATE } from "./helpers";

test.use({ storageState: ADMIN_STATE });

test("dashboard searches request filtered rows after typing pauses", async ({ page }) => {
  const prompt = await page.request.post("/api/prompts", {
    data: { description: "Filter fixture", body: "unusual%&needle" },
  });
  expect(prompt.ok()).toBe(true);
  const { id: promptId } = await prompt.json();
  const stack = await page.request.post("/api/prompts/stacks", {
    data: { label: "Filter stack", items: [{ promptId }] },
  });
  expect(stack.ok()).toBe(true);
  const { id: stackId } = await stack.json();
  const subshell = await page.request.post("/api/subshells", {
    data: { name: "Filter subshell", harnessId: "pi", workingDir: "/tmp" },
  });
  expect(subshell.ok()).toBe(true);
  const { id: subshellId } = await subshell.json();
  try {
    await page.goto("/prompts");
    const search = page.getByRole("textbox", { name: "Search prompts and stacks" });
    const calls: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname === "/api/prompts" && url.searchParams.has("q")) calls.push(url.searchParams.get("q") ?? "");
    });
    const response = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === "/api/prompts" && new URL(r.url()).searchParams.get("q") === "unusual%&needle",
    );
    await search.pressSequentially("unusual%&needle", { delay: 10 });
    expect((await response).ok()).toBe(true);
    expect(calls).toEqual(["unusual%&needle"]);
    await expect(page.getByRole("button", { name: "Filter fixture", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Filter stack", exact: true })).toBeVisible();
    await search.fill("no-such-prompt");
    await expect(page.getByText(/No .*match/).first()).toBeVisible();
    await expect(search).toBeVisible();
    await search.clear();
    await expect(page.getByRole("button", { name: "Filter fixture", exact: true })).toBeVisible();

    await page.goto("/nodes");
    const nodesResponse = page.waitForResponse(
      (r) => new URL(r.url()).pathname === "/api/nodes" && new URL(r.url()).searchParams.get("q") === "no-such-node",
    );
    await page.getByRole("searchbox", { name: "Search nodes" }).fill("no-such-node");
    expect((await nodesResponse).ok()).toBe(true);
    await expect(page.getByText("No nodes match")).toBeVisible();
    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect(page.getByRole("link", { name: "Server", exact: true })).toBeVisible();

    // The list with this search box lives at `/subshells` now; `/` became a
    // direction (spec 2026-10-17) and navigates to a workspace, whose rail
    // search is a different control.
    await page.goto("/subshells");
    const subshellResponse = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === "/api/subshells" && new URL(r.url()).searchParams.get("q") === "Filter subshell",
    );
    await page.getByRole("textbox", { name: "Search subshells" }).fill("Filter subshell");
    expect((await subshellResponse).ok()).toBe(true);
    await expect(page.getByText("Filter subshell", { exact: true }).first()).toBeVisible();
    // A rename changes search membership through the live feed, without a new keystroke.
    const renamed = await page.request.patch(`/api/subshells/${subshellId}/name`, {
      data: { name: "Renamed fixture" },
    });
    expect(renamed.ok()).toBe(true);
    await expect(page.getByText(/No subshells match/)).toBeVisible();
  } finally {
    await page.request.delete(`/api/subshells/${subshellId}`);
    await page.request.delete(`/api/prompts/stacks/${stackId}`);
    await page.request.delete(`/api/prompts/${promptId}`);
  }
});
