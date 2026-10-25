import { afterEach, expect, it } from "bun:test";
import { act, cleanup, render, screen } from "@testing-library/react";
import { publishWorkspacePreviews } from "@/lib/workspace-preview";
import type { SubshellView } from "@/types/subshell";
import { WorkspacePreview } from "../workspace-preview";

afterEach(() => {
  cleanup();
  publishWorkspacePreviews([], null);
});
it("hides the terminal's shortcut while its preview tab is open and restores it on close", () => {
  render(<WorkspacePreview subshell={{ id: "s1" } as SubshellView} active />);
  expect(screen.getByRole("button", { name: "Web previews & screens" })).toBeTruthy();
  act(() =>
    publishWorkspacePreviews(
      [{ id: "preview:p1:screen", paneId: "p1", subshellId: "s1", workspaceId: "w1", view: { kind: "screen" } }],
      "preview:p1:screen",
    ),
  );
  expect(screen.queryByRole("button", { name: "Web previews & screens" }) === null).toBe(true);
  act(() => publishWorkspacePreviews([], null));
  expect(screen.getByRole("button", { name: "Web previews & screens" })).toBeTruthy();
});
