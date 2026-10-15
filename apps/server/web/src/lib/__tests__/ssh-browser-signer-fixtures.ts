import { execFileSync } from "node:child_process";
import { createPublicKey, generateKeyPairSync, type KeyObject, sign, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { base64, concat, decode64, field, mpint, padded, positive, Reader, u32 } from "../ssh-browser-signer/wire";

export const SESSION = new Uint8Array(32).fill(42);
export const PASSWORD = "ephemeral-fixture-passphrase";

export interface Fixture {
  bytes: Uint8Array;
  publicKey: string;
}

export function generateFixture(
  directory: string,
  name: string,
  type: string,
  bits?: number,
  encrypted = false,
  cipher?: string,
  rounds: number | null = 1,
): Fixture {
  const path = join(directory, name);
  const args = ["-q", "-t", type, "-f", path, "-N", encrypted ? PASSWORD : "", "-C", ""];
  if (bits) args.push("-b", String(bits));
  if (encrypted && rounds !== null) args.push("-a", String(rounds));
  if (cipher) args.push("-Z", cipher);
  execFileSync("ssh-keygen", args, { stdio: "pipe" });
  return { bytes: new Uint8Array(readFileSync(path)), publicKey: readFileSync(`${path}.pub`, "utf8").split(" ")[1] };
}

export function hostFixture(kind: "ed25519" | "rsa" | "ec" = "ed25519", curve = "prime256v1") {
  const pair =
    kind === "ed25519"
      ? generateKeyPairSync("ed25519")
      : kind === "rsa"
        ? generateKeyPairSync("rsa", { modulusLength: 2048 })
        : generateKeyPairSync("ec", { namedCurve: curve });
  const jwk = pair.publicKey.export({ format: "jwk" });
  const algorithm =
    kind === "ed25519"
      ? "ssh-ed25519"
      : kind === "rsa"
        ? "rsa-sha2-256"
        : `ecdsa-sha2-${{ "P-256": "nistp256", "P-384": "nistp384", "P-521": "nistp521" }[jwk.crv ?? ""]}`;
  const blob =
    kind === "ed25519"
      ? concat(field(algorithm), field(Buffer.from(jwk.x ?? "", "base64url")))
      : kind === "rsa"
        ? concat(
            field("ssh-rsa"),
            mpint(Buffer.from(jwk.e ?? "", "base64url")),
            mpint(Buffer.from(jwk.n ?? "", "base64url")),
          )
        : concat(
            field(algorithm),
            field(algorithm.slice("ecdsa-sha2-".length)),
            field(
              concat(new Uint8Array([4]), Buffer.from(jwk.x ?? "", "base64url"), Buffer.from(jwk.y ?? "", "base64url")),
            ),
          );
  return { privateKey: pair.privateKey, blob, encoded: base64(blob), algorithm, kind, curve: jwk.crv };
}

export type Host = ReturnType<typeof hostFixture>;

export function bindingPacket(
  host: Host,
  options: { session?: Uint8Array; forwarding?: number; algorithm?: string; signature?: Uint8Array } = {},
) {
  const session = options.session ?? SESSION;
  const algorithm = options.algorithm ?? host.algorithm;
  const hash =
    host.kind === "ed25519"
      ? null
      : host.kind === "rsa" || host.curve === "P-256"
        ? "sha256"
        : host.curve === "P-384"
          ? "sha384"
          : "sha512";
  const raw = new Uint8Array(sign(hash, session, { key: host.privateKey, dsaEncoding: "ieee-p1363" }));
  const encodedSignature =
    host.kind === "ec" ? concat(mpint(raw.subarray(0, raw.length / 2)), mpint(raw.subarray(raw.length / 2))) : raw;
  return concat(
    new Uint8Array([27]),
    field("session-bind@openssh.com"),
    field(host.blob),
    field(session),
    field(options.signature ?? concat(field(algorithm), field(encodedSignature))),
    new Uint8Array([options.forwarding ?? 0]),
  );
}

export function authData(
  publicKey: string,
  host: Host,
  options: {
    session?: Uint8Array;
    user?: string;
    service?: string;
    method?: string;
    algorithm?: string;
    publicKey?: string;
    hostKey?: Uint8Array;
    boolean?: number;
  } = {},
) {
  const publicBytes = decode64(publicKey);
  const algorithm = options.algorithm ?? new Reader(publicBytes).text();
  return concat(
    field(options.session ?? SESSION),
    new Uint8Array([50]),
    field(options.user ?? "alice"),
    field(options.service ?? "ssh-connection"),
    field(options.method ?? "publickey-hostbound-v00@openssh.com"),
    new Uint8Array([options.boolean ?? 1]),
    field(algorithm),
    field(decode64(options.publicKey ?? publicKey)),
    field(options.hostKey ?? host.blob),
  );
}

export function signingPacket(publicKey: string, data: Uint8Array, flags = 0) {
  return concat(new Uint8Array([13]), field(decode64(publicKey)), field(data), u32(flags));
}

function nodePublic(publicKey: string): { key: KeyObject; size: number; kind: string } {
  const reader = new Reader(decode64(publicKey));
  const algorithm = reader.text();
  if (algorithm === "ssh-ed25519") {
    return {
      key: createPublicKey({
        key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(reader.string()).toString("base64url") },
        format: "jwk",
      }),
      size: 32,
      kind: "ed25519",
    };
  }
  if (algorithm === "ssh-rsa") {
    const e = Buffer.from(positive(reader)).toString("base64url");
    const n = Buffer.from(positive(reader)).toString("base64url");
    return { key: createPublicKey({ key: { kty: "RSA", e, n }, format: "jwk" }), size: 0, kind: "rsa" };
  }
  const curve = reader.text();
  const raw = reader.string();
  const size = (raw.length - 1) / 2;
  const crv = { nistp256: "P-256", nistp384: "P-384", nistp521: "P-521" }[curve];
  return {
    key: createPublicKey({
      key: {
        kty: "EC",
        crv,
        x: Buffer.from(raw.subarray(1, 1 + size)).toString("base64url"),
        y: Buffer.from(raw.subarray(1 + size)).toString("base64url"),
      },
      format: "jwk",
    }),
    size,
    kind: "ec",
  };
}

/** Independently verify worker wire signatures through node:crypto. */
export function verifyResponse(publicKey: string, data: Uint8Array, response: string): boolean {
  const packet = new Reader(decode64(response));
  if (packet.byte() !== 14) return false;
  const signature = new Reader(packet.string());
  packet.end();
  const algorithm = signature.text();
  let raw = signature.string();
  signature.end();
  const { key, kind, size } = nodePublic(publicKey);
  if (kind === "ec") {
    const pair = new Reader(raw);
    raw = concat(padded(positive(pair, size), size), padded(positive(pair, size), size));
    pair.end();
  }
  const hash =
    kind === "ed25519"
      ? null
      : algorithm === "rsa-sha2-512" || size === 66
        ? "sha512"
        : size === 48
          ? "sha384"
          : "sha256";
  return verify(hash, data, { key, dsaEncoding: "ieee-p1363" }, raw);
}
