/**
 * Whether this browser can do passkeys at all.
 *
 * The passkey buttons were unconditional, which is a real bug in every
 * embedded webview — neither WKWebView (macOS) nor WebKitGTK (Linux) ships a
 * platform authenticator, so `authClient.signIn.passkey()` there fails with a
 * message about the ceremony rather than about the missing capability. It
 * surfaced with `apps/desktop-server`, but it was already wrong in any in-app browser
 * a user might follow a link into.
 *
 * Deliberately a CAPABILITY check, not a shell check: gating on "is this the
 * desktop app" would keep the button in some webview nobody thought of, and
 * hide it in a future desktop build that gains an authenticator.
 */

/**
 * True when the WebAuthn APIs passkey sign-in and registration need are present.
 *
 * @returns whether to offer passkeys at all
 */
export function passkeysSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.PublicKeyCredential !== "undefined" &&
    typeof navigator !== "undefined" &&
    typeof navigator.credentials?.get === "function"
  );
}
