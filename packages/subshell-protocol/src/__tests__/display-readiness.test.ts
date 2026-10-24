import { expect, it } from "bun:test";
import { parsePreviewDisplayReadiness } from "../node-results.js";

it("only accepts an explicit display readiness result with known program names", () => {
  expect(parsePreviewDisplayReadiness({ supported: true, missing: [] })).toEqual({ supported: true, missing: [] });
  for (const value of [
    null,
    {},
    { supported: true },
    { supported: "true", missing: [] },
    { supported: true, missing: ["unknown"] },
  ]) {
    expect(parsePreviewDisplayReadiness(value)).toBeNull();
  }
});
