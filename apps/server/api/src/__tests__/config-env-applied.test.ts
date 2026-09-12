import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configEnvAppliedKeys, loadConfigEnv } from "@/config-env.js";

const made: string[] = [];
const KEY_A = `SUBSHELL_TEST_APPLIED_${process.pid}_A`;
const KEY_B = `SUBSHELL_TEST_APPLIED_${process.pid}_B`;

afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env[KEY_A];
  delete process.env[KEY_B];
  delete process.env.SUBSHELL_SERVER_CONFIG_DIR;
});

describe("configEnvAppliedKeys", () => {
  it("names exactly the keys the loader copied into process.env, never a key the environment already held", () => {
    const dir = mkdtempSync(join(tmpdir(), "subshell-cfg-"));
    made.push(dir);
    writeFileSync(join(dir, "config.env"), `${KEY_A}=from-file\n${KEY_B}=also-file\n`);
    process.env.SUBSHELL_SERVER_CONFIG_DIR = dir;
    process.env[KEY_B] = "from-env"; // env wins; the loader must not claim it

    loadConfigEnv();

    expect(process.env[KEY_A]).toBe("from-file");
    expect(process.env[KEY_B]).toBe("from-env");
    expect(configEnvAppliedKeys().has(KEY_A)).toBe(true);
    expect(configEnvAppliedKeys().has(KEY_B)).toBe(false);
  });
});
