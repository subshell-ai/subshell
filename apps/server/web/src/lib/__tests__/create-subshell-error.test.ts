import { describe, expect, it } from "bun:test";
import { ApiError } from "@internal/node-admin";
import { createSubshellErrorMessage, isDisplayLaunchRefusal } from "@/lib/create-subshell-error";

/**
 * Launch-failure copy (spec 2026-08-31 §6.6): the create path answers 409
 * NODE_OFFLINE when a picked remote node has no live
 * connection; NODE_UNREACHABLE is the sibling the node RPC family produces
 * when the agent accepts but never answers. Everything else — the 404 for an
 * invisible node (deliberately NOT a 403, §2), harness-unusable-on-that-node
 * 409s, plain network failures — keeps its own message, so the copy here is
 * only ever the actionable node-action line.
 */
describe("createSubshellErrorMessage", () => {
  it("turns a 409 NODE_OFFLINE into the actionable node line", () => {
    const err = new ApiError(409, "This node is offline", { code: "NODE_OFFLINE", errId: "e1" });
    expect(createSubshellErrorMessage(err, "Failed to create subshell")).toBe(
      "That node is offline. Start its Subshell daemon or choose another node.",
    );
  });

  it("turns a NODE_UNREACHABLE into the retry-soon line", () => {
    const err = new ApiError(409, "This node didn't respond", { code: "NODE_UNREACHABLE" });
    expect(createSubshellErrorMessage(err, "Failed to create subshell")).toBe(
      "The node did not answer. Try again shortly.",
    );
  });

  it("turns a 409 NODE_IN_MAINTENANCE into the line naming both ways out", () => {
    // The node is up and answering everything else, so "offline" copy would
    // send the reader to look at a machine that is fine.
    const err = new ApiError(409, "This node is in maintenance", { code: "NODE_IN_MAINTENANCE" });
    expect(createSubshellErrorMessage(err, "Failed to create subshell")).toBe(
      "That node is in maintenance. Pick another node, or end maintenance from its node page.",
    );
  });

  it("keeps the server's own message for every other failure shape", () => {
    // 404 node_not_found — invisible nodes 404 (never 403): the fallback
    // text must carry the API line verbatim, no node-offline coaching.
    const gone = new ApiError(404, "Node not found", { code: "NOT_FOUND_ERROR" });
    expect(createSubshellErrorMessage(gone, "Failed to create subshell")).toBe("API 404: Node not found");
    // A 409 that carries no machine code at all (e.g. harness-unusable):
    // its message is already node-aware server-side.
    const harness = new ApiError(409, "That harness is disabled or not installed on that node");
    expect(createSubshellErrorMessage(harness, "Failed to create subshell")).toBe(
      "API 409: That harness is disabled or not installed on that node",
    );
    // Anything that is not an ApiError keeps the historical fallback chain.
    expect(createSubshellErrorMessage(new Error("boom"), "Failed to create subshell")).toBe("boom");
    expect(createSubshellErrorMessage(null, "Failed to create subshell")).toBe("Failed to create subshell");
  });
});

/**
 * Which create failures belong to the Virtual display control (and so render
 * inside the field, not at the form's foot). The contract is the refusal WORD
 * the server mirrors: `screenLaunchRemedy` always names it in parentheses,
 * and the service's switch preflight carries `preview-node-off`.
 */
describe("isDisplayLaunchRefusal", () => {
  it("routes the budget refusal the AI PC actually answered", () => {
    expect(
      isDisplayLaunchRefusal(
        "API 400: That node's virtual display did not come up inside the launch budget, so the screen pane was refused. Try again, or launch without a screen. (preview-display-not-ready: display :90 / rfb 5910 not answering within 10000ms (Xvfb socket never appeared))",
      ),
    ).toBe(true);
  });
  it("routes every other display-owned word, bare or suffixed", () => {
    expect(isDisplayLaunchRefusal("… (preview-display-unsupported)")).toBe(true);
    expect(isDisplayLaunchRefusal("… (preview-display-missing-requirements: x11vnc)")).toBe(true);
    expect(isDisplayLaunchRefusal("… (preview-display-provider-disabled)")).toBe(true);
    expect(isDisplayLaunchRefusal("… (preview-display-provider-conflict: …)")).toBe(true);
    expect(isDisplayLaunchRefusal("Virtual displays are disabled on this node. (preview-node-off)")).toBe(true);
  });
  it("leaves every other failure at the form line", () => {
    // A display MENTION is not a display REFUSAL: only the server's words
    // route, so an offline node or a bad directory never lands on the field.
    expect(isDisplayLaunchRefusal("That node is offline. Start its Subshell daemon or choose another node.")).toBe(
      false,
    );
    expect(isDisplayLaunchRefusal("API 409: That harness is disabled or not installed on that node")).toBe(false);
    expect(
      isDisplayLaunchRefusal("This preset’s display settings are invalid. Edit the preset before launching."),
    ).toBe(false);
    expect(isDisplayLaunchRefusal("")).toBe(false);
  });
});
