import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { backupEncryptionPasswordProblem } from "@internal/subshell-protocol";

// Authenticated, fixed-size header: magic/version/algorithm, salt (16), nonce (12).
const MAGIC = Buffer.from("SUBSHBAK");
const HEADER_BYTES = 40;
const TAG_BYTES = 16;
const ALGORITHM = 3;
const MIN_WORK = 2;
const MAX_WORK = 48;
const TARGET_MS = 2500;

/** Integer work is stored in the authenticated header; hostile files cannot choose unbounded costs. */
export function backupWorkFactor(sampleMs: number): number {
  return Math.max(MIN_WORK, Math.min(MAX_WORK, Math.round(TARGET_MS / Math.max(1, sampleMs))));
}

async function calibrateWork(): Promise<number> {
  const started = performance.now();
  const sample = await deriveKey("backup-calibration", randomBytes(16), MIN_WORK);
  sample.fill(0);
  return backupWorkFactor((performance.now() - started) / MIN_WORK);
}

async function deriveKey(password: string, salt: Buffer, work: number): Promise<Buffer> {
  if (!password || password.length > 4096) throw new Error("backup password must contain 1-4096 characters");
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 32, { N: 65536, r: 8, p: work, maxmem: 128 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

/** Detect the versioned encrypted envelope by its magic, independent of filename. */
export function isEncryptedBackup(prefix: Uint8Array): boolean {
  return Buffer.from(prefix).subarray(0, MAGIC.length).equals(MAGIC);
}

/** Stream AES-256-GCM with scrypt and fresh salt/nonce, authenticating the entire header. */
export async function encryptArchive(source: string, target: string, password: string): Promise<void> {
  const problem = backupEncryptionPasswordProblem(password);
  if (problem) throw new Error(problem);
  const header = Buffer.alloc(HEADER_BYTES);
  MAGIC.copy(header);
  header[8] = 1; // format
  header[9] = ALGORITHM; // AES-256-GCM+scrypt, fixed N/r, calibrated p
  const work = await calibrateWork();
  header.writeUInt16BE(work, 10);
  randomBytes(16).copy(header, 12);
  randomBytes(12).copy(header, 28);
  const key = await deriveKey(password, header.subarray(12, 28), work);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, header.subarray(28));
    cipher.setAAD(header);
    const handle = await open(target, "wx", 0o600);
    try {
      await handle.writeFile(header);
    } finally {
      await handle.close();
    }
    await pipeline(createReadStream(source), cipher, createWriteStream(target, { flags: "a", mode: 0o600 }));
    const output = await open(target, "a");
    try {
      await output.writeFile(cipher.getAuthTag());
      await output.sync();
    } finally {
      await output.close();
    }
  } finally {
    key.fill(0);
  }
}

/** Authenticate before the decrypted archive is parsed; plaintext stays inside private staging. */
export async function decryptArchive(source: string, target: string, password?: string): Promise<void> {
  if (password === undefined) throw new Error("this backup requires a password");
  const bytes = (await stat(source)).size;
  if (bytes < HEADER_BYTES + TAG_BYTES) throw new Error("encrypted backup is truncated");
  const handle = await open(source, "r");
  const header = Buffer.alloc(HEADER_BYTES);
  const tag = Buffer.alloc(TAG_BYTES);
  try {
    await handle.read(header, 0, header.length, 0);
    await handle.read(tag, 0, tag.length, bytes - TAG_BYTES);
  } finally {
    await handle.close();
  }
  const work = header.readUInt16BE(10);
  if (!isEncryptedBackup(header) || header[8] !== 1 || header[9] !== ALGORITHM || work < MIN_WORK || work > MAX_WORK) {
    throw new Error("unsupported encrypted backup header");
  }
  const key = await deriveKey(password, header.subarray(12, 28), work);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, header.subarray(28));
    decipher.setAAD(header);
    decipher.setAuthTag(tag);
    await pipeline(
      createReadStream(source, { start: HEADER_BYTES, end: bytes - TAG_BYTES - 1 }),
      decipher,
      createWriteStream(target, { flags: "wx", mode: 0o600 }),
    );
  } catch {
    throw new Error("backup authentication failed: wrong password or damaged archive");
  } finally {
    key.fill(0);
  }
}
