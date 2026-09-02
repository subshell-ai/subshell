import { ErrorBanner } from "@/components/error-banner";
import { usePublicSettings } from "@/hooks/use-public-settings";

/**
 * Non-dismissible amber alert shown to EVERY signed-in user while the
 * break-glass admin password is armed: the instance currently has a
 * backdoor credential, which is everyone's business, not just the admin's.
 * Not dismissible by design — the fix is server-side (change password,
 * clear the env var, restart).
 *
 * Reads the shared `usePublicSettings` cache (staleTime 30 s there): after
 * the operator clears the var and restarts, the banner retires on the next
 * mount within the window without any manual reload.
 */
export function EmergencyLoginBanner() {
  const { data } = usePublicSettings();
  if (!data?.emergencyLoginActive) return null;
  return (
    <ErrorBanner
      tone="warning"
      message="Emergency admin login is enabled. Admins should set a new password now (Settings → Change password), then remove MOTE_EMERGENCY_PASSWORD and restart the server."
    />
  );
}
