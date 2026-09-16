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
 * `copyable` is for the published state, where the address has stopped being
 * a preview and become the thing a person sends to their phone.
 *
 * **Each row is the design system's line item: label above value.** The kind
 * tag used to sit AFTER the URL — a big bold address with a small muted word
 * trailing it — and an operator read the two as disjoint things, because a
 * tag that follows a bold value names nothing until you scan back from it.
 * The label now leads, in the same `font-strong text-label` grammar the form
 * labels use, and the URL drops its own weight: a value styled as a heading
 * competes with the section heading above it. The secure-context sentence
 * keeps its line below the value — see {@link secureContextLine} for why it
 * appears on every address, the good one included.
 */
export function NetworkAddresses({ addresses, copyable = false }: { addresses: NetworkAddress[]; copyable?: boolean }) {
  if (addresses.length === 0) return null;
  return (
    <ul className="space-y-2">
      {addresses.map((address) => (
        <li key={address.url} className="space-y-1">
          <p className="font-strong text-label">{address.label}</p>
          {copyable ? (
            <CopyableValue value={address.url} label={address.label} />
          ) : (
            <span className="block min-w-0 break-all">{address.url}</span>
          )}
          <p className={address.secureContext ? "text-detail text-muted-foreground" : "text-detail text-warning"}>
            {secureContextLine(address)}
          </p>
        </li>
      ))}
    </ul>
  );
}
