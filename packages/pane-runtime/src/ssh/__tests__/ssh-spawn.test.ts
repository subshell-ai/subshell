import { expect, test } from "bun:test";
import { runSshProcess } from "../ssh-spawn.js";

test("secret-bearing stdin reaches the child without entering its process arguments", async () => {
  const secret = "nsk_private_script_payload";
  const result = await runSshProcess(
    ["/bin/sh", "-c", 'printf "args:%s\\n" "$*"; cat'],
    { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    5_000,
    `${secret}\n`,
  );
  expect(result.code).toBe(0);
  expect(result.stdout).toBe(`args:\n${secret}\n`);
  expect(result.timedOut).toBe(false);
});

test("ordinary SSH probes still receive EOF on stdin", async () => {
  const result = await runSshProcess(["/bin/sh", "-c", "cat"], { PATH: "/usr/bin:/bin" }, 5_000);
  expect(result.code).toBe(0);
  expect(result.stdout).toBe("");
});
