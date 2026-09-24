import { describe, expect, it } from "bun:test";
import { routeOwnsBottomEdge } from "@/lib/app-frame";

describe("routeOwnsBottomEdge", () => {
  it("is true on the two full-height pages whose key bar pads the safe area itself", () => {
    expect(routeOwnsBottomEdge("/subshells/sess_123")).toBe(true);
    expect(routeOwnsBottomEdge("/workspaces/ws_9")).toBe(true);
    // No nested routes exist under either today; anything below a detail
    // page still inherits its full-height frame, so the prefix match is
    // the honest rule.
    expect(routeOwnsBottomEdge("/subshells/sess_123/extra")).toBe(true);
  });

  it("is false on the scrolling pages, list index included", () => {
    expect(routeOwnsBottomEdge("/subshells")).toBe(false);
    expect(routeOwnsBottomEdge("/subshells/")).toBe(false);
    expect(routeOwnsBottomEdge("/workspaces")).toBe(false);
    expect(routeOwnsBottomEdge("/")).toBe(false);
    expect(routeOwnsBottomEdge("/settings")).toBe(false);
    expect(routeOwnsBottomEdge("/settings/users")).toBe(false);
    expect(routeOwnsBottomEdge("/nodes/local/service")).toBe(false);
    expect(routeOwnsBottomEdge("/login")).toBe(false);
  });
});
