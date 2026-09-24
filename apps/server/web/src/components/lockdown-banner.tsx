import { ErrorBanner } from "@/components/error-banner";
import { usePublicSettings } from "@/hooks/use-public-settings";

/**
 * Non-dismissible amber alert shown to EVERY signed-in user while the
 * instance is in lockdown mode (operator ask 2026-09-24): subshells are
 * stopped and nothing new can be created, which is everyone's situation,
 * not a detail of the page they happen to open.
 *
 * Not dismissible by design — the fix is server-side (an admin ends the
 * lockdown on Settings → General), and a banner that could be silenced
 * would let the next "why is the New button failing" question start from
 * a hidden answer. Mounted beside the emergency-login banner and shares
 * its fetch, its staleness window, and its absent-means-off rule for
 * servers older than the field.
 */
export function LockdownBanner() {
  const { data } = usePublicSettings();
  if (!data?.lockdown) return null;
  return (
    <ErrorBanner
      tone="warning"
      message="This server is in lockdown mode. All subshells are stopped and no new subshells can be created; an admin can end the lockdown in server settings."
    />
  );
}
