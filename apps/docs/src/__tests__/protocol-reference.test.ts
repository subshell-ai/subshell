import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

/**
 * The node-protocol page states the implemented protocol number in prose, and
 * the same page's command table documents protocol-27 commands, so a bump that
 * forgets the sentence leaves the reference contradicting itself. The wire's
 * truth is `NODE_PROTOCOL_VERSION` in `@internal/subshell-protocol`; this
 * package does not depend on it, so the constant is read from source beside the
 * page the way `content-tree.test.ts` reads the MCP server's sources.
 */

const PKG_DIR = path.join(import.meta.dir, "..", "..");
const PAGE = path.join(PKG_DIR, "content", "docs", "reference", "node-protocol.mdx");
const FRAMES = path.join(PKG_DIR, "..", "..", "packages", "subshell-protocol", "src", "node-frames.ts");

describe("protocol reference", () => {
  test("the stated implemented protocol equals NODE_PROTOCOL_VERSION", () => {
    const stated = /The implemented protocol is \*\*(\d+)\*\*/.exec(fs.readFileSync(PAGE, "utf8"));
    expect(stated, "the page must state the implemented protocol").not.toBeNull();
    const shipped = /export const NODE_PROTOCOL_VERSION = (\d+);/.exec(fs.readFileSync(FRAMES, "utf8"));
    expect(shipped, "node-frames.ts must export a numeric NODE_PROTOCOL_VERSION").not.toBeNull();
    expect(stated[1]).toBe(shipped[1]);
  });
});
