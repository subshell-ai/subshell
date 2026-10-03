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
  header[9] = 2;
  header.fill(0x42, 12, 28);
  header.fill(0x17, 28);
  const key = scryptSync("unique archive password", header.subarray(12, 28), 32, {
    N: 131072,
    r: 8,
    p: 1,
    maxmem: 160 * 1024 * 1024,
  });
  const cipher = createCipheriv("aes-256-gcm", key, header.subarray(28));
  cipher.setAAD(header);
  const ciphertext = Buffer.concat([cipher.update("private archive contents"), cipher.final()]);
  writeFileSync(encrypted, Buffer.concat([header, ciphertext, cipher.getAuthTag()]));
  await decryptArchive(encrypted, output, "unique archive password");
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
  expect(first[9]).toBe(2);
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
  for (const password of ["", "short", "😀".repeat(14)]) {
    await expect(encryptArchive(source, encrypted, password)).rejects.toThrow("at least 15");
    expect(existsSync(encrypted)).toBe(false);
  }
});
