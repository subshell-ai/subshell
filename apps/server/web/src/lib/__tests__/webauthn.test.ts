import { afterEach, describe, expect, it } from "bun:test";
import { passkeysSupported } from "../webauthn";

/**
 * The passkey buttons were unconditional. In an embedded webview — which has
 * no platform authenticator — that is a control whose only possible outcome is
 * a failure message about the ceremony rather than about the missing
 * capability. These pin the capability check, not a shell check: gating on
 * "is this the desktop app" would leave the button in some other in-app
 * browser and hide it in a future desktop build that gains an authenticator.
 */
const originalPkc = Object.getOwnPropertyDescriptor(globalThis.window, "PublicKeyCredential");
const originalCreds = Object.getOwnPropertyDescriptor(globalThis.navigator, "credentials");

function setPublicKeyCredential(value: unknown): void {
  Object.defineProperty(globalThis.window, "PublicKeyCredential", { value, configurable: true, writable: true });
}

function setCredentials(value: unknown): void {
  Object.defineProperty(globalThis.navigator, "credentials", { value, configurable: true, writable: true });
}

afterEach(() => {
  if (originalPkc) Object.defineProperty(globalThis.window, "PublicKeyCredential", originalPkc);
  else Reflect.deleteProperty(globalThis.window, "PublicKeyCredential");
  if (originalCreds) Object.defineProperty(globalThis.navigator, "credentials", originalCreds);
  else Reflect.deleteProperty(globalThis.navigator, "credentials");
});

describe("passkeysSupported", () => {
  it("is true when both WebAuthn surfaces are present", () => {
    setPublicKeyCredential(class {});
    setCredentials({ get: () => Promise.resolve(null) });
    expect(passkeysSupported()).toBe(true);
  });

  // WKWebView and WebKitGTK: no platform authenticator at all.
  it("is false with no PublicKeyCredential", () => {
    setPublicKeyCredential(undefined);
    setCredentials({ get: () => Promise.resolve(null) });
    expect(passkeysSupported()).toBe(false);
  });

  // Both halves are needed: `PublicKeyCredential` alone cannot run a ceremony.
  it("is false when credentials.get is missing", () => {
    setPublicKeyCredential(class {});
    setCredentials({});
    expect(passkeysSupported()).toBe(false);
  });

  it("is false when navigator.credentials is absent entirely", () => {
    setPublicKeyCredential(class {});
    setCredentials(undefined);
    expect(passkeysSupported()).toBe(false);
  });
});
