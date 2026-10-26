import { afterEach, expect, it } from "bun:test";
import { createCipheriv, scryptSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decryptArchive, encryptArchive } from "../encryption.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function paths() {
  const dir = mkdtempSync(join(tmpdir(), "backup-encryption-test-"));
  dirs.push(dir);
  return { source: join(dir, "source"), encrypted: join(dir, "encrypted"), output: join(dir, "output") };
}

it("decrypts an independently constructed AES-GCM envelope using the stronger scrypt parameters", async () => {
  const { encrypted, output } = paths();
  const header = Buffer.alloc(40);
  header.write("SUBSHBAK");
  header[8] = 1;
  header[9] = 3;
  header.writeUInt16BE(2, 10);
  header.fill(0x42, 12, 28);
  header.fill(0x17, 28);
  const key = scryptSync("eightchr", header.subarray(12, 28), 32, {
    N: 65536,
    r: 8,
    p: 2,
    maxmem: 128 * 1024 * 1024,
  });
  const cipher = createCipheriv("aes-256-gcm", key, header.subarray(28));
  cipher.setAAD(header);
  const ciphertext = Buffer.concat([cipher.update("private archive contents"), cipher.final()]);
  writeFileSync(encrypted, Buffer.concat([header, ciphertext, cipher.getAuthTag()]));
  await decryptArchive(encrypted, output, "eightchr");
  expect(readFileSync(output, "utf8")).toBe("private archive contents");
  key.fill(0);
});

it("uses fresh salt and nonce and rejects the unreleased weak algorithm", async () => {
  const { source, encrypted, output } = paths();
  writeFileSync(source, "private archive contents");
  await encryptArchive(source, encrypted, "unique archive password");
  await encryptArchive(source, output, "unique archive password");
  const first = readFileSync(encrypted);
  const second = readFileSync(output);
  expect(first[9]).toBe(3);
  expect(first.readUInt16BE(10)).toBe(2);
  expect(second.readUInt16BE(10)).toBe(2);
  expect(first.subarray(12, 28).equals(second.subarray(12, 28))).toBe(false);
  expect(first.subarray(28, 40).equals(second.subarray(28, 40))).toBe(false);
  first[9] = 1;
  writeFileSync(encrypted, first);
  await expect(decryptArchive(encrypted, `${output}-invalid`, "unique archive password")).rejects.toThrow(
    "unsupported",
  );
  expect(existsSync(`${output}-invalid`)).toBe(false);
});

it("rejects short passwords before creating output, counting Unicode characters", async () => {
  const { source, encrypted } = paths();
  writeFileSync(source, "private archive contents");
  for (const password of ["", "short", "😀".repeat(7)]) {
    await expect(encryptArchive(source, encrypted, password)).rejects.toThrow("at least 8");
    expect(existsSync(encrypted)).toBe(false);
  }
});

it("refuses hostile work factors before deriving a key or writing plaintext", async () => {
  const { encrypted, output } = paths();
  const envelope = Buffer.alloc(56);
  envelope.write("SUBSHBAK");
  envelope[8] = 1;
  envelope[9] = 3;
  for (const work of [0, 1, 3, 48, 65535]) {
    envelope.writeUInt16BE(work, 10);
    writeFileSync(encrypted, envelope);
    await expect(decryptArchive(encrypted, output, "eightchr")).rejects.toThrow("unsupported");
    expect(existsSync(output)).toBe(false);
  }
});
