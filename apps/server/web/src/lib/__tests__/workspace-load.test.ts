import { describe, expect, it } from "bun:test";
import { ApiError, NetworkError } from "@internal/node-admin";
import { workspaceAcceptsFiling, workspaceLoad } from "@/lib/workspace-load";

const detail = { workspace: { id: "w1" } };
const net = new NetworkError(new TypeError("down"));

describe("workspaceLoad", () => {
  it("holds loading on first paint", () => {
    expect(workspaceLoad({ isLoading: true, detail: undefined, error: null })).toBe("loading");
  });

  // Operator ruling 2026-09-27: a 404 that lands ON the cached detail is the
  // server's word "gone" (deleted from the rail / another tab / another
  // device), not the blip regression #9 protects — the route leaves on it.
  it("says deleted when a 404 lands on a cached detail", () => {
    expect(workspaceLoad({ isLoading: false, detail, error: new ApiError(404, "gone") })).toBe("deleted");
  });

  // Regression #9: an outage is the absence of an answer, not a deletion.
  it("holds loading while the server is unreachable (no answer at all)", () => {
    expect(workspaceLoad({ isLoading: false, detail: undefined, error: net })).toBe("loading");
    expect(workspaceLoad({ isLoading: false, detail: undefined, error: undefined })).toBe("loading");
  });

  it("says notFound ONLY for a real 404 answer", () => {
    expect(workspaceLoad({ isLoading: false, detail: undefined, error: new ApiError(404, "gone") })).toBe("notFound");
  });

  it("surfaces answered non-404 failures instead of hanging on Loading (401/403/500)", () => {
    for (const status of [401, 403, 500]) {
      expect(workspaceLoad({ isLoading: false, detail: undefined, error: new ApiError(status, "nope") })).toBe(
        "answeredError",
      );
    }
  });

  it("keeps last-good detail over ANY background error — a blip never unmounts the dock", () => {
    expect(workspaceLoad({ isLoading: false, detail, error: net })).toBe("ready");
    expect(workspaceLoad({ isLoading: false, detail, error: new ApiError(500, "busy") })).toBe("ready");
  });
});

describe("workspaceAcceptsFiling", () => {
  // The dead-page bug (review 2026-10-17): a page standing on a retired
  // workspace used to claim the launch target at mount, so the rail's "+ New
  // subshell" sent the dead id as `workspaceId`, the create pre-check refused
  // it, and NOTHING launched. Only an answered page may claim it.
  it("only a ready workspace claims the launch target", () => {
    expect(workspaceAcceptsFiling("ready")).toBe(true);
    for (const load of ["loading", "notFound", "answeredError", "deleted"] as const) {
      expect(workspaceAcceptsFiling(load)).toBe(false);
    }
  });
});
