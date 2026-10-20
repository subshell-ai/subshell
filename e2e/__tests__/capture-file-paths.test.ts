/// <reference types="bun" />
// e2e's tsconfig narrows "types" to node only (its suite is Playwright), so
// the bun ambient types must be pulled in for the one bun-test file here.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// These capture scripts boot a Playwright stack while being evaluated, so they
// can't be imported for behavioral tests, and extracting helpers is a refactor
// the scripts don't need. Pin the file-write structure instead: ffmpeg may
// never write straight into a committed directory, because an encode killed
// mid-write (Ctrl-C, OOM) would otherwise leave a corrupt binary exactly where
// the next commit picks it up. Committed paths may only be written through
// copyFileSync, after the encode already succeeded. (Finding F-V3-capture.)
const docs = readFileSync(new URL("../capture-docs.ts", import.meta.url), "utf8");
const demo = readFileSync(new URL("../capture-product-demo.ts", import.meta.url), "utf8");

function before(src: string, needle: string, chars = 220): string {
  const index = src.indexOf(needle);
  expect(index, `${needle} is gone from the script`).toBeGreaterThanOrEqual(0);
  return src.slice(Math.max(0, index - chars), index);
}

test("capture-docs webp encodes land in the scratch dir and are copied after success", () => {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the capture script's own placeholder text, matched as source, not a JS template
  expect(docs).toContain("const scratch = path.join(project, `${name}.webp`)");
  expect(docs).toContain("if (encoded.status !== 0) throw");
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the capture script's own placeholder text, matched as source, not a JS template
  expect(before(docs, "../apps/website/public/shots/${name}.webp")).toContain("copyFileSync");
});

test("capture-product-demo never hands ffmpeg a committed path", () => {
  expect(demo).not.toMatch(/path\.join\(out, `\$\{name\}\.(mp4|webp)`/);
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the capture script's own placeholder text, matched as source, not a JS template
  expect(demo).toContain("path.join(root, `${name}.mp4`)");
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the capture script's own placeholder text, matched as source, not a JS template
  expect(demo).toContain("path.join(root, `${name}.webp`)");
  expect(demo).toContain('path.join(root, "subshell-demo.gif")');
  expect(before(demo, "../apps/docs/public/screenshots/harness-subagents.png")).toContain("copyFileSync");
  expect(before(demo, "../docs/assets/subshell-demo.gif")).toContain("copyFileSync");
});

test("the demo's CODEX_HOME temp dir gets its .cache parent before mkdtemp", () => {
  const mkdtemp = demo.indexOf('mkdtempSync(path.join(cacheRoot, "subshell-demo-codex-"))');
  expect(mkdtemp).toBeGreaterThanOrEqual(0);
  expect(demo.slice(0, mkdtemp)).toContain("mkdirSync(cacheRoot, { recursive: true })");
});
