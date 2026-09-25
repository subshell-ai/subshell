import { apiFetch } from "@internal/node-admin";
import { useQuery } from "@tanstack/react-query";
import { SETTINGS_QUERY_KEY } from "@/lib/query-keys";

/**
 * The authenticated admin settings read (`GET /api/settings`, cookie-admin
 * only). The General page owns its richer projection of this same cache
 * entry under the same `SETTINGS_QUERY_KEY`; this narrower hook exists so the
 * Auth page reads the ONE field it renders (the pending-approval expiry
 * window) without re-declaring the General page's shape.
 *
 * It shares the key deliberately: the Lockdown card and the pending-expiry
 * card both invalidate `SETTINGS_QUERY_KEY` on their PATCHes, so a write from
 * either page moves this read too — with `refetchOnWindowFocus: false`, a
 * card invalidating a key the page does not read would show a state the
 * server never confirmed until a full reload.
 *
 * `pendingApprovalExpiryDays` is OPTIONAL for the usual absent-field reason:
 * a server older than the setting sends no key, and the card must not render
 * an input for a number the route cannot back (the Lockdown card's render
 * guard is the precedent). The value is the route's ANSWERED number — an
 * absent or corrupt row arrives as 30, the same number the sweep acts on.
 */
export function usePendingExpiry(enabled: boolean) {
  return useQuery({
    queryKey: SETTINGS_QUERY_KEY,
    queryFn: () => apiFetch<{ pendingApprovalExpiryDays?: number }>("/api/settings"),
    enabled,
    retry: false,
  });
}
