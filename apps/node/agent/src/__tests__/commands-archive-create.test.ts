import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractTarGz } from "@internal/pane-runtime";
import { type NodeCommandBody, parseNodeArchiveCreateResult } from "@internal/subshell-protocol";
import { writeAllowedDirs } from "../allowed-dirs.js";
import type { CommandContext } from "../commands/context.js";
import { dispatchCommand } from "../commands/index.js";
import type { NodeConfig } from "../config.js";
import { SubshellMetaStore } from "../subshell-meta.js";

/**
 * Spec 2026-10-01 §4: `archive_create` builds the transfer's source archive
 * under the two-gate policy (root on the operator allowlist, staging inside
 * dataDir), streams it node-side, and answers the transport facts over the
 * COMPRESSED file. Answers are run through the wire validator; the extracted
 * bytes are checked by the SAME guarded extractor the destination will use,
 * so writer + agent + extractor are proven together.
 */

let base: string;

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "subshell-archive-create-")));
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

function setup(tag: string): { dataDir: string; work: string; outside: string; ctx: CommandContext } {
  const root = join(base, tag);
  const dataDir = join(root, "data");
  const work = join(root, "work");
  const outside = join(root, "outside");
  for (const d of [dataDir, work, outside]) mkdirSync(d, { recursive: true });
  const config: NodeConfig = {
    serverUrl: "http://localhost:1",
    nodeId: "node-1",
    nodeKey: "k",
    controlPublicKey: "{}",
    dataDir,
    name: "test-node",
  };
  const ctx: CommandContext = {
    config,
    tmux: {} as CommandContext["tmux"],
    meta: new SubshellMetaStore(dataDir),
    nowMs: () => Date.now(),
    ws: { send: () => {} },
    watchers: new Map(),
    tails: new Map(),
    uploads: new Map(),
    runtime: null,
    requestRestart: () => {},
  };
  return { dataDir, work, outside, ctx };
}

async function create(
  ctx: CommandContext,
  args: Partial<Extract<NodeCommandBody, { type: "archive_create" }>> & { root: string; stagingPath: string },
) {
  return await dispatchCommand(ctx, { type: "archive_create", ...args });
}

/** A small tree: nested dirs, an empty dir, a mode, hidden file, long pax name, symlinks. */
function buildTree(work: string, outside: string): void {
  mkdirSync(join(work, "src", "deep"), { recursive: true });
  mkdirSync(join(work, "empty"), { recursive: true });
  writeFileSync(join(work, "src", "a.txt"), "alpha\n");
  const exe = join(work, "src", "run.sh");
  writeFileSync(exe, "#!/bin/sh\necho hi\n");
  chmodSync(exe, 0o755);
  utimesSync(exe, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
  const longName = `src/deep/${"seg-".repeat(20)}long.txt`; // > 100 bytes -> pax
  writeFileSync(join(work, longName), "pax payload");
  writeFileSync(join(work, ".hidden"), "dotfile rides");
  symlinkSync(join(outside, "secret.txt"), join(work, "src", "escape")); // must be SKIPPED
  writeFileSync(join(outside, "secret.txt"), "do not read me");
  symlinkSync(join(work, "src", "a.txt"), join(work, "src", "internal-link")); // skipped too
}

describe("archive_create", () => {
  it("builds the whole tree, streaming, and answers validator-shaped transport facts", async () => {
    const { dataDir, work, outside, ctx } = setup("happy");
    buildTree(work, outside);
    const staging = join(dataDir, "transfers", "uniq-1.tar.gz");
    const res = await create(ctx, { root: work, stagingPath: staging });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const answer = parseNodeArchiveCreateResult(res.data);
    if (!answer) throw new Error("archive_create answered an unparseable result");
    const bytes = readFileSync(staging);
    // The staging file is a PLAINTEXT copy of the tree; it is born 0600 like
    // the destination's temp, not at the umask default.
    expect(statSync(staging).mode & 0o777).toBe(0o600);
    expect(answer.size).toBe(bytes.length);
    // Independent hash of the exact compressed span the destination will see.
    expect(answer.sha256).toBe(new Bun.CryptoHasher("sha256").update(bytes).digest("hex"));

    // Extract with the guarded extractor: everything the transfer promises.
    const out = join(base, "happy-out");
    const r = await extractTarGz(staging, out, { maxFileBytes: 1 << 20, maxTotalBytes: 8 << 20, maxEntries: 100 });
    expect(readFileSync(join(out, "src", "a.txt"), "utf8")).toBe("alpha\n");
    expect(readFileSync(join(out, ".hidden"), "utf8")).toBe("dotfile rides");
    expect(readFileSync(join(out, `src/deep/${"seg-".repeat(20)}long.txt`), "utf8")).toBe("pax payload");
    expect(lstatSync(join(out, "empty")).isDirectory()).toBe(true);
    // Modes and times ride; symlinks were skipped at the walk, both kinds.
    expect(statSync(join(out, "src", "run.sh")).mode & 0o777 & 0o111).not.toBe(0);
    expect(Math.floor(statSync(join(out, "src", "run.sh")).mtimeMs / 1000)).toBe(1_700_000_000);
    expect(() => lstatSync(join(out, "src", "escape"))).toThrow();
    expect(() => lstatSync(join(out, "src", "internal-link"))).toThrow();
    expect(r.files).toBe(4); // a.txt, run.sh, long.txt, .hidden
  });

  it("honors the operator allowlist for root, empty = unrestricted (launch semantics)", async () => {
    const { dataDir, work, outside, ctx } = setup("allowlist");
    writeFileSync(join(work, "f.txt"), "x");
    writeAllowedDirs(dataDir, [outside]); // only `outside` may be an endpoint
    const staging = join(dataDir, "transfers", "s.tar.gz");
    const refused = await create(ctx, { root: work, stagingPath: staging });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error).toContain("allowed directories");
    expect(existsSync(staging)).toBe(false);
    // Root INSIDE the allowlist passes.
    writeAllowedDirs(dataDir, [outside, work]);
    expect((await create(ctx, { root: work, stagingPath: staging })).ok).toBe(true);
  });

  it("refuses staging outside the transfers subtree (twin of file_read's read gate)", async () => {
    const { dataDir, work, ctx } = setup("staging-out");
    writeFileSync(join(work, "f.txt"), "x");
    const sneaky = join(work, "sneaky.tar.gz");
    const res = await create(ctx, { root: work, stagingPath: sneaky });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("data directory");
    expect(existsSync(sneaky)).toBe(false);
    // Even directly INSIDE dataDir is not enough: file_read's admitted
    // subtree is `<dataDir>/transfers/`, and the write gate mirrors it, so a
    // staging file the relay could never read back is refused up front.
    const loose = await create(ctx, { root: work, stagingPath: join(dataDir, "loose.tar.gz") });
    expect(loose.ok).toBe(false);
    expect(existsSync(join(dataDir, "loose.tar.gz"))).toBe(false);
    // Traversal spellings are refused too, and create nothing on the way.
    const traversal = await create(ctx, { root: work, stagingPath: join(dataDir, "..", "evil.tar.gz") });
    expect(traversal.ok).toBe(false);
    expect(existsSync(join(base, "staging-out", "evil.tar.gz"))).toBe(false);
  });

  it("selects a files[] subset with ancestors, and refuses bad entries", async () => {
    const { dataDir, work, outside, ctx } = setup("files-list");
    buildTree(work, outside);
    const staging = join(dataDir, "transfers", "subset.tar.gz");
    const res = await create(ctx, { root: work, files: ["src/a.txt", ".hidden"], stagingPath: staging });
    expect(res.ok).toBe(true);
    const out = join(base, "files-list-out");
    await extractTarGz(staging, out, { maxFileBytes: 1 << 20, maxTotalBytes: 8 << 20, maxEntries: 100 });
    expect(existsSync(join(out, "src", "a.txt"))).toBe(true);
    expect(existsSync(join(out, ".hidden"))).toBe(true);
    expect(existsSync(join(out, "empty"))).toBe(false); // ancestors only: `deep/` not in play
    expect(lstatSync(join(out, "src")).isDirectory()).toBe(true); // the ancestor `src/` is

    // A symlink in the list is refused (it is not a regular file here), a
    // traversal entry never reaches the filesystem, and a listless `files: []`
    // is a legal empty archive rather than a whole-tree create.
    expect(
      (await create(ctx, { root: work, files: ["src/escape"], stagingPath: join(dataDir, "transfers", "l1.tar.gz") }))
        .ok,
    ).toBe(false);
    expect(
      (
        await create(ctx, {
          root: work,
          files: ["../outside/secret.txt"],
          stagingPath: join(dataDir, "transfers", "l2.tar.gz"),
        })
      ).ok,
    ).toBe(false);
    const empty = await create(ctx, { root: work, files: [], stagingPath: join(dataDir, "transfers", "l3.tar.gz") });
    expect(empty.ok).toBe(true);
    const r = await extractTarGz(join(dataDir, "transfers", "l3.tar.gz"), join(base, "files-list-empty"), {
      maxFileBytes: 1 << 20,
      maxTotalBytes: 8 << 20,
      maxEntries: 100,
    });
    expect(r.files).toBe(0);
  });

  it("a failed build leaves no staging file behind", async () => {
    const { dataDir, work, ctx } = setup("cleanup");
    mkdirSync(join(work, "unreadable"), { recursive: true });
    writeFileSync(join(work, "ok.txt"), "x");
    // root missing entirely: refused before anything is written.
    const gone = await create(ctx, { root: join(work, "nope"), stagingPath: join(dataDir, "transfers", "g.tar.gz") });
    expect(gone.ok).toBe(false);
    expect(existsSync(join(dataDir, "transfers", "g.tar.gz"))).toBe(false);
  });
});
