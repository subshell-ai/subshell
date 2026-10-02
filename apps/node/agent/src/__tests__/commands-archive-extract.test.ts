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
 * must be inside dataDir (only bytes the relay itself landed), the
 * destination faces the operator allowlist. The hostile-archive refusals are
 * the extractor's tested surface (pane-runtime's tar-archive suite); what is
 * pinned HERE is the executor's grammar and posture.
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
  const staging = join(src.dataDir, "relay", "a.tar.gz");
  const res = await dispatchCommand(src.ctx, { type: "archive_create", root: src.work, stagingPath: staging });
  expect(res.ok).toBe(true);
  return staging;
}

/** Stand in for the plane's relay: land the source's bytes in dst's dataDir. */
function relayTo(dst: { dataDir: string }, sourceStaging: string): string {
  const landed = join(dst.dataDir, "relay", "a.tar.gz");
  mkdirSync(join(dst.dataDir, "relay"), { recursive: true });
  writeFileSync(landed, readFileSync(sourceStaging));
  return landed;
}

describe("archive_extract", () => {
  it("lands the tree additively and answers validator-shaped counts", async () => {
    const src = setup("happy-src");
    const dst = setup("happy-dst");
    const staging = relayTo(dst, await buildArchive(src));
    // Pre-existing destination state: one overwritten, one left alone.
    mkdirSync(join(dst.work, "sub"), { recursive: true });
    writeFileSync(join(dst.work, "one.txt"), "OLD CONTENT");
    writeFileSync(join(dst.work, "keep.txt"), "untouched");
    const res = await dispatchCommand(dst.ctx, { type: "archive_extract", archivePath: staging, destRoot: dst.work });
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

    const outsideArchive = await dispatchCommand(dst.ctx, {
      type: "archive_extract",
      archivePath: join(src.work, "one.txt"), // not even an archive, and outside dataDir anyway
      destRoot: dst.work,
    });
    expect(outsideArchive.ok).toBe(false);
    if (outsideArchive.ok) return;
    expect(outsideArchive.error).toContain("data directory");

    writeAllowedDirs(dst.dataDir, [join(base, "nowhere")]);
    const refused = await dispatchCommand(dst.ctx, {
      type: "archive_extract",
      archivePath: relayTo(dst, staging),
      destRoot: dst.work,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error).toContain("allowed directories");
    expect(existsSync(join(dst.work, "one.txt"))).toBe(false); // refusal wrote nothing
  });

  it("a corrupt archive refuses with the format error and lands nothing through it", async () => {
    const { dataDir, work, ctx } = setup("corrupt");
    const fake = join(dataDir, "fake.tar.gz");
    writeFileSync(fake, "this is not gzip");
    const res = await dispatchCommand(ctx, { type: "archive_extract", archivePath: fake, destRoot: work });
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
    const res = await dispatchCommand(dst.ctx, {
      type: "archive_extract",
      archivePath: relayTo(dst, staging),
      destRoot: linkRoot,
    });
    // destRoot resolves through the symlink OUTSIDE the allowlist -> refusal.
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("allowed directories");
    expect(existsSync(join(elsewhere, "one.txt"))).toBe(false);
  });
});
