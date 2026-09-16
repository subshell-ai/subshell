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
 */
export function NetworkAddresses({ addresses, copyable = false }: { addresses: NetworkAddress[]; copyable?: boolean }) {
  if (addresses.length === 0) return null;
  return (
    <ul className="space-y-2">
      {addresses.map((address) => (
        <li key={address.url} className="space-y-0.5">
          <div className="flex flex-wrap items-baseline gap-x-2">
            {copyable ? (
              <CopyableValue value={address.url} label={address.label} />
            ) : (
              <span className="min-w-0 break-all font-strong text-label">{address.url}</span>
            )}
            <span className="text-detail text-muted-foreground">{address.label}</span>
          </div>
          <p className={address.secureContext ? "text-detail text-muted-foreground" : "text-detail text-warning"}>
            {secureContextLine(address)}
          </p>
        </li>
      ))}
    </ul>
  );
}
