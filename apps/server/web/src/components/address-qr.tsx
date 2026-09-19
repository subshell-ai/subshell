import { QrCode } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useId, useState } from "react";
import { CopyableValue } from "@/components/ui/copyable-value";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { usePublicSettings } from "@/hooks/use-public-settings";
import { installAddresses } from "@/lib/install-addresses";

/**
 * Pick one of this instance's addresses and get it as a QR code.
 *
 * Extracted from `mobile-install-dialog.tsx` when subshells and workspaces
 * wanted the same thing (2026-09-19). That dialog is this plus the PWA
 * gesture steps; a QR for one subshell is this plus a `path` and nothing
 * else — so the picker, the refusal, the plate and the copy row have one
 * implementation rather than two that drift.
 *
 * **The address problem is why this exists at all**, and it is the same
 * problem in both callers: the person reading it is at a desk, the address
 * their browser is on is very often `localhost`, and their phone cannot reach
 * it. So it offers every origin this instance accepts a sign-in from and
 * encodes the chosen one, rather than asking anyone to type a tailnet
 * hostname on a phone keyboard.
 *
 * Not admin-gated, and it asks for nothing: the addresses ride the
 * public-settings payload every signed-in page already holds.
 */
export function AddressQr({
  active,
  path = "",
  label = "Address to open",
  origin = typeof window === "undefined" ? "" : window.location.origin,
}: {
  /**
   * Whether the surface holding this is on screen. Drives the refetch below;
   * a prop rather than a mount effect because both callers keep their dialog
   * mounted and toggle `open`.
   */
  active: boolean;
  /**
   * Appended to the chosen origin — `/subshells/<id>`, `/workspaces/<id>`.
   * Empty encodes the origin itself, which is the install dialog's case.
   */
  path?: string;
  /** The field's label; the caller owns the words. */
  label?: string;
  /** The address THIS browser reached the plane on. A parameter so tests can
   * drive the picker without a stubbed `window.location`. */
  origin?: string;
}) {
  const { data: settings, refetch } = usePublicSettings();
  // refetch-on-open (the Nodes dialog's precedent, `add-node-dialog.tsx`):
  // the shared query is 30 s fresh, but the list is the whole payload and
  // the person opening this has often JUST joined a network — from another
  // tab, a phone, or the CLI, none of which this tab hears about. The
  // allowlist is live on the server (2026-09-16); a picker that lagged it
  // by half a minute would send someone back to Networking to check on a
  // join that had already landed.
  useEffect(() => {
    if (active) void refetch();
  }, [active, refetch]);
  const ids = { address: useId() };
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
  // The origin is already canonical (`URL.origin`, from `installAddresses`),
  // so this is a join rather than a parse — and `path` is ours, never typed.
  const target = selected ? `${selected.url}${path}` : null;

  return (
    <>
      <div className="space-y-2">
        <Label htmlFor={ids.address}>{label}</Label>
        {/* `Select`, not the `SearchableSelect` this started as. That
            primitive's closed state is a real <input> by design (type to
            filter), and with four fixed addresses it read as a text box
            someone was meant to type a URL into — the one thing this field
            must not look like, since a typed address is exactly what the
            picker exists to replace. A trigger with a chevron says "these
            are your choices".

            Every row here is an address a phone can actually dial: loopback
            is filtered in `installAddresses`, not labelled here. When there
            is genuinely nothing to offer, the refusal renders in the QR slot
            below — not as an inert dropdown.

            And nothing explains the picker. It used to carry a paragraph on
            how the allowlist is assembled and an amber note on what plain
            http costs a PWA; both went 2026-09-18 (operator's call) because
            the audience is developers and every clause restated the address
            bar. `mobile-install-dialog.test.tsx` pins the absence. */}
        <Select value={selected?.url ?? ""} onValueChange={(url: string | null) => url && setChosen(url)}>
          <SelectTrigger id={ids.address} className="w-full min-w-0">
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
      </div>

      {/* One slot, two states — and the refusal renders WHERE THE QR WOULD BE
          rather than as a sentence under the field. "Where's the QR?" is the
          question an absent code actually raises, and a footnote below a
          picker does not answer it; the empty state has to occupy the space
          it is explaining. Same reason it is not `role="alert"`: this is a
          standing fact about the instance, not an event.

          A code encoding `http://localhost:3080` would scan perfectly and
          resolve, on the phone, to whatever is listening on that PHONE's port
          3080 — nothing, or something else entirely. So loopback never
          reaches the QR at all (it is filtered in `installAddresses`), and the
          only way this slot shows its second state is an instance with
          genuinely no phone-dialable address: a loopback bind, or a server
          older than the LAN derivation. */}
      {target !== null ? (
        <div className="flex flex-col items-center gap-3">
          {/* A QR is read optically: dark modules on a LIGHT field, with a
              quiet zone. This app is dark-only, so the plate cannot inherit a
              surface colour and stay scannable — `--qr-plate` exists for
              exactly this, beside `--scrim`. */}
          <div className="rounded-md bg-qr-plate p-3">
            <QRCodeSVG value={target} size={160} marginSize={1} title={`QR code for ${target}`} />
          </div>
          <span className="w-full min-w-0 text-center text-detail text-muted-foreground">
            <CopyableValue value={target} label="Address" />
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
    </>
  );
}
