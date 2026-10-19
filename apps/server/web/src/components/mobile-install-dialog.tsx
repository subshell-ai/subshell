import { type JSX, useState } from "react";
import { MobileInstallContent, PLATFORM_OPTIONS } from "@/components/mobile-install-content";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Segmented } from "@/components/ui/segmented";
import { type InstallPlatform, installPlatformFor } from "@/lib/mobile-install";

/**
 * How to put Subshell on a phone — the address to open, and the gesture that
 * turns it into an app.
 *
 * Both halves are load-bearing and the address is the harder one. The SPA has
 * been an installable PWA since the mobile work, but nothing on any surface
 * said so, and the person who most needs it is reading this at a desk: the
 * address their browser is on is very often `localhost`, which their phone
 * cannot reach. So the dialog offers every origin this instance will accept a
 * sign-in from and encodes the chosen one as a QR, rather than asking someone
 * to type a tailnet hostname on a phone keyboard.
 *
 * Not admin-gated, and it asks for nothing: the addresses ride the
 * public-settings payload every signed-in page already holds.
 */

export function MobileInstallDialog({
  open,
  onOpenChange,
  origin = typeof window === "undefined" ? "" : window.location.origin,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The address THIS browser reached the plane on. A parameter so tests can
   * drive the picker without a stubbed `window.location`. */
  origin?: string;
}): JSX.Element {
  // The guess is the tab, never the only tab: someone at a desktop looking up
  // what their phone should do is a normal reason to be here.
  const [platform, setPlatform] = useState<InstallPlatform>(() => installPlatformFor());

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Subshell for Mobile</DialogTitle>
          <DialogDescription>
            Subshell installs on a phone as an app: full screen, its own icon, and the only place notifications arrive.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Segmented
            ariaLabel="Where you are installing Subshell"
            options={PLATFORM_OPTIONS}
            value={platform}
            onChange={setPlatform}
            className="w-full"
          />
          <MobileInstallContent platform={platform} origin={origin} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
