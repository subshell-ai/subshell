import { describe, expect, it } from "bun:test";
import { closeLandingFor } from "@/lib/subshell-close-landing";

/**
 * Closing the subshell whose detail page is on screen (`/subshells/<id>`) kills
 * the page under the viewer, and closing the last tab of the workspace on
 * screen (`/workspaces/<id>`) kills that page too, because the same DELETE
 * retires an emptied workspace. The chooser decides where the successful close
 * lands; the "Subshell not found" card stays what it was: the answer to a
 * deep link, not to your own act. A pane list with just the field the chooser
 * reads keeps the fixtures honest about what the decision depends on.
 */
const pane = (subshellId: string) => ({ subshellId });

describe("closeLandingFor", () => {
  it("lands on the last remaining pane when the closed one was on screen", () => {
    // The closed pane sits first in membership order; the LAST survivor wins.
    expect(
      closeLandingFor({
        currentRouteId: "s1",
        currentWorkspaceRouteId: null,
        closedId: "s1",
        holderWorkspaceId: "w1",
        workspacePanes: [pane("s1"), pane("s2"), pane("s3")],
      }),
    ).toEqual({ to: "/subshells/$id", params: { id: "s3" } });
  });

  it("skips the closed pane wherever it sits in membership order", () => {
    expect(
      closeLandingFor({
        currentRouteId: "s2",
        currentWorkspaceRouteId: null,
        closedId: "s2",
        holderWorkspaceId: "w1",
        workspacePanes: [pane("s1"), pane("s2"), pane("s3")],
      }),
    ).toEqual({ to: "/subshells/$id", params: { id: "s3" } });
    // Closed pane LAST in order → the new last survivor is the one before it.
    expect(
      closeLandingFor({
        currentRouteId: "s3",
        currentWorkspaceRouteId: null,
        closedId: "s3",
        holderWorkspaceId: "w1",
        workspacePanes: [pane("s1"), pane("s2"), pane("s3")],
      }),
    ).toEqual({ to: "/subshells/$id", params: { id: "s2" } });
  });

  it("the list is the landing when the close left no panes behind", () => {
    // The same DELETE retires an emptied workspace, so its id would be cold
    // by the time a navigation could use it. The list is the live page.
    expect(
      closeLandingFor({
        currentRouteId: "s1",
        currentWorkspaceRouteId: null,
        closedId: "s1",
        holderWorkspaceId: "w1",
        workspacePanes: [pane("s1")],
      }),
    ).toEqual({ to: "/subshells" });
  });

  it("lands on the subshells list when there is no workspace context at all", () => {
    expect(
      closeLandingFor({
        currentRouteId: "s1",
        currentWorkspaceRouteId: null,
        closedId: "s1",
        holderWorkspaceId: null,
        workspacePanes: [],
      }),
    ).toEqual({ to: "/subshells" });
  });

  it("is a no-op when the page on screen is not the closed subshell's", () => {
    // Standing on another pane's detail page: that page is alive, leave it.
    expect(
      closeLandingFor({
        currentRouteId: "s9",
        currentWorkspaceRouteId: null,
        closedId: "s1",
        holderWorkspaceId: "w1",
        workspacePanes: [pane("s1")],
      }),
    ).toBeNull();
    // The list page, `/`, anywhere the route names neither a subshell nor a workspace.
    expect(
      closeLandingFor({
        currentRouteId: null,
        currentWorkspaceRouteId: null,
        closedId: "s1",
        holderWorkspaceId: null,
        workspacePanes: [pane("s1")],
      }),
    ).toBeNull();
  });

  it("leaves the workspace page when the close retired the workspace on screen", () => {
    // The last tab closed, so the workspace is gone: the list is the honest
    // landing, not `/`, which would drop the viewer into an unrelated
    // workspace right after their act.
    expect(
      closeLandingFor({
        currentRouteId: null,
        currentWorkspaceRouteId: "w1",
        closedId: "s1",
        holderWorkspaceId: "w1",
        workspacePanes: [pane("s1")],
      }),
    ).toEqual({ to: "/subshells" });
  });

  it("stays on the workspace page while a tab survives the close", () => {
    // The page is alive; the dock reconciles the vanished tile in place.
    expect(
      closeLandingFor({
        currentRouteId: null,
        currentWorkspaceRouteId: "w1",
        closedId: "s1",
        holderWorkspaceId: "w1",
        workspacePanes: [pane("s1"), pane("s2")],
      }),
    ).toBeNull();
  });

  it("does not yank the workspace page when the emptied holder is elsewhere", () => {
    // A rail row menu closing a pane filed in ANOTHER workspace: the on-screen
    // workspace never held it, so the live page stays.
    expect(
      closeLandingFor({
        currentRouteId: null,
        currentWorkspaceRouteId: "w2",
        closedId: "s1",
        holderWorkspaceId: "w1",
        workspacePanes: [pane("s1")],
      }),
    ).toBeNull();
  });

  it("stays put on the list when the close retired its workspace off-screen", () => {
    // The holder emptied, but nothing `/subshells` names died, so nothing moves.
    expect(
      closeLandingFor({
        currentRouteId: null,
        currentWorkspaceRouteId: null,
        closedId: "s1",
        holderWorkspaceId: "w1",
        workspacePanes: [pane("s1")],
      }),
    ).toBeNull();
  });
});
