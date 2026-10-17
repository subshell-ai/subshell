import { expect, it } from "bun:test";
import { ApiError } from "@internal/node-admin";
import { isDuplicatePresetName } from "../preset-errors";

it("identifies duplicate names from stable metadata, independently of wording", () => {
  expect(
    isDuplicatePresetName(
      new ApiError(409, "Changed copy", {
        code: "EXISTS_ERROR",
        body: { metadata: { reason: "duplicate_preset_name", field: "name" } },
      }),
    ),
  ).toBe(true);
  expect(isDuplicatePresetName(new ApiError(409, "Plugin unavailable", { code: "EXISTS_ERROR" }))).toBe(false);
  expect(isDuplicatePresetName(new Error("You already have a terminal preset named x"))).toBe(false);
});

it("recognizes development metadata without changing the error contract", () => {
  expect(
    isDuplicatePresetName(
      new ApiError(409, "Duplicate", {
        body: { metadataSafe: { reason: "duplicate_preset_name", field: "name" } },
      }),
    ),
  ).toBe(true);
});
