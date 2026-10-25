import { afterEach, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownsDisplayListener } from "./display-socket.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(address = "0100007F", state = "0A", inode = "4321") {
  const root = mkdtempSync(join(tmpdir(), "display-socket-"));
  roots.push(root);
  mkdirSync(join(root, "123", "net"), { recursive: true });
  mkdirSync(join(root, "123", "fd"));
  writeFileSync(
    join(root, "123", "net", "tcp"),
    `header\n  0: ${address}:1716 00000000:0000 ${state} 0:0 0:0 0 1000 0 ${inode}\n`,
  );
  symlinkSync("socket:[4321]", join(root, "123", "fd", "4"));
  return root;
}

it("requires a loopback listener whose inode is open in the VNC process", () => {
  expect(ownsDisplayListener(123, 5910, fixture())).toBe(true);
  expect(ownsDisplayListener(123, 5910, fixture("0100007F", "0A", "9876"))).toBe(false);
  expect(ownsDisplayListener(123, 5910, fixture("00000000"))).toBe(false);
  expect(ownsDisplayListener(123, 5910, fixture("0100007F", "01"))).toBe(false);
});

it("refuses missing processes, mismatched ports, and invalid persisted values", () => {
  const root = fixture();
  expect(ownsDisplayListener(456, 5910, root)).toBe(false);
  expect(ownsDisplayListener(123, 5911, root)).toBe(false);
  expect(ownsDisplayListener(-1, 5910, root)).toBe(false);
  expect(ownsDisplayListener(123, 65536, root)).toBe(false);
});
