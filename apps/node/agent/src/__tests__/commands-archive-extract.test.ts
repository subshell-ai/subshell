import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseNodeArchiveExtractResult } from "@internal/subshell-protocol";
import { writeAllowedDirs } from "../allowed-dirs.js";
import type { CommandContext } from "../commands/context.js";
import { dispatchCommand } from "../commands/index.js";
import type { NodeConfig } from "../config.js";
import { SubshellMetaStore } from "../subshell-meta.js";

/**
 * Spec 2026-10-01 §4: `archive_extract` lands a relayed archive ADDITIVELY,
 * and this executor adds the policy layer over the format guards: the archive
 * must be inside the transfers staging subtree (only bytes the relay itself
 * landed), the destination faces the operator allowlist, and the landed file
 * is re-hashed against the named digest before a single entry is written.
 * The hostile-archive refusals are the extractor's tested surface
 * (pane-runtime's tar-archive suite); what is pinned HERE is the executor's
 * grammar and posture.
 */

let base: string;

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "subshell-archive-extract-")));
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

function setup(tag: string): { dataDir: string; work: string; ctx: CommandContext } {
  const root = join(base, tag);
  const dataDir = join(root, "data");
  const work = join(root, "work");
  for (const d of [dataDir, work]) mkdirSync(d, { recursive: true });
  const config: NodeConfig = {
    serverUrl: "http://localhost:1",
    nodeId: "node-1",
    nodeKey: "k",
    controlPublicKey: "{}",
    dataDir,
    name: "test-node",
  };
  return {
    dataDir,
    work,
    ctx: {
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
    },
  };
}

/** Build a real archive the full way: archive_create on a source tree. */
async function buildArchive(src: { ctx: CommandContext; dataDir: string; work: string }): Promise<string> {
  mkdirSync(join(src.work, "sub"), { recursive: true });
  writeFileSync(join(src.work, "one.txt"), "one\n");
  writeFileSync(join(src.work, "sub", "two.txt"), "two\n");
  const staging = join(src.dataDir, "transfers", "a.tar.gz");
  const res = await dispatchCommand(src.ctx, { type: "archive_create", root: src.work, stagingPath: staging });
  expect(res.ok).toBe(true);
  return staging;
}

/** Stand in for the plane's relay: land the source's bytes in dst's dataDir. */
function relayTo(dst: { dataDir: string }, sourceStaging: string): string {
  // The plane mints staging under `transfers/`; the write and extract gates
  // both require that subtree, so the test lands it there too.
  const landed = join(dst.dataDir, "transfers", "a.tar.gz");
  mkdirSync(join(dst.dataDir, "transfers"), { recursive: true });
  writeFileSync(landed, readFileSync(sourceStaging));
  return landed;
}

/** The digest the (honest) plane names on the extract command. */
const shaOf = (path: string): string => new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");

describe("archive_extract", () => {
  it("lands the tree additively and answers validator-shaped counts", async () => {
    const src = setup("happy-src");
    const dst = setup("happy-dst");
    const staging = relayTo(dst, await buildArchive(src));
    // Pre-existing destination state: one overwritten, one left alone.
    mkdirSync(join(dst.work, "sub"), { recursive: true });
    writeFileSync(join(dst.work, "one.txt"), "OLD CONTENT");
    writeFileSync(join(dst.work, "keep.txt"), "untouched");
    const res = await dispatchCommand(dst.ctx, {
      type: "archive_extract",
      archivePath: staging,
      expectedSha256: shaOf(staging),
      destRoot: dst.work,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(parseNodeArchiveExtractResult(res.data)).toEqual({ files: 2, bytes: 8 });
    expect(readFileSync(join(dst.work, "one.txt"), "utf8")).toBe("one\n"); // overwritten
    expect(readFileSync(join(dst.work, "keep.txt"), "utf8")).toBe("untouched"); // additive
    expect(readFileSync(join(dst.work, "sub", "two.txt"), "utf8")).toBe("two\n");
  });

  it("refuses an archive outside dataDir and a destRoot outside the allowlist", async () => {
    const src = setup("gate-src");
    const dst = setup("gate-dst");
    const staging = await buildArchive(src);
    const relayed = relayTo(dst, staging);

    const outsideArchive = await dispatchCommand(dst.ctx, {
      type: "archive_extract",
      archivePath: join(src.work, "one.txt"), // not even an archive, and outside dataDir anyway
      expectedSha256: shaOf(join(src.work, "one.txt")),
      destRoot: dst.work,
    });
    expect(outsideArchive.ok).toBe(false);
    if (outsideArchive.ok) return;
    expect(outsideArchive.error).toContain("data directory");

    writeAllowedDirs(dst.dataDir, [join(base, "nowhere")]);
    const refused = await dispatchCommand(dst.ctx, {
      type: "archive_extract",
      archivePath: relayed,
      expectedSha256: shaOf(relayed),
      destRoot: dst.work,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error).toContain("allowed directories");
    expect(existsSync(join(dst.work, "one.txt"))).toBe(false); // refusal wrote nothing
  });

  it("a landed file that does not match the named digest refuses BEFORE extraction", async () => {
    const src = setup("digest-src");
    const dst = setup("digest-dst");
    const staging = relayTo(dst, await buildArchive(src));
    const honest = shaOf(staging);
    // The disk lies between relay and extract (corruption, a swap): the
    // plane's window-verify passed over the wire it saw; this is the check
    // on the bytes THIS disk now holds.
    writeFileSync(staging, "flipped after the relay");
    const res = await dispatchCommand(dst.ctx, {
      type: "archive_extract",
      archivePath: staging,
      expectedSha256: honest,
      destRoot: dst.work,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("digest mismatch");
    expect(existsSync(join(dst.work, "one.txt"))).toBe(false); // nothing extracted
  });

  it("a corrupt archive refuses with the format error and lands nothing through it", async () => {
    const { dataDir, work, ctx } = setup("corrupt");
    mkdirSync(join(dataDir, "transfers"), { recursive: true });
    const fake = join(dataDir, "transfers", "fake.tar.gz");
    writeFileSync(fake, "this is not gzip");
    const res = await dispatchCommand(ctx, {
      type: "archive_extract",
      archivePath: fake,
      expectedSha256: shaOf(fake),
      destRoot: work,
    });
    expect(res.ok).toBe(false);
    // Nothing landed at the destination from garbage:
    expect(lstatSync(work).isDirectory()).toBe(true);
    expect(existsSync(join(work, "anything"))).toBe(false);
  });

  it("extracting onto a symlinked destination path is refused by the format guard, not silently followed", async () => {
    const src = setup("link-src");
    const dst = setup("link-dst");
    const staging = await buildArchive(src);
    // The allowlist covers dst.work; extraction into a nested dir whose
    // component is a symlink escaping the allowlist must fail closed.
    const elsewhere = join(base, "link-dst-escape");
    mkdirSync(elsewhere, { recursive: true });
    const linkRoot = join(dst.work, "linked");
    symlinkSync(elsewhere, linkRoot);
    writeAllowedDirs(dst.dataDir, [dst.work]);
    const landed = relayTo(dst, staging);
    const res = await dispatchCommand(dst.ctx, {
      type: "archive_extract",
      archivePath: landed,
      expectedSha256: shaOf(landed),
      destRoot: linkRoot,
    });
    // destRoot resolves through the symlink OUTSIDE the allowlist -> refusal.
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("allowed directories");
    expect(existsSync(join(elsewhere, "one.txt"))).toBe(false);
  });
});
