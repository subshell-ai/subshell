import { expect, test } from "bun:test";
import { parseNodeCommandBody } from "../node-frames.js";
import { DEFAULT_PREVIEW_CONFIGURATION } from "../preview-configuration.js";
import { normalizeServiceHost, serviceAuthority } from "../service-target.js";
import { parseWorkspacePreviewId, workspacePreviewId } from "../workspace-preview.js";

test("service hosts normalize DNS and IPv6 without accepting URLs or header injection", () => {
  expect(normalizeServiceHost("EXAMPLE.COM")).toBe("example.com");
  expect(normalizeServiceHost("[::1]")).toBe("::1");
  expect(serviceAuthority("::1", 443)).toBe("[::1]:443");
  for (const host of [
    "",
    "http://localhost",
    "a:80",
    "[::1]:80",
    "a/path",
    "user@host",
    "a\r\nx: bad",
    "a%00",
    "a?b",
    "a#b",
    "a\\b",
  ])
    expect(normalizeServiceHost(host)).toBeNull();
});
test("node grammar accepts explicit HTTP(S) forwards but rejects target changes to screencasts", () => {
  const command = {
    type: "preview_open",
    kind: "forward",
    ref: "a".repeat(32),
    paneId: "pane",
    port: 443,
    lifetimeMs: 60000,
    service: { host: "example.com", protocol: "https" },
  } as const;
  expect(parseNodeCommandBody(JSON.stringify(command))).toEqual(command);
  for (const ignoreCertificateErrors of [false, true]) {
    const optIn = { ...command, service: { ...command.service, ignoreCertificateErrors } };
    expect(parseNodeCommandBody(JSON.stringify(optIn))).toEqual(optIn);
  }
  for (const service of [
    { ...command.service, ignoreCertificateErrors: "true" },
    { ...command.service, protocol: "http", ignoreCertificateErrors: true },
  ])
    expect(parseNodeCommandBody(JSON.stringify({ ...command, service }))).toBeNull();
  expect(parseNodeCommandBody(JSON.stringify({ ...command, kind: "screencast" }))).toBeNull();
  for (const service of [{ host: "http://host", protocol: "http" }, { host: "host", protocol: "file" }, null])
    expect(parseNodeCommandBody(JSON.stringify({ ...command, service }))).toBeNull();
});
test("saved workspace tabs round trip their stable identity and reject malformed IDs", () => {
  const view = { kind: "service", serviceId: crypto.randomUUID(), port: 3000 } as const;
  expect(parseWorkspacePreviewId(workspacePreviewId("pane", view))).toEqual({ paneId: "pane", view });
  expect(parseWorkspacePreviewId("preview:pane:service:bad:3000")).toBeNull();
  expect(parseWorkspacePreviewId(workspacePreviewId("pane", { ...view, port: 65536 }))).toBeNull();
});

test("configured preview identities retain one-off options and reject malformed settings", () => {
  const view = {
    kind: "app" as const,
    port: 8006,
    configuration: {
      ...DEFAULT_PREVIEW_CONFIGURATION,
      protocol: "https" as const,
      ignoreCertificateErrors: true,
      sandbox: false,
    },
  };
  expect(parseWorkspacePreviewId(workspacePreviewId("pane", view))).toEqual({ paneId: "pane", view });
  expect(parseWorkspacePreviewId("preview:pane:app:8006:config:%7B%7D")).toBeNull();
  expect(
    parseWorkspacePreviewId(
      workspacePreviewId("pane", { ...view, configuration: { ...view.configuration, protocol: "http" } }),
    ),
  ).toBeNull();
});
