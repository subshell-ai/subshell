import { describe, expect, it } from "bun:test";
import { extractTgz } from "../tar-vendor.js";
import { handBuiltTgz, makeTgz } from "./helpers/tgz-fixture.js";

describe("extractTgz", () => {
  it("unpacks files and strips npm's package/ prefix", () => {
    const tgz = makeTgz([
      { path: "package/package.json", content: '{"name":"x"}' },
      { path: "package/dist/index.js", content: "export default 1;" },
    ]);
    const out = extractTgz(tgz);
    expect(out.map((e) => e.path).sort()).toEqual(["dist/index.js", "package.json"]);
    expect(new TextDecoder().decode(out.find((e) => e.path === "package.json")?.content)).toBe('{"name":"x"}');
  });

  it("skips directory entries but keeps their file paths", () => {
    const out = extractTgz(
      makeTgz([
        { path: "package/dist", content: "", type: "5" },
        { path: "package/dist/i.js", content: "x" },
      ]),
    );
    expect(out.map((e) => e.path)).toEqual(["dist/i.js"]);
  });

  it("refuses an absolute entry path", () => {
    expect(() => extractTgz(makeTgz([{ path: "/etc/passwd", content: "x" }]))).toThrow(/path/);
  });

  it("refuses a traversal path", () => {
    expect(() => extractTgz(makeTgz([{ path: "package/../../x", content: "x" }]))).toThrow(/path/);
  });

  it("refuses symlinks and hard links outright", () => {
    for (const type of ["2", "1"] as const) {
      expect(() => extractTgz(makeTgz([{ path: "package/x", content: "", type }]))).toThrow(/type/);
    }
  });

  it("refuses an oversize entry and an over-many entries (limits are injectable)", () => {
    expect(() =>
      extractTgz(makeTgz([{ path: "package/big", content: "x".repeat(4096) }]), { maxTotalBytes: 100 }),
    ).toThrow(/size/i);
    expect(() =>
      extractTgz(
        makeTgz([
          { path: "a", content: "1" },
          { path: "b", content: "2" },
        ]),
        { maxEntries: 1 },
      ),
    ).toThrow(/entries/i);
  });

  it("refuses a truncated archive (header past the end)", () => {
    const tgz = makeTgz([{ path: "package/a", content: "hello" }]);
    expect(() => extractTgz(tgz.subarray(0, tgz.length - 258))).toThrow();
  });

  it("refuses a tar body cut short inside a VALID gzip", () => {
    // The case the gzip-CRC test cannot reach: valid compression, tar bytes
    // that end mid-entry, so the declared size runs past the buffer. Without
    // the body-length guard the reader returns a silently truncated file.
    const tgz = makeTgz([{ path: "package/a", content: "x".repeat(600) }]);
    const tar = new Uint8Array(Bun.gunzipSync(tgz));
    const cut = Bun.gzipSync(tar.subarray(0, 1000)) as Uint8Array;
    expect(() => extractTgz(cut)).toThrow(/truncated/);
  });

  it("honours a pax 'path' override for the NEXT entry — and only the next", () => {
    // Built by hand: makeTgz cannot emit a >100-char name field, which is the
    // whole reason pax exists. The assertion must see the LONG path come back
    // — a test that only checked an unrelated file survived would pass with
    // the pax branch deleted — AND that the override did not leak past entry 2.
    const long = `package/${"d".repeat(120)}/index.js`;
    const pair = `path=${long}`;
    // POSIX pax record: "<len> <pair>\n" where <len> counts every byte of the
    // record, its own digits included. Iterate to the fixed point.
    let len = pair.length + 3;
    while (`${len} ${pair}\n`.length !== len) len++;
    const pax = new TextEncoder().encode(`${len} ${pair}\n`);
    // entry 1: typeflag "x", the pax body; entry 2: a regular file whose own
    // name field is short garbage that MUST be ignored in favour of the pax
    // path; entry 3: proof the override applied to ONE entry only.
    const tgz = handBuiltTgz([
      { name: "PaxHeaders.x", typeflag: "x", body: pax },
      { name: "short.js", typeflag: "0", body: new TextEncoder().encode("x") },
      { name: "next.js", typeflag: "0", body: new TextEncoder().encode("y") },
    ]);
    const out = extractTgz(tgz);
    expect(out.map((e) => e.path)).toEqual([`${"d".repeat(120)}/index.js`, "next.js"]);
    expect(new TextDecoder().decode(out[0].content)).toBe("x");
  });

  it("decodes a pax \\xNN escape in the override path", () => {
    // Defensive branch, not observed behavior: POSIX pax escapes in OCTAL
    // (bsdtar follows it) and node-tar — npm's producer — escapes nothing.
    // If an override ever does carry hex, the reader must turn it back or
    // the escaped name ships mangled.
    const pair = "path=weird\\x3aname.js";
    let len = pair.length + 3;
    while (`${len} ${pair}\n`.length !== len) len++;
    const pax = new TextEncoder().encode(`${len} ${pair}\n`);
    const out = extractTgz(
      handBuiltTgz([
        { name: "PaxHeaders", typeflag: "x", body: pax },
        { name: "s.js", typeflag: "0", body: new TextEncoder().encode("x") },
      ]),
    );
    expect(out.map((e) => e.path)).toEqual(["weird:name.js"]);
  });

  it("joins the ustar prefix field for paths too long for one field", () => {
    // The other >100-char mechanism (GNU tar's split name, no pax involved).
    const prefix = `pkg/${"e".repeat(95)}`;
    const out = extractTgz(
      handBuiltTgz([{ name: "index.js", prefix, typeflag: "0", body: new TextEncoder().encode("x") }]),
    );
    expect(out.map((e) => e.path)).toEqual([`${prefix}/index.js`]);
  });

  it("refuses an entry with no name at all", () => {
    expect(() => extractTgz(makeTgz([{ path: "", content: "x" }]))).toThrow(/path/);
  });
});
