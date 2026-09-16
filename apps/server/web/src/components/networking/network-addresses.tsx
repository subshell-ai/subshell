import { CopyableValue } from "@/components/ui/copyable-value";
import type { NetworkAddress } from "@/types/network";

/**
 * What a browser at this address can and cannot do.
 *
 * Said on EVERY address, including the good one, because the fact a person
 * needs is comparative: two addresses for one server, and only one of them
 * lets them sign in with a passkey. A line that appeared only on the bad one
 * would leave the good one looking like the plain case.
 *
 * "Encrypted by the network, but your browser sees plain http" is the whole
 * subtlety: a tunnel makes the wire private and leaves the browser in a
 * non-secure context, where WebAuthn and `Secure` cookies are refused. Those
 * are two different claims and the sentence has to carry both.
 */
function secureContextLine(address: NetworkAddress): string {
  return address.secureContext
    ? "Passkeys and secure cookies work at this address."
    : "Encrypted by the network, but your browser sees plain http: passkeys and secure cookies will not work here.";
}

/**
 * The addresses this server answers on over one network.
 *
 * Every address carries a copy button, in every state. The prop that used to
 * gate this to the published state called an unpublished address "a preview",
 * which the mesh networks made false: a joined NetBird or Headscale address
 * ANSWERS — the thing that refuses is the sign-in, not the connection — so it
 * is exactly the string a person reaches for on the way to their phone. And an
 * address worth showing is an address worth taking with you even where it does
 * not yet answer. One less state-dependent difference to notice as one.
 *
 * **Each row is the design system's line item: label above value.** The kind
 * tag used to sit AFTER the URL — a big bold address with a small muted word
 * trailing it — and an operator read the two as disjoint things, because a
 * tag that follows a bold value names nothing until you scan back from it.
 *
 * **The label is a DATA label, not a control label** (amended 2026-09-16, same
 * operator's second read). The first pass gave it the form-label grammar
 * (`font-strong text-label`), and the card then held both grammars six pixels
 * apart: bold "NetBird FQDN" over its URL, quiet "Client version" over its —
 * one read as a heading and one as data, so the card looked like two systems
 * rendering two kinds of thing. These rows are read-only facts, so they take
 * the `Fact`/`dt` grammar verbatim: `text-muted-foreground`, no weight token.
 * The `text-sm` sits on the list, exactly as it sits on the `<dl>` beside it,
 * rather than on the label — that is what keeps the two from drifting if
 * {@link Fact} ever changes. `font-strong` belongs to a control's label and to
 * a section heading, and the "Addresses" heading above keeps it.
 *
 * The secure-context sentence keeps its line below the value — see
 * {@link secureContextLine} for why it appears on every address, the good one
 * included.
 */
export function NetworkAddresses({ addresses }: { addresses: NetworkAddress[] }) {
  if (addresses.length === 0) return null;
  return (
    <ul className="space-y-2 text-sm">
      {addresses.map((address) => (
        <li key={address.url} className="space-y-1">
          <p className="text-muted-foreground">{address.label}</p>
          <CopyableValue value={address.url} label={address.label} />
          <p className={address.secureContext ? "text-detail text-muted-foreground" : "text-detail text-warning"}>
            {secureContextLine(address)}
          </p>
        </li>
      ))}
    </ul>
  );
}
