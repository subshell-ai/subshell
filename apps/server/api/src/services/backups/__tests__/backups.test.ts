import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { pack } from "tar-stream";
import { createInstanceBackup, inspectInstanceBackup, stageInstanceBackup } from "../archive.js";
import { captureConfig, restoreConfig, validateRestoreConfigOverrides } from "../config.js";
import { LATEST_BACKUP_MIGRATION, snapshotDatabase } from "../database.js";
import { validateArchivePath } from "../paths.js";
import { finalizeInstanceRestore, recoverInstanceRestore, restoreInstanceBackup } from "../transaction.js";

import {
  backup,
  databaseValue,
  fixture,
  put,
  rewriteArchive,
  root,
  secret,
  setupBackupFixtures,
  stage,
} from "./fixtures.js";

setupBackupFixtures();
describe("instance archive", () => {
  for (const password of [undefined, "correct horse battery staple"]) {
    it(`roundtrips ${password ? "encrypted" : "plain"} instance state into explicit host paths`, async () => {
      const source = fixture("source");
      const destination = fixture("destination", "original");
      const path = await backup(source, password);
      const inspected = await inspectInstanceBackup(path, password);
      expect(inspected.admins).toEqual([{ id: "admin-id", email: "admin@example.com", name: "source" }]);
      expect(JSON.stringify(inspected)).not.toContain(secret);
      expect(JSON.stringify(inspected)).not.toContain("private-password-hash");
      expect(
        inspected.manifest.entries.some((entry) =>
          /EXCLUDED|\/mcp\/|\/backups\/|\/uploads\/|\/projects\//.test(entry.path),
        ),
      ).toBe(false);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      const staged = await stage(path, password);
      expect(statSync(staged.dir).mode & 0o777).toBe(0o700);
      const transaction = await restoreInstanceBackup(staged, {
        destination,
        configOverrides: {
          baseUrl: "https://new.example",
          host: "127.0.0.1",
          port: "4000",
          trustedOrigins: "https://Box.Example:443/",
        },
      });
      expect(databaseValue(destination.databasePath)).toBe("source");
      const config = readFileSync(destination.configPath as string, "utf8");
      expect(config).toContain(`DATABASE_PATH=${destination.databasePath}`);
      expect(config).toContain(`SUBSHELL_SERVER_DATA_DIR=${destination.dataDir}`);
      expect(config).toContain("TRUSTED_ORIGINS=https://box.example");
      expect(config).not.toContain("/old/absolute");
      expect(config).not.toContain("EMERGENCY");
      expect(config).not.toContain("UNSUPPORTED_SECRET");
      expect(readFileSync(join(destination.dataDir, "plugins-state", "net", "secrets", "token"), "utf8")).toBe(
        "source-network-token",
      );
      expect(readFileSync(join(destination.dataDir, "identities", "sess-one.json"), "utf8")).toContain(
        "source-channel-key",
      );
      expect(readFileSync(join(destination.dataDir, "mcp", "launch.json"), "utf8")).toBe("EXCLUDED");
      expect(await recoverInstanceRestore(transaction.journalPath)).toBe("pending-boot");
      await finalizeInstanceRestore(transaction.journalPath);
      expect(await recoverInstanceRestore(transaction.journalPath)).toBe("none");
      expect(readdirSync(dirname(destination.databasePath)).some((name) => name.includes("restore-old"))).toBe(false);
    });
  }

  it("canonicalizes only the trusted OS temp root while refusing explicit aliased paths", async () => {
    const source = fixture("source");
    const archive = await backup(source);
    const standalone = join(root, "standalone.db");
    await snapshotDatabase(source.databasePath, standalone);
    const realTemp = join(root, "real-temp");
    const alias = join(root, "temp-alias");
    mkdirSync(realTemp);
    symlinkSync(realTemp, alias);
    put(join(realTemp, "selected.db"), readFileSync(standalone));
    const tempKey = process.platform === "win32" ? "TEMP" : "TMPDIR";
    const originalTmpdir = process.env[tempKey];
    process.env[tempKey] = alias;
    try {
      for (const path of [standalone, archive]) {
        const staged = await stageInstanceBackup(path);
        try {
          expect(staged.dir.startsWith(`${realTemp}/`)).toBe(true);
          expect(databaseValue(staged.databasePath)).toBe("source");
        } finally {
          await staged.cleanup();
        }
      }
      await expect(stageInstanceBackup(standalone, undefined, alias)).rejects.toThrow("symlink");
      await expect(stageInstanceBackup(join(alias, "selected.db"))).rejects.toThrow("symlink");
      await expect(createInstanceBackup({ source, destinationPath: join(alias, "output.tar.gz") })).rejects.toThrow(
        "symlink",
      );
      expect(readdirSync(realTemp)).toEqual(["selected.db"]);
    } finally {
      if (originalTmpdir === undefined) delete process.env[tempKey];
      else process.env[tempKey] = originalTmpdir;
    }
  });

  it("captures committed WAL writes without requiring the live writer to close", async () => {
    const source = fixture("source");
    const db = new Database(source.databasePath);
    try {
      db.exec("PRAGMA journal_mode = WAL");
      db.query("UPDATE sample SET value = ?").run("committed-wal-state");
      const staged = await stage(await backup(source));
      expect(databaseValue(staged.databasePath)).toBe("committed-wal-state");
      expect(existsSync(`${staged.databasePath}-wal`)).toBe(false);
    } finally {
      db.close();
    }
  });

  it("requires effective auth secret and never overwrites an existing destination", async () => {
    const source = fixture("source");
    await expect(
      createInstanceBackup({ source, destinationPath: join(source.dataDir, "logs", "archive.tar.gz") }),
    ).rejects.toThrow("overlaps a captured component");
    writeFileSync(source.configPath as string, "HOST=0.0.0.0\n");
    await expect(backup(source)).rejects.toThrow("authentication secret");
    const target = join(root, "existing");
    put(target, "retain");
    await expect(
      createInstanceBackup({ source, destinationPath: target, effectiveConfig: { BETTER_AUTH_SECRET: secret } }),
    ).rejects.toThrow("already exists");
    expect(readFileSync(target, "utf8")).toBe("retain");
    expect(readdirSync(root).some((name) => name.startsWith(".backup-capture"))).toBe(false);
  });

  it("refuses to silently omit identities required by enrolled nodes or local channel principals", async () => {
    const source = fixture("source");
    const db = new Database(source.databasePath);
    db.exec(
      "CREATE TABLE nodes(id TEXT, kind TEXT, public_key TEXT, encrypt_public_key TEXT); CREATE TABLE subshells(id TEXT, node_id TEXT); CREATE TABLE identities(principal_id TEXT);",
    );
    db.query("INSERT INTO nodes VALUES (?, ?, ?, ?)").run("remote", "agent", "public-key", "encryption-public-key");
    db.query("INSERT INTO subshells VALUES (?, ?)").run("one", "local");
    db.query("INSERT INTO identities VALUES (?)").run("sess:one");
    db.close();
    rmSync(join(source.dataDir, "node-signing.json"));
    await expect(backup(source)).rejects.toThrow("required identity: data/node-signing.json");
    put(join(source.dataDir, "node-signing.json"), "signing-key");
    rmSync(join(source.dataDir, "identities", "sess-one.json"));
    await expect(backup(source)).rejects.toThrow("required identity: data/identities/sess-one.json");
  });

  it("rejects wrong password, truncated ciphertext and authenticated-header tampering", async () => {
    const path = await backup(fixture("source"), "unique archive password");
    await expect(stage(path)).rejects.toThrow("requires a password");
    await expect(stage(path, "wrong")).rejects.toThrow("authentication failed");
    const bytes = readFileSync(path);
    const damaged = Buffer.from(bytes);
    damaged[12] ^= 1;
    put(join(root, "damaged"), damaged);
    await expect(stage(join(root, "damaged"), "unique archive password")).rejects.toThrow("authentication failed");
    for (const offset of [40, bytes.length - 1]) {
      const tampered = Buffer.from(bytes);
      tampered[offset] ^= 1;
      put(join(root, "tampered"), tampered);
      await expect(stage(join(root, "tampered"), "unique archive password")).rejects.toThrow("authentication failed");
    }
    put(join(root, "truncated"), bytes.subarray(0, 20));
    await expect(stage(join(root, "truncated"), "unique archive password")).rejects.toThrow("truncated");
    expect(readdirSync(join(root, "staging"))).toEqual([]);
  });

  it("rejects checksum, version, required components and newer migration mismatches", async () => {
    const path = await backup(fixture("source"));
    const corrupt = await rewriteArchive(path, (payload) => {
      payload["data/logs/server.log"] = "tampered bytes";
    });
    await expect(stage(corrupt)).rejects.toThrow(/size mismatch|checksum/);
    for (const mutation of ["version", "migration", "missing"]) {
      const bad = await rewriteArchive(path, async (payload) => {
        const file = payload["manifest.json"] as Blob;
        const manifest = JSON.parse(await file.text());
        if (mutation === "version") manifest.version = 99;
        if (mutation === "migration") manifest.migrations = ["9999-future"];
        if (mutation === "missing")
          manifest.entries = manifest.entries.filter((entry: { path: string }) => entry.path !== "config/config.env");
        payload["manifest.json"] = JSON.stringify(manifest);
      });
      await expect(stage(bad)).rejects.toThrow(/version|newer server|required component/);
    }
  });

  it("bounds archive size, file count and gzip expansion during streamed extraction", async () => {
    const source = fixture("source");
    await expect(
      createInstanceBackup({ source, destinationPath: join(root, "too-small"), limits: { files: 2 } }),
    ).rejects.toThrow("file count");
    const path = await backup(source);
    await expect(stageInstanceBackup(path, undefined, join(root, "staging"), { archiveBytes: 10 })).rejects.toThrow(
      "archive bytes",
    );
    const bomb = join(root, "bomb.tar.gz");
    put(bomb, gzipSync(Buffer.alloc(1024 * 1024)));
    await expect(
      stageInstanceBackup(bomb, undefined, join(root, "staging"), { expandedBytes: 1024 }),
    ).rejects.toThrow();
    await expect(stageInstanceBackup(path, undefined, join(root, "staging"), { files: 2 })).rejects.toThrow(
      "file count",
    );
  });

  it("rejects path traversal, archived links and source symlinks", async () => {
    for (const path of [
      "../outside",
      "/absolute",
      "data/logs/../../outside",
      "data\\logs\\evil",
      "data/logs/C:evil",
      "data/mcp/generated.json",
    ]) {
      expect(() => validateArchivePath(path)).toThrow();
    }
    const source = fixture("source");
    const path = await backup(source);
    const traversal = await rewriteArchive(path, (payload) => {
      payload["../outside"] = "bad";
    });
    await expect(stage(traversal)).rejects.toThrow();
    symlinkSync(join(source.dataDir, "node-signing.json"), join(source.dataDir, "identities", "linked.json"));
    await expect(backup(source)).rejects.toThrow(/regular files|symlink/);
    const nativeDir = join(root, "tar-link");
    mkdirSync(nativeDir);
    mkdirSync(join(nativeDir, "data", "logs"), { recursive: true });
    symlinkSync("/etc/passwd", join(nativeDir, "data", "logs", "link"));
    const linked = join(root, "linked.tar.gz");
    const process = Bun.spawnSync(["tar", "-czf", linked, "-C", nativeDir, "data/logs/link"]);
    expect(process.exitCode).toBe(0);
    await expect(stage(linked)).rejects.toThrow(/nonregular|links|unsupported/);
    expect(existsSync(join(root, "outside"))).toBe(false);
  });

  it("explicitly accepts standalone legacy .db as database-only and preserves other state", async () => {
    const source = fixture("source");
    const staged = await stage(source.databasePath);
    const destination = fixture("destination", "original");
    expect(staged.legacyDatabaseOnly).toBe(true);
    const transaction = await restoreInstanceBackup(staged, { destination });
    expect(databaseValue(destination.databasePath)).toBe("source");
    expect(readFileSync(join(destination.dataDir, "node-signing.json"), "utf8")).toContain("original-node-key");
    await finalizeInstanceRestore(transaction.journalPath);
  });

  it("rejects active rollback journals and sidecar symlinks without capturing uncommitted pages", async () => {
    const source = fixture("source", "committed");
    const db = new Database(source.databasePath);
    try {
      db.exec(
        "PRAGMA journal_mode=DELETE; PRAGMA cache_size=5; CREATE TABLE filler(bytes BLOB); BEGIN IMMEDIATE; UPDATE sample SET value='uncommitted'",
      );
      for (let index = 0; index < 200; index++) db.query("INSERT INTO filler VALUES(zeroblob(4096))").run();
      expect(existsSync(`${source.databasePath}-journal`)).toBe(true);
      await expect(stage(source.databasePath)).rejects.toThrow("without SQLite sidecars");
      db.exec("ROLLBACK");
      expect(databaseValue(source.databasePath)).toBe("committed");
    } finally {
      db.close();
    }
    for (const suffix of ["-journal", "-wal", "-shm"]) {
      symlinkSync(join(root, "missing-sidecar-target"), `${source.databasePath}${suffix}`);
      await expect(stage(source.databasePath)).rejects.toThrow("without SQLite sidecars");
      rmSync(`${source.databasePath}${suffix}`);
    }
  });

  it("rejects generated SQLite metadata before materializing its expanded scalar", async () => {
    const source = fixture("source");
    const db = new Database(source.databasePath);
    db.exec(
      "DROP TABLE user; CREATE TABLE user(id TEXT, email TEXT, name TEXT GENERATED ALWAYS AS (hex(zeroblob(4*1024*1024))) VIRTUAL); INSERT INTO user(id,email) VALUES('admin-id','admin@example.com')",
    );
    db.close();
    expect(statSync(source.databasePath).size).toBeLessThan(100000);
    await expect(
      stageInstanceBackup(source.databasePath, undefined, join(root, "staging"), {
        archiveBytes: 100000,
        expandedBytes: 100000,
        fileBytes: 100000,
      }),
    ).rejects.toThrow("generated columns");
  });

  it("rejects executable schema triggers before inspection or prepared session deletion", async () => {
    const source = fixture("source");
    const db = new Database(source.databasePath);
    db.exec("CREATE TRIGGER unsafe AFTER UPDATE ON user BEGIN INSERT INTO sample VALUES(hex(zeroblob(10000000))); END");
    db.close();
    await expect(stage(source.databasePath)).rejects.toThrow("triggers");
  });

  it("bounds stored administrator scalars and administrator/migration rows before returning metadata", async () => {
    for (const violation of ["name", "admin-rows", "migration-name", "migration-rows"]) {
      const source = fixture(violation);
      const db = new Database(source.databasePath);
      if (violation === "name") db.query("UPDATE user SET name=?").run("n".repeat(4097));
      if (violation === "admin-rows")
        db.transaction(() => {
          for (let index = 0; index < 1024; index++) {
            db.query("INSERT INTO user VALUES(?,?,?,?)").run(`admin-${index}`, `${index}@example.com`, "Name", "hash");
            db.query("INSERT INTO user_meta VALUES(?,?)").run(`admin-${index}`, "admin");
          }
        })();
      if (violation === "migration-name") db.query("UPDATE kysely_migration SET name=?").run(`0001-${"x".repeat(129)}`);
      if (violation === "migration-rows")
        db.transaction(() => {
          for (let index = 0; index < 256; index++)
            db.query("INSERT INTO kysely_migration VALUES(?,?)").run(`0001-test-${index}`, "timestamp");
        })();
      db.close();
      await expect(stage(source.databasePath)).rejects.toThrow(/metadata (row )?limit/);
    }
  });

  it("refuses small databases with expression indexes or untrusted partial predicates before inspection", async () => {
    for (const kind of ["expression", "partial", "spoofed-shipped"]) {
      const source = fixture(`index-${kind}`);
      const db = new Database(source.databasePath);
      if (kind === "expression") db.exec("CREATE INDEX huge ON plugin_state(hex(zeroblob(4*1024*1024)), enabled)");
      if (kind === "partial")
        db.exec("CREATE INDEX huge ON plugin_state(enabled) WHERE length(hex(zeroblob(4*1024*1024))) > 0");
      if (kind === "spoofed-shipped")
        db.exec(`CREATE TABLE workspaces(user_id TEXT, name TEXT, draft INTEGER);
          CREATE UNIQUE INDEX idx_workspaces_user_name ON workspaces(user_id,name)
          WHERE draft=0 OR length(hex(zeroblob(4*1024*1024))) > 0`);
      expect(db.query("SELECT count(*) AS count FROM plugin_state").get()).toEqual({ count: 0 });
      db.close();
      const size = statSync(source.databasePath).size;
      expect(size).toBeLessThan(100_000);
      await expect(stage(source.databasePath)).rejects.toThrow(
        kind === "expression" ? "expression indexes are refused" : "partial indexes are refused",
      );
      expect(statSync(source.databasePath).size).toBe(size);
    }
  });

  it("accepts the shipped workspace partial index and ordinary NOCASE column indexes", async () => {
    const source = fixture("shipped-index");
    const db = new Database(source.databasePath);
    db.exec(`CREATE TABLE workspaces(user_id TEXT, name TEXT, draft INTEGER);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_user_name
      ON workspaces (user_id, name) WHERE draft = 0;
      CREATE INDEX ordinary ON user(name COLLATE NOCASE)`);
    db.close();
    const staged = await stage(await backup(source));
    const destination = fixture("destination");
    const transaction = await restoreInstanceBackup(staged, { destination, mode: "migration" });
    const restored = new Database(destination.databasePath, { readonly: true });
    expect(restored.query("SELECT partial FROM pragma_index_list('workspaces')").get()).toEqual({ partial: 1 });
    restored.close();
    await finalizeInstanceRestore(transaction.journalPath);
  });

  it("streams larger files intact and preserves an intentionally empty plugin store", async () => {
    const source = fixture("source");
    const text = "0123456789abcdef".repeat(256 * 1024);
    put(join(source.dataDir, "logs", "large.log"), text);
    rmSync(join(source.dataDir, "plugins", "net"), { recursive: true });
    put(join(source.dataDir, "plugins", ".seeded"), JSON.stringify(["terminal", "claude-code", "net"]));
    const staged = await stage(await backup(source));
    expect(readFileSync(join(staged.dir, "data", "logs", "large.log"), "utf8")).toBe(text);
    const destination = fixture("destination");
    const transaction = await restoreInstanceBackup(staged, { destination });
    expect(readdirSync(join(destination.dataDir, "plugins"))).toEqual([".seeded"]);
    expect(readFileSync(join(destination.dataDir, "plugins", ".seeded"), "utf8")).toBe(
      JSON.stringify(["terminal", "claude-code", "net"]),
    );
    await finalizeInstanceRestore(transaction.journalPath);
  });

  it("rejects duplicate tar entries and bounds extended tar metadata natively", async () => {
    const source = fixture("source");
    const original = await backup(source);
    const files = await new Bun.Archive(await Bun.file(original).bytes()).files();
    const archive = pack();
    const chunks: Buffer[] = [];
    archive.on("data", (chunk) => {
      if (!(chunk instanceof Uint8Array)) throw new Error("invalid archive stream chunk");
      chunks.push(Buffer.from(chunk));
    });
    const complete = new Promise<void>((resolve, reject) => {
      archive.on("end", resolve);
      archive.on("error", reject);
    });
    for (const [name, file] of files) archive.entry({ name, type: "file", size: file.size }, await file.bytes());
    archive.entry({ name: "data/logs/server.log", type: "file", size: 0 }, "");
    archive.finalize();
    await complete;
    const duplicate = join(root, "duplicate.tar.gz");
    put(duplicate, gzipSync(Buffer.concat(chunks)));
    await expect(stage(duplicate)).rejects.toThrow("duplicate");

    // Fixture construction only: craft an oversized PAX header, leaving all parsing to tar-stream.
    const tar = Buffer.alloc(512 + 5 * 1024 * 1024 + 1024);
    tar.write("pax-metadata");
    tar.write("0000600\0", 100);
    tar.write("0000000\0", 108);
    tar.write("0000000\0", 116);
    tar.write(`${(5 * 1024 * 1024).toString(8).padStart(11, "0")}\0`, 124);
    tar.write("00000000000\0", 136);
    tar.fill(32, 148, 156);
    tar.write("x", 156);
    tar.write("ustar\0", 257);
    tar.write("00", 263);
    const checksum = tar.subarray(0, 512).reduce((total, byte) => total + byte, 0);
    tar.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148);
    const metadata = join(root, "large-metadata.tar.gz");
    put(metadata, gzipSync(tar));
    await expect(stage(metadata)).rejects.toThrow("Header exceeds max size");
  });
});

describe("compatibility and shared configuration", () => {
  it("pins the maximum backup migration to the provider's latest registered migration", () => {
    const provider = readFileSync(resolve(import.meta.dir, "../../../db/migrate.ts"), "utf8");
    const migrations = [...provider.matchAll(/"(\d{4}-[a-z0-9-]+)":/g)].map((match) => match[1]).sort();
    expect(migrations.at(-1)).toBe(LATEST_BACKUP_MIGRATION);
  });

  it("validates restore addresses with configure's rules and filters arbitrary environment", () => {
    expect(() => validateRestoreConfigOverrides({ trustedOrigins: "https://*" })).toThrow("wildcards");
    expect(() => validateRestoreConfigOverrides({ port: "03080" })).toThrow("leading zero");
    expect(() => validateRestoreConfigOverrides({ baseUrl: "ftp://example" })).toThrow("base-url");
    expect(
      captureConfig("", {
        BETTER_AUTH_SECRET: secret,
        SSH_AUTH_SOCK: "external",
        SUBSHELL_EMERGENCY_PASSWORD: "never",
      }),
    ).toEqual({ BETTER_AUTH_SECRET: secret });
    expect(() => captureConfig(`BETTER_AUTH_SECRET=${secret}`, { HOST: "evil\nKEY=value" })).toThrow("serialize");
    expect(
      restoreConfig(
        `BETTER_AUTH_SECRET=${secret}\nTRUSTED_ORIGINS=https://old`,
        { databasePath: "/new/db", dataDir: "/new/data" },
        { trustedOrigins: "" },
      ),
    ).not.toContain("TRUSTED_ORIGINS");
  });
});
