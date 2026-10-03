import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import { extract, pack } from "tar-stream";
import { privateDirectory, validateArchivePath } from "./paths.js";
import type { BackupEntry, BackupLimits, InstanceBackupManifest } from "./types.js";

/** Count actual streamed bytes, stopping before a resource ceiling is crossed. */
function boundedBytes(max: number, label: string, hash?: ReturnType<typeof createHash>): Transform {
  let bytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > max) {
        callback(new Error(`backup ${label} bytes exceed limit`));
        return;
      }
      hash?.update(chunk);
      callback(null, chunk);
    },
  });
}

/** Stream captured regular files into gzip without buffering tar payloads or invoking a shell. */
export async function writeInstanceTar(
  target: string,
  captureDir: string,
  manifest: InstanceBackupManifest,
  limits: BackupLimits,
): Promise<void> {
  const archive = pack();
  const output = pipeline(
    archive,
    boundedBytes(limits.expandedBytes, "expanded"),
    createGzip(),
    boundedBytes(limits.archiveBytes, "archive"),
    createWriteStream(target, { flags: "wx", mode: 0o600 }),
  );
  // The pipeline owns its rejection while entries are being fed, including output disk failures.
  void output.catch(() => {});
  try {
    const metadata = Buffer.from(JSON.stringify(manifest));
    await new Promise<void>((resolve, reject) => {
      archive.entry(
        { name: "manifest.json", type: "file", size: metadata.length, mode: 0o600, mtime: new Date(0) },
        metadata,
        (error) => (error ? reject(error) : resolve()),
      );
    });
    for (const entry of manifest.entries) {
      const sink = archive.entry({
        name: entry.path,
        type: "file",
        size: entry.bytes,
        mode: 0o600,
        mtime: new Date(0),
      });
      await pipeline(createReadStream(join(captureDir, entry.path)), sink);
    }
    archive.finalize();
    await output;
  } catch (error) {
    archive.destroy(error instanceof Error ? error : new Error(String(error)));
    await Promise.allSettled([output]);
    throw error;
  }
}

/** Stream an archive into private regular files, validating paths/types/counts before writes. */
export async function readInstanceTar(
  source: string,
  destination: string,
  limits: BackupLimits,
): Promise<{
  manifest: unknown;
  entries: Map<string, BackupEntry>;
}> {
  const archive = extract();
  const input = pipeline(
    createReadStream(source),
    boundedBytes(limits.archiveBytes, "archive"),
    createGunzip(),
    boundedBytes(limits.expandedBytes, "expanded"),
    archive,
  );
  void input.catch(() => {});
  const entries = new Map<string, BackupEntry>();
  let manifest: unknown;
  let count = 0;
  const names = new Set<string>();
  try {
    for await (const entry of archive) {
      const header = entry.header;
      validateArchivePath(header.name);
      if (header.type !== "file" || header.linkname)
        throw new Error("backup archive links and nonregular entries are refused");
      if (names.has(header.name)) throw new Error("duplicate archive paths");
      names.add(header.name);
      if (++count > limits.files + 1) throw new Error("backup file count exceeds limit");
      if (!Number.isSafeInteger(header.size) || (header.size ?? -1) < 0 || (header.size ?? 0) > limits.fileBytes) {
        throw new Error("backup file exceeds limit");
      }
      const size = header.size ?? 0;
      if (header.name === "config/config.env" && size > 1024 * 1024)
        throw new Error("backup configuration exceeds limit");
      if (header.name === "manifest.json") {
        if (size > 8 * 1024 * 1024) throw new Error("backup manifest too large");
        const chunks: Buffer[] = [];
        let observed = 0;
        for await (const chunk of entry) {
          if (!(chunk instanceof Uint8Array)) throw new Error("invalid archive stream chunk");
          observed += chunk.length;
          if (observed > size) throw new Error("backup manifest size mismatch");
          chunks.push(Buffer.from(chunk));
        }
        if (observed !== size) throw new Error("backup manifest size mismatch");
        manifest = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        continue;
      }
      const target = join(destination, header.name);
      await privateDirectory(dirname(target));
      const hash = createHash("sha256");
      await pipeline(
        entry,
        boundedBytes(size, "component", hash),
        createWriteStream(target, { flags: "wx", mode: 0o600 }),
      );
      if ((await stat(target)).size !== size) throw new Error("backup component size mismatch");
      entries.set(header.name, { path: header.name, bytes: size, sha256: hash.digest("hex") });
    }
    await input;
    return { manifest, entries };
  } catch (error) {
    archive.destroy(error instanceof Error ? error : new Error(String(error)));
    await Promise.allSettled([input]);
    throw error;
  }
}
