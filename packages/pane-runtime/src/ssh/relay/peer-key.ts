import { bytesOfJwk } from "@internal/subshell-protocol";
/**
 * Decode a relay command's base64 spelling of the peer's registered ECDH-ES
 * public key into the raw public JWK string the machine pin store holds (the
 * §4.2 registration spelling; the grammar's `BASE64_RE` gate already proved
 * the outer layer). The deep public-only check runs HERE, beside the import:
 * `bytesOfJwk` throws on private material, a foreign curve, or junk, which is
 * why both pin-writing arms - the relay-open pairing (ssh-relay.ts) and the
 * §4.5 re-pair (ssh-machine-pin-repair.ts) - share this one definition of "a
 * peer encryption key that may enter a pin store". Throws; callers wrap.
 */
export function decodePeerEncryptionJwk(b64: string): string {
  const jwk = Buffer.from(b64, "base64").toString("utf8");
  // The pin's encryption half must be a PUBLIC P-256 JWK - the same deep
  // refusal `bytesOfJwk` gives the signing half (private material, foreign
  // curve, junk all throw; the grammar's shallow `d` gate stops at top level).
  bytesOfJwk(jwk);
  return jwk;
}
