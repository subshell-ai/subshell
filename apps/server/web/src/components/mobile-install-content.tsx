import { AddressQr } from "@/components/address-qr";
import type { InstallPlatform } from "@/lib/mobile-install";

export const MOBILE_INSTALL_STEPS: Record<InstallPlatform, { label: string; steps: string[] }> = {
  browser: {
    label: "Browser",
    steps: [
      "Open the address above in Chrome or Edge.",
      "Click the install icon at the right of the address bar, or ⋮ → Cast, save and share → Install page as app.",
      "On Safari for macOS it is File → Add to Dock instead.",
    ],
  },
  apple: {
    label: "iPhone & iPad",
    steps: [
      "Open the address above in Safari. Chrome and Firefox on iOS cannot install it; only Safari can.",
      "Tap the Share button, then Add to Home Screen.",
      "Tap Add, then open Subshell from its new icon. Notifications only ever arrive for the installed app.",
    ],
  },
  android: {
    label: "Android",
    steps: [
      "Open the address above in Chrome.",
      "Tap ⋮ → Add to Home screen, then Install app.",
      "Open Subshell from its new icon.",
    ],
  },
};

export const PLATFORM_OPTIONS = (Object.keys(MOBILE_INSTALL_STEPS) as InstallPlatform[]).map((value) => ({
  value,
  label: MOBILE_INSTALL_STEPS[value].label,
}));

/** Shared installation details for the page and the existing dialog. */
export function MobileInstallContent({
  platform,
  origin = window.location.origin,
}: {
  platform: InstallPlatform;
  origin?: string;
}) {
  return (
    <div className="flex flex-col gap-6">
      <AddressQr origin={origin} />
      <ol className="flex list-decimal flex-col gap-2 pl-5 text-body text-muted-foreground">
        {MOBILE_INSTALL_STEPS[platform].steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
    </div>
  );
}
