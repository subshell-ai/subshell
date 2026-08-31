import { StatusPill } from "@/components/status-pill";
import { useServerOffline } from "@/hooks/use-server-offline";

/**
 * App-wide "server unreachable" notice: shown while any active query sits in
 * the NetworkError retry loop (see lib/server-status.ts), and it clears by
 * itself the moment a retry lands — the same transient-state vocabulary as
 * LiveStatus's "Reconnecting…". Fixed to the shell top so every page gets it
 * without owning an offline branch; bare pre-auth pages never mount it (they
 * own their error UX, and a down server there is not a blip to wait out).
 */
export function OfflineBanner() {
  const offline = useServerOffline();
  if (!offline) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-2 z-50 flex justify-center">
      {/* Static positioning overrides: StatusPill's default absolute-centering
          is for a positioned parent; the fixed strip centers us already. */}
      <StatusPill tone="warning" className="relative top-0 left-0 translate-x-0">
        Can&apos;t reach the mote server — retrying…
      </StatusPill>
    </div>
  );
}
