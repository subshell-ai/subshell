import { expect, it } from "bun:test";
import { parseWorkspacePreviewId, workspacePreviewId } from "./workspace-preview";

it("gives each resource its own stable identity with the same parent", () => {
  const views = [
    { kind: "screen" },
    { kind: "browser" },
    { kind: "app", port: 41430 },
    { kind: "app", port: 8080 },
  ] as const;
  const ids = views.map((view) => workspacePreviewId("pane", view));
  expect(new Set(ids).size).toBe(4);
  ids.forEach((id, i) => {
    expect(parseWorkspacePreviewId(id)).toEqual({ paneId: "pane", view: views[i] });
  });
});
it("rejects malformed and legacy identities instead of trusting their parameters", () => {
  for (const id of [
    "preview:pane",
    "preview:pane:app:0",
    "preview:pane:app:65536",
    "preview:pane:app:080",
    "preview:pane:screen:80",
    "preview:pane:app:80:screen",
    "preview::screen",
  ])
    expect(parseWorkspacePreviewId(id)).toBeNull();
});
