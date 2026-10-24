import { afterEach, expect, it } from "bun:test";
import {
  armWorkspaceScreen,
  flushWorkspaceScreen,
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
  expect(previewParentId(previewPanelId("pane1"))).toBe("pane1");
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

it("carries a screen shortcut through navigation until the workspace can accept it", () => {
  const seen: string[] = [];
  let ready = false;
  armWorkspaceScreen("pane1");
  dispose = onWorkspacePreviewRequest((id, view) => {
    if (!ready) return false;
    seen.push(`${id}:${view}`);
    return true;
  });
  expect(seen).toEqual([]);
  ready = true;
  flushWorkspaceScreen();
  flushWorkspaceScreen();
  expect(seen).toEqual(["pane1:screen"]);
});
