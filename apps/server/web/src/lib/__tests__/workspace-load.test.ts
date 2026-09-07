import { describe, expect, it } from "bun:test";
import { ApiError, NetworkError } from "@/lib/api";
import { workspaceLoad } from "@/lib/workspace-load";

const detail = { workspace: { id: "w1" } };
const net = new NetworkError(new TypeError("down"));

describe("workspaceLoad", () => {
  it("holds loading on first paint", () => {
    expect(workspaceLoad({ isLoading: true, detail: undefined, error: null })).toBe("loading");
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
