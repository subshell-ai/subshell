import { describe, expect, it } from "bun:test";
import { decidePushAction, SETTINGS_HREF } from "../lib/push-routing";

/**
 * The tap/action decision behind a push (PR #338 review, Important 1): a
 * `grant_approval` push carries the grant REQUEST uuid as `sid`, so the old
 * blind push to `/subshell/<sid>` was a 404 dead-end and its Silence bell
 * PATCHed a nonexistent subshell. `push-bridge` keeps the side effects; this
 * pure helper owns the choice, which is all the regression needs pinning.
 */
describe("decidePushAction", () => {
  it("grant_approval tap routes to the settings tab, never a phantom pane", () => {
    const a = decidePushAction({ sid: "req-uuid", kind: "grant_approval", origin: "https://a" }, undefined);
    expect(a).toEqual({ action: "route", href: SETTINGS_HREF });
    expect(JSON.stringify(a)).not.toContain("/subshell/");
    // The settings tab must be the spelled group route the app itself uses.
    expect(SETTINGS_HREF).toBe("/(tabs)/settings");
  });

  it("grant_approval silence is ignored: no PATCH intent against a request id", () => {
    const a = decidePushAction({ sid: "req-uuid", kind: "grant_approval", origin: "https://a" }, "silence");
    expect(a).toEqual({ action: "ignore" });
  });

  it("pane kinds tap to /subshell/<sid>, encoded, unchanged", () => {
    const a = decidePushAction({ sid: "sess-1", kind: "turn_complete", origin: "https://a" }, undefined);
    expect(a).toEqual({ action: "route", href: "/subshell/sess-1" });
    expect(decidePushAction({ sid: "a b", kind: "needs_attention" }, "open")).toEqual({
      action: "route",
      href: "/subshell/a%20b",
    });
  });

  it("pane kinds silence asks for the bell PATCH with the sid", () => {
    expect(decidePushAction({ sid: "sess-1", kind: "needs_attention" }, "silence")).toEqual({
      action: "silence",
      sid: "sess-1",
    });
  });

  it("a pane payload with no sid is ignored (the pre-existing guard)", () => {
    expect(decidePushAction({ kind: "turn_complete", origin: "https://a" }, undefined)).toEqual({
      action: "ignore",
    });
    expect(decidePushAction({ kind: "exited" }, "silence")).toEqual({ action: "ignore" });
  });
});
