import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseEnvFile } from "../../config-env.js";
import {
  backup,
  databaseValue,
  fixture,
  put,
  root,
  setupBackupFixtures,
  stage,
} from "../backups/__tests__/fixtures.js";

setupBackupFixtures();
describe("restore recovery before boot configuration", () => {
  it("uses the OS mutex despite a reused PID and replaces inherited interrupted EnvironmentFile values", async () => {
    const source = fixture("source");
    const destination = fixture("destination", "original");
    put(
      destination.configPath as string,
      `BETTER_AUTH_SECRET=original-auth-secret-12345678901234567890\nSERVER_PORT=39870\nHOST=127.0.0.1\nAPP_BASE_URL=http://original:39870\nDATABASE_PATH=${destination.databasePath}\n`,
    );
    const staged = await stage(await backup(source));
    const interrupt = join(root, "interrupt.ts");
    put(
      interrupt,
      `import { restoreInstanceBackup } from ${JSON.stringify(resolve(import.meta.dir, "../backups/transaction.ts"))};
      await restoreInstanceBackup({...${JSON.stringify({ ...staged, cleanup: undefined })}, cleanup:async()=>{}}, {
        destination:${JSON.stringify(destination)},afterReplace:component=>{if(component==='config')process.exit(17)}
      });`,
    );
    expect(Bun.spawnSync([process.execPath, interrupt]).exitCode).toBe(17);
    const inherited = parseEnvFile(readFileSync(destination.configPath as string, "utf8"));
    // This PID is live but owns no SQLite mutex, as with a PID reused after an old server crash.
    put(
      join(dirname(destination.configPath as string), "instance-state.lock"),
      JSON.stringify({ pid: process.pid, kind: "server" }),
    );
    const recover = join(root, "recover.ts");
    put(
      recover,
      `import { loadConfigEnv, resolveConfig } from ${JSON.stringify(resolve(import.meta.dir, "../../config-env.ts"))};
      loadConfigEnv(); console.log(JSON.stringify({port:process.env.SERVER_PORT,secret:process.env.BETTER_AUTH_SECRET,host:process.env.HOST,config:resolveConfig().values.SERVER_PORT}));`,
    );
    const inspect = Bun.spawnSync([process.execPath, recover, "restore", "--inspect"], {
      env: {
        ...process.env,
        ...inherited,
        HOST: "explicit.override",
        SUBSHELL_SERVER_CONFIG_DIR: dirname(destination.configPath as string),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(inspect.exitCode).toBe(0);
    expect(JSON.parse(inspect.stdout.toString()).port).toBe("3080");
    expect(existsSync(join(dirname(destination.configPath as string), "restore-journal.json"))).toBe(true);
    expect(databaseValue(destination.databasePath)).toBe("source");
    for (const args of [["status", "--json"], ["help"], ["version"], ["service", "status"]]) {
      const readOnly = Bun.spawnSync([process.execPath, recover, ...args], {
        env: { ...process.env, ...inherited, SUBSHELL_SERVER_CONFIG_DIR: dirname(destination.configPath as string) },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(readOnly.exitCode).toBe(0);
      expect(existsSync(join(dirname(destination.configPath as string), "restore-journal.json"))).toBe(true);
      expect(databaseValue(destination.databasePath)).toBe("source");
    }
    const child = Bun.spawnSync([process.execPath, recover], {
      env: {
        ...process.env,
        ...inherited,
        HOST: "explicit.override",
        SUBSHELL_SERVER_CONFIG_DIR: dirname(destination.configPath as string),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(child.exitCode).toBe(0);
    expect(JSON.parse(child.stdout.toString())).toEqual({
      port: "39870",
      secret: "original-auth-secret-12345678901234567890",
      host: "explicit.override",
      config: "39870",
    });
    expect(databaseValue(destination.databasePath)).toBe("original");
  });
});
