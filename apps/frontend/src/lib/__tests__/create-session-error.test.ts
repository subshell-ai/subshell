import { describe, expect, it } from "bun:test";
import { ApiError } from "@/lib/api";
import { createSessionErrorMessage } from "@/lib/create-session-error";

/**
 * Launch-failure copy (spec 2026-08-31 §6.6): the create path answers 409
 * NODE_OFFLINE when a picked (or profile-pinned) agent node has no live
 * connection; NODE_UNREACHABLE is the sibling the node RPC family produces
 * when the agent accepts but never answers. Everything else — the 404 for an
 * invisible node (deliberately NOT a 403, §2), harness-unusable-on-that-node
 * 409s, plain network failures — keeps its own message, so the copy here is
 * only ever the actionable node-action line.
 */
describe("createSessionErrorMessage", () => {
  it("turns a 409 NODE_OFFLINE into the actionable node line", () => {
    const err = new ApiError(409, "Node is offline", { code: "NODE_OFFLINE", errId: "e1" });
    expect(createSessionErrorMessage(err, "Failed to create session")).toBe(
      "That node is offline — start its subshell or pick another node.",
    );
  });

  it("turns a NODE_UNREACHABLE into the retry-soon line", () => {
    const err = new ApiError(409, "Node did not respond", { code: "NODE_UNREACHABLE" });
    expect(createSessionErrorMessage(err, "Failed to create session")).toBe(
      "The node did not answer — try again shortly.",
    );
  });

  it("keeps the server's own message for every other failure shape", () => {
    // 404 node_not_found — invisible nodes 404 (never 403): the fallback
    // text must carry the API line verbatim, no node-offline coaching.
    const gone = new ApiError(404, "Node not found", { code: "NOT_FOUND_ERROR" });
    expect(createSessionErrorMessage(gone, "Failed to create session")).toBe("API 404: Node not found");
    // A 409 that carries no machine code at all (e.g. harness-unusable):
    // its message is already node-aware server-side.
    const harness = new ApiError(409, "That harness is disabled or not installed on that node");
    expect(createSessionErrorMessage(harness, "Failed to create session")).toBe(
      "API 409: That harness is disabled or not installed on that node",
    );
    // Anything that is not an ApiError keeps the historical fallback chain.
    expect(createSessionErrorMessage(new Error("boom"), "Failed to create session")).toBe("boom");
    expect(createSessionErrorMessage(null, "Failed to create session")).toBe("Failed to create session");
  });
});
