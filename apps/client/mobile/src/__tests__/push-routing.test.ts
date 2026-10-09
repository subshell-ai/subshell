import { describe, expect, it } from "bun:test";
import { decidePushAction } from "../lib/push-routing";

/** Pure push routing decisions; the bridge owns the effects. */
describe("decidePushAction", () => {
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
