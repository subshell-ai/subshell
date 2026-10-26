import { expect, it } from "bun:test";
import { parseDisplayProviderIds, parseVirtualDisplayRequest, storedDisplayProviderIds } from "../display-providers.js";
import { parseNodeCommandBody, parseNodePreviewEnabled } from "../node-frames.js";

it("preserves explicit providers on readiness commands and signed policy", () => {
  const check = { type: "preview_display_check", provider: "native-example" } as const;
  expect(parseNodeCommandBody(check)).toEqual(check);
  const state = {
    on: false,
    displayOn: false,
    displayProvider: "native-example",
    displayProviders: ["xvfb-x11vnc", "native-example"],
    changedAt: "now",
  };
  expect(parseNodePreviewEnabled(state)).toEqual(state);
  expect(parseNodeCommandBody({ type: "set_preview_enabled", ...state })).toEqual({
    type: "set_preview_enabled",
    ...state,
  });
  expect(parseNodeCommandBody({ ...check, provider: "../escape" })).toBeNull();
  expect(parseNodePreviewEnabled({ ...state, displayProviders: ["native-example", "native-example"] })).toBeNull();
});
it("validates display requests and fails closed on malformed stored policy", () => {
  const screen = { width: 1440, height: 900, provider: "native-example" };
  expect(parseVirtualDisplayRequest(screen)).toEqual(screen);
  expect(parseVirtualDisplayRequest({ ...screen, provider: "../escape" })).toBeNull();
  expect(parseVirtualDisplayRequest({ ...screen, width: 1 })).toBeNull();
  expect(parseDisplayProviderIds([])).toEqual([]);
  expect(parseDisplayProviderIds(Array(33).fill("native-example"))).toBeNull();
  expect(storedDisplayProviderIds("not-json")).toEqual([]);
  expect(storedDisplayProviderIds('["../escape"]')).toEqual([]);
});
