import { useQuery } from "@tanstack/react-query";
import { ErrorBanner } from "@/components/error-banner";
import { apiFetch } from "@/lib/api";

/** Public settings shape — only the fields the shell observes. */
interface PublicSettings {
  /** Kept for the shared cache shape; unused here */
  allowRegistrations: boolean;
  /** True while MOTE_EMERGENCY_PASSWORD is set (spec 2026-08-31 §6) */
  emergencyLoginActive: boolean;
}

/**
 * Non-dismissible amber alert shown to EVERY signed-in user while the
 * break-glass admin password is armed: the instance currently has a
 * backdoor credential, which is everyone's business, not just the admin's.
 * Not dismissible by design — the fix is server-side (change password,
 * clear the env var, restart).
 *
 * staleTime 30 s mirrors the current-user freshness: after the operator
 * clears the var and restarts, the banner retires on the next mount within
 * the window without any manual reload, and the endpoint is local + cheap.
 */
export function EmergencyLoginBanner() {
  const { data } = useQuery({
    queryKey: ["settings-public"],
    queryFn: () => apiFetch<PublicSettings>("/api/settings/public"),
    staleTime: 30_000,
  });
  if (!data?.emergencyLoginActive) return null;
  return (
    <ErrorBanner
      tone="warning"
      message="Emergency admin login is enabled. Admins should set a new password now (Settings → Change password), then remove MOTE_EMERGENCY_PASSWORD and restart the server."
    />
  );
}
