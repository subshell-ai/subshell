import { afterEach, expect, it } from "bun:test";
import {
  armWorkspacePreview,
  flushWorkspacePreview,
  onWorkspacePreviewRequest,
  previewPanelId,
  previewParentId,
  requestWorkspacePreview,
} from "../workspace-preview";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
});
it("keeps a stable preview identity tied to one parent pane", () => {
  expect(previewParentId(previewPanelId("pane1", { kind: "screen" }))).toBe("pane1");
  expect(previewParentId("pane1")).toBeNull();
});
it("opens or focuses the preview only when a workspace accepts the request", () => {
  expect(requestWorkspacePreview("a")).toBe(false);
  const seen: string[] = [];
  dispose = onWorkspacePreviewRequest((id) => {
    seen.push(id);
    return id === "a";
  });
  expect(requestWorkspacePreview("b")).toBe(false);
  expect(requestWorkspacePreview("a")).toBe(true);
  expect(seen).toEqual(["b", "a"]);
  dispose();
  expect(requestWorkspacePreview("a")).toBe(false);
});

it("carries a picker shortcut through navigation until the workspace can accept it", () => {
  const seen: string[] = [];
  let ready = false;
  armWorkspacePreview("pane1");
  dispose = onWorkspacePreviewRequest((id, view) => {
    if (!ready) return false;
    seen.push(`${id}:${view?.kind}`);
    return true;
  });
  expect(seen).toEqual([]);
  ready = true;
  flushWorkspacePreview();
  flushWorkspacePreview();
  expect(seen).toEqual(["pane1:undefined"]);
});
