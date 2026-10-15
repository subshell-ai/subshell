import { SSH_LOCAL_KEY_MAX_BYTES } from "@internal/subshell-protocol";
import { pbkdf } from "bcrypt-pbkdf";
import { concat, decode64, equal, Reader, SignerError } from "./wire";

const MAGIC = new TextEncoder().encode("openssh-key-v1\0");
const BAD_KEY = "That file isn't a supported OpenSSH private key.";

/** Parsed slices share the decoded buffer, which the caller must scrub. */
export interface Envelope {
  /** The decoded file, including any private bytes. */
  buffer: Uint8Array<ArrayBuffer>;
  /** Whether the private block needs a passphrase. */
  encrypted: boolean;
  /** The public identity advertised outside the private block. */
  publicKey: Uint8Array;
  /** The encrypted or plaintext private block. */
  privateBlock: Uint8Array;
  /** AES key length in bytes, or zero for an unencrypted block. */
  keyLength: number;
  /** Bcrypt salt, or an empty slice for an unencrypted block. */
  salt: Uint8Array;
  /** Bcrypt work factor, bounded before any password work. */
  rounds: number;
}

/** Parse the OpenSSH envelope without decrypting its private block. */
export function readEnvelope(bytes: Uint8Array): Envelope {
  if (!bytes.length || bytes.length > SSH_LOCAL_KEY_MAX_BYTES) {
    throw new SignerError("Choose an SSH private key file no larger than 64 KiB.");
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (/-----BEGIN (?:RSA |EC |DSA |ENCRYPTED )?PRIVATE KEY-----/.test(text)) {
    throw new SignerError("Choose a key in OpenSSH format. Convert a copy with ssh-keygen -p -o first.");
  }
  const match =
    /^-----BEGIN OPENSSH PRIVATE KEY-----\r?\n([A-Za-z0-9+/=\r\n]+)\r?\n-----END OPENSSH PRIVATE KEY-----(?:\r?\n)?$/.exec(
      text,
    );
  if (!match) throw new SignerError(BAD_KEY);
  const buffer = decode64(match[1].replace(/[\r\n]/g, ""));
  try {
    if (!equal(buffer.subarray(0, MAGIC.length), MAGIC)) throw new SignerError(BAD_KEY);
    const reader = new Reader(buffer.subarray(MAGIC.length));
    const cipher = reader.text();
    const kdf = reader.text();
    const options = reader.string();
    if (reader.u32() !== 1) throw new SignerError("Choose an OpenSSH file containing exactly one private key.");
    const publicKey = reader.string();
    const privateBlock = reader.string();
    reader.end();
    if (cipher === "none") {
      if (kdf !== "none" || options.length || !privateBlock.length || privateBlock.length % 8) {
        throw new SignerError(BAD_KEY);
      }
      return { buffer, encrypted: false, publicKey, privateBlock, keyLength: 0, salt: options, rounds: 0 };
    }
    const keyLength = new Map([
      ["aes128-ctr", 16],
      ["aes192-ctr", 24],
      ["aes256-ctr", 32],
    ]).get(cipher);
    if (!keyLength || kdf !== "bcrypt") {
      throw new SignerError("This key's encryption isn't supported. Choose an OpenSSH key using bcrypt and AES-CTR.");
    }
    const parameters = new Reader(options);
    const salt = parameters.string();
    const rounds = parameters.u32();
    parameters.end();
    if (!salt.length || salt.length > 64 || rounds < 1 || rounds > 1024) {
      throw new SignerError(
        "This key's bcrypt settings aren't supported. Choose a key with 1 to 1,024 rounds and a salt no larger than 64 bytes.",
      );
    }
    if (!privateBlock.length || privateBlock.length % 16) throw new SignerError(BAD_KEY);
    return { buffer, encrypted: true, publicKey, privateBlock, keyLength, salt, rounds };
  } catch (error) {
    buffer.fill(0);
    throw error;
  }
}

/** Decrypt into an owned allocation; AES itself stays in Web Crypto. */
export async function unlockEnvelope(envelope: Envelope, passphrase?: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  if (!envelope.encrypted) return concat(envelope.privateBlock);
  if (!passphrase?.length || passphrase.length > SSH_LOCAL_KEY_MAX_BYTES) {
    throw new SignerError("Enter this SSH key's passphrase.");
  }
  const material = new Uint8Array(envelope.keyLength + 16);
  try {
    if (
      pbkdf(
        passphrase,
        passphrase.length,
        envelope.salt,
        envelope.salt.length,
        material,
        material.length,
        envelope.rounds,
      ) !== 0
    ) {
      throw new SignerError("Couldn't unlock that SSH key. Check its passphrase and choose the key again.");
    }
    const aes = await crypto.subtle.importKey("raw", material.subarray(0, envelope.keyLength), "AES-CTR", false, [
      "decrypt",
    ]);
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-CTR", counter: material.subarray(envelope.keyLength), length: 128 },
        aes,
        concat(envelope.privateBlock),
      ),
    );
  } finally {
    material.fill(0);
  }
}
