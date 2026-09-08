import { SubshellClient } from "@/lib/api";
import { secureTokenStore } from "@/native/secure-token-store";

/**
 * A SubshellClient for any registered origin — push-routing and settings both
 * need to act on a NON-active instance (review #5: three hand-rolled
 * constructions were drifting apart). Deliberately no `onUnauthorized`: a
 * background actor has no screen to bounce to, and inventing one is how a
 * lock-screen action ends up navigating the app. The interactive client,
 * with the redirect wired, is built once in `providers/subshell-provider.tsx`.
 */
export function clientForOrigin(origin: string): SubshellClient {
  return new SubshellClient({ baseUrl: origin, store: secureTokenStore(origin) });
}
