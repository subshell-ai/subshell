import { QrCode } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { type JSX, useEffect, useId, useState } from "react";
import { CopyableValue } from "@/components/ui/copyable-value";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Segmented } from "@/components/ui/segmented";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { usePublicSettings } from "@/hooks/use-public-settings";
import { type InstallPlatform, installAddresses, installPlatformFor } from "@/lib/mobile-install";

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

/** One platform's steps. The tab group is three GESTURES, not three brands —
 * which is why macOS Safari sits under "Browser" beside Chrome rather than
 * under the Apple tab with the iPhone. */
const STEPS: Record<InstallPlatform, { label: string; steps: string[] }> = {
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
      "Open the address above in Safari. Chrome and Firefox on iOS cannot install it — only Safari can.",
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

const PLATFORM_OPTIONS = (Object.keys(STEPS) as InstallPlatform[]).map((value) => ({
  value,
  label: STEPS[value].label,
}));

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
  const { data: settings, refetch } = usePublicSettings();
  // refetch-on-open (the Nodes dialog's precedent, `add-node-dialog.tsx`):
  // the shared query is 30 s fresh, but the list is the whole payload and
  // the person opening this has often JUST joined a network — from another
  // tab, a phone, or the CLI, none of which this tab hears about. The
  // allowlist is live on the server (2026-09-16); a picker that lagged it
  // by half a minute would send someone back to Networking to check on a
  // join that had already landed.
  useEffect(() => {
    if (open) void refetch();
  }, [open, refetch]);
  const ids = { address: useId(), hint: useId() };
  // The guess is the tab, never the only tab: someone at a desktop looking up
  // what their phone should do is a normal reason to be here.
  const [platform, setPlatform] = useState<InstallPlatform>(() => installPlatformFor());
  const [chosen, setChosen] = useState<string | null>(null);

  const addresses = installAddresses({
    here: origin,
    baseUrl: settings?.appBaseUrl,
    trustedOrigins: settings?.trustedOrigins,
  });
  // `chosen` is dropped when it is no longer on offer — the list grows when
  // the settings query lands, and shrinks if an origin is removed while this
  // is open. Deriving instead of syncing in an effect is what keeps the
  // selection from surviving as a stale string.
  const selected = addresses.find((a) => a.url === chosen) ?? addresses[0];
  // A `secureContext` statement about the BROWSER, not about encryption: a
  // WireGuard mesh encrypts an http:// origin end to end, and service workers
  // and passkeys still refuse it. Same wording as the Networking page's.
  const insecure = selected?.url.startsWith("http://");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Subshell for Mobile</DialogTitle>
          <DialogDescription>
            Subshell installs on a phone as an app — full screen, its own icon, and the only place notifications arrive.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label htmlFor={ids.address}>Address to open</Label>
          {/* `Select`, not the `SearchableSelect` this started as. That
              primitive's closed state is a real <input> by design (type to
              filter), and with four fixed addresses it read as a text box
              someone was meant to type a URL into — the one thing this field
              must not look like, since a typed address is exactly what the
              picker exists to replace. A trigger with a chevron says "these
              are your choices".

              Every row here is an address a phone can actually dial: loopback
              is filtered in `installAddresses`, not labelled here. It used to
              be kept with a "this device only" caption because a stock
              instance's whole list looked like that; the server now derives
              its own LAN interfaces into the allowlist, so a row that cannot
              work for the phone is not a choice this picker should show. When
              there is genuinely nothing to offer, the refusal renders in the
              QR slot below — not as an inert dropdown. */}
          <Select value={selected?.url ?? ""} onValueChange={(url: string | null) => url && setChosen(url)}>
            <SelectTrigger id={ids.address} aria-describedby={ids.hint} className="w-full min-w-0">
              <SelectValue placeholder="Choose an address" />
            </SelectTrigger>
            <SelectContent>
              {addresses.map((address) => (
                <SelectItem key={address.url} value={address.url}>
                  <span className="truncate">{address.url}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p id={ids.hint} className="text-detail text-muted-foreground">
            Every address this server accepts a sign-in from — its own, including the addresses of its own network
            interfaces, any you added under Service, and every network it has joined. Pick one your phone can reach —
            the same Wi-Fi, or the same VPN or mesh network.
          </p>
        </div>

        {/* One slot, two states — and the refusal renders WHERE THE QR WOULD
            BE rather than as a sentence under the field. "Where's the QR?" is
            the question an absent code actually raises, and a footnote below a
            picker does not answer it; the empty state has to occupy the space
            it is explaining. Same reason it is not `role="alert"`: this is a
            standing fact about the instance, not an event.

            A code encoding `http://localhost:3080` would scan perfectly and
            resolve, on the phone, to whatever is listening on that PHONE's
            port 3080 — nothing, or something else entirely. So loopback never
            reaches the QR at all (it is filtered in `installAddresses`), and
            the only way this slot shows its second state is an instance with
            genuinely no phone-dialable address: a loopback bind, or a server
            older than the LAN derivation. */}
        {selected ? (
          <div className="flex flex-col items-center gap-3">
            {/* A QR is read optically: dark modules on a LIGHT field, with a
                quiet zone. This app is dark-only, so the plate cannot inherit
                a surface colour and stay scannable — `--qr-plate` exists for
                exactly this, beside `--scrim`. */}
            <div className="rounded-md bg-qr-plate p-3">
              <QRCodeSVG value={selected.url} size={160} marginSize={1} title={`QR code for ${selected.url}`} />
            </div>
            <span className="text-detail text-muted-foreground">
              <CopyableValue value={selected.url} label="Address" />
            </span>
          </div>
        ) : (
          <div
            data-testid="no-address-note"
            className="flex flex-col items-center gap-2 rounded-md border border-dashed px-4 py-6 text-center"
          >
            <QrCode aria-hidden className="h-8 w-8 text-muted-foreground opacity-40" />
            <p className="text-detail text-warning">No QR code: this server knows no address a phone can open.</p>
            <p className="text-detail text-muted-foreground">
              {settings?.viewerIsAdmin
                ? "Join a network under Server Settings → Networking, or add an address under Server Settings → Service, and it will appear here."
                : "An admin can join a network, or add the address you reach it by, and it will appear here."}
            </p>
          </div>
        )}

        {insecure && (
          <p data-testid="insecure-note" className="text-detail text-warning">
            This address is plain <code>http://</code>, so a browser will not treat it as secure: an iPhone still adds
            it to the Home Screen, but notifications never arrive there, and Chrome offers a shortcut rather than an
            app.{" "}
            {settings?.viewerIsAdmin
              ? "An https address — one published under Server Settings → Networking — fixes both."
              : "An admin can publish this server on a network to get an https address."}
          </p>
        )}

        <div className="space-y-2">
          <Segmented
            ariaLabel="Where you are installing Subshell"
            options={PLATFORM_OPTIONS}
            value={platform}
            onChange={setPlatform}
            className="w-full"
          />
          <ol className="list-decimal space-y-1 pl-5 text-muted-foreground text-sm">
            {STEPS[platform].steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </div>
      </DialogContent>
    </Dialog>
  );
}
