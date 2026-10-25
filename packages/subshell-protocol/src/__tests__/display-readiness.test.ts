import { expect, it } from "bun:test";
import { parsePreviewDisplayReadiness } from "../node-results.js";

it("only accepts an explicit display readiness result with bounded prerequisite names", () => {
  expect(parsePreviewDisplayReadiness({ supported: true, missing: [] })).toEqual({ supported: true, missing: [] });
  for (const value of [
    null,
    {},
    { supported: true },
    { supported: "true", missing: [] },
    { supported: true, missing: [""] },
    { supported: true, missing: ["x".repeat(129)] },
    { supported: true, missing: Array(33).fill("permission") },
  ]) {
    expect(parsePreviewDisplayReadiness(value)).toBeNull();
  }
});

it("accepts provider-specific requirements without expanding a Linux program enum", () => {
  const readiness = { supported: true, missing: ["Screen recording permission", "Native display helper"] };
  expect(parsePreviewDisplayReadiness(readiness)).toEqual(readiness);
});
