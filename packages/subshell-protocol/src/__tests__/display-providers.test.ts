import { expect, it } from "bun:test";
import {
  DEFAULT_VIRTUAL_DISPLAY_PROVIDER,
  displayOsAnswered,
  displayProviderRunsOnOs,
  displayProvidersForOs,
  NODE_OS_UNKNOWN,
  parseDisplayProviderIds,
  parseVirtualDisplayRequest,
  storedDisplayProviderIds,
  VIRTUAL_DISPLAY_PROVIDERS,
} from "../display-providers.js";
import { parseNodeCommandBody, parseNodePreviewEnabled } from "../node-frames.js";

it("names one OS per bundled provider, and the pickers ask that OS", () => {
  // A provider with no platform here is offered everywhere, which is the
  // defect: the launch dialog showed Xvfb + VNC on a Mac node, and the person
  // found out at launch. Adding a provider means saying what it runs on.
  for (const provider of VIRTUAL_DISPLAY_PROVIDERS) {
    expect(provider.platform).toBeOneOf(["linux", "darwin"]);
  }
  expect(displayProvidersForOs("linux").map((p) => p.id)).toEqual(["xvfb-x11vnc"]);
  expect(displayProvidersForOs("darwin").map((p) => p.id)).toEqual(["betterdisplay"]);
  // A named platform nothing supports is "no choice", which is what stops the
  // launch dialog offering Xvfb + VNC on a Mac.
  expect(displayProvidersForOs("windows")).toEqual([]);
  // An OS that has not answered is not a verdict, and here that has two shapes:
  // no value at all, and the protocol's own "unknown", which is what an agent on
  // any other platform reports about itself. Refusing that would hide providers
  // from a FreeBSD node running Xvfb, and strand the owner's only path to
  // pre-enable one on a node that enrolled and never came ready.
  expect(displayProvidersForOs(null).map((p) => p.id)).toEqual(["xvfb-x11vnc", "betterdisplay"]);
  expect(displayProvidersForOs(undefined).map((p) => p.id)).toEqual(["xvfb-x11vnc", "betterdisplay"]);
  expect(displayProvidersForOs("unknown").map((p) => p.id)).toEqual(["xvfb-x11vnc", "betterdisplay"]);
  expect(NODE_OS_UNKNOWN).toBe("unknown");
  expect(displayProviderRunsOnOs("xvfb-x11vnc", "unknown")).toBe(true);
  expect(displayProviderRunsOnOs("betterdisplay", "unknown")).toBe(true);
  expect(displayProviderRunsOnOs("xvfb-x11vnc", null)).toBe(true);
  expect(displayProviderRunsOnOs("xvfb-x11vnc", "windows")).toBe(false);
  // A stored list is the owner's, so filtering it keeps what the OS runs and
  // keeps an id this package does not ship: a provider the node installed out
  // of band has no platform fact here, and its own readiness answer rules.
  expect(displayProviderRunsOnOs("xvfb-x11vnc", "darwin")).toBe(false);
  expect(displayProviderRunsOnOs("betterdisplay", "darwin")).toBe(true);
  expect(displayProviderRunsOnOs("native-example", "darwin")).toBe(true);
  expect(displayProviderRunsOnOs("native-example", null)).toBe(true);
  expect(DEFAULT_VIRTUAL_DISPLAY_PROVIDER).toBe("xvfb-x11vnc");
});

it("calls only a named platform an answer", () => {
  // The one predicate every surface defers to. A reader that reimplemented this
  // list would drift, and "unknown" is the value that drifts silently: it is a
  // real string in the column, and the only reading that must not be a verdict.
  expect(displayOsAnswered("linux")).toBe(true);
  expect(displayOsAnswered("windows")).toBe(true);
  expect(displayOsAnswered(NODE_OS_UNKNOWN)).toBe(false);
  expect(displayOsAnswered(null)).toBe(false);
  expect(displayOsAnswered(undefined)).toBe(false);
});

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
