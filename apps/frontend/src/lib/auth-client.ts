import { passkeyClient } from "@better-auth/passkey/client";
import { createAuthClient } from "better-auth/react";

/**
 * The single better-auth browser client (spec 2026-08-31 §3). Every auth
 * call goes through it: migrated password sign-in/sign-up/change-password/
 * sign-out/get-session plus the passkey ceremonies (WebAuthn challenge
 * handling is exactly why the plugin exists — do not hand-roll it).
 *
 * baseURL defaults to `/api/auth`, which is correct under the Vite dev proxy
 * and same-origin in prod. Non-auth API traffic stays on apiFetch (lib/api).
 */
export const authClient = createAuthClient({
  plugins: [passkeyClient()],
  fetchOptions: { credentials: "include" },
});
