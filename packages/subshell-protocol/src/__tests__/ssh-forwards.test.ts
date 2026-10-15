import { describe, expect, it } from "bun:test";
import {
  isLoopbackForwardBind,
  isSshForwardKind,
  parseSshForwardRows,
  SSH_FORWARD_KINDS,
  SSH_MAX_FORWARD_ROWS,
  type SshForwardWire,
} from "../ssh-forwards.js";

/**
 * The forward-row grammar (spec 2026-10-15 §4). These refusals are the
 * shape half of the security story - the node re-runs this parser on every
 * launch that names forwards, so what renders can never be wider than what
 * this grammar can express. Policy (the wide-bind gate) is deliberately NOT
 * tested here: this module answers "is this a row", never "is this row
 * allowed on this machine".
 */

function makeRow(overrides: Partial<SshForwardWire> = {}): SshForwardWire {
  return {
    kind: "local",
    listenPort: 5432,
    bindHost: null,
    targetHost: "db.internal",
    targetPort: 5432,
    ...overrides,
  };
}

describe("parseSshForwardRows", () => {
  it("round-trips one row of each kind", () => {
    const rows: SshForwardWire[] = [
      makeRow(),
      makeRow({ kind: "remote", listenPort: 9090, bindHost: null, targetHost: "node.internal", targetPort: 3000 }),
      makeRow({ kind: "dynamic", listenPort: 1080, targetHost: null, targetPort: null }),
    ];
    expect(parseSshForwardRows(structuredClone(rows))).toEqual(rows);
  });

  it("treats null and absent as no forwards, and the empty list round-trips", () => {
    expect(parseSshForwardRows(null)).toEqual([]);
    expect(parseSshForwardRows(undefined)).toEqual([]);
    expect(parseSshForwardRows([])).toEqual([]);
  });

  it("accepts a bound row: loopback v4, bracketed v6, and a named host", () => {
    for (const bindHost of ["127.0.0.1", "[::1]", "localhost", "10.0.0.5", "fwd.internal"]) {
      expect(parseSshForwardRows([makeRow({ bindHost })])).toEqual([makeRow({ bindHost })]);
    }
  });

  it("refuses a bare (unbracketed) IPv6 bind: the host grammar wants brackets, same as every other host field", () => {
    expect(parseSshForwardRows([makeRow({ bindHost: "::1" })])).toBeNull();
  });

  it("refuses an option-like leading dash on any host member", () => {
    expect(parseSshForwardRows([makeRow({ bindHost: "-oProxyCommand=evil" })])).toBeNull();
    expect(parseSshForwardRows([makeRow({ targetHost: "-lroot" })])).toBeNull();
  });

  it("refuses a target baked with a port (the grammar keeps port its own field)", () => {
    expect(parseSshForwardRows([makeRow({ targetHost: "db.internal:5432" })])).toBeNull();
  });

  it("refuses an unknown kind and a wrong-case kind (enums are enums)", () => {
    expect(parseSshForwardRows([makeRow({ kind: "tunnel" as SshForwardWire["kind"] })])).toBeNull();
    expect(parseSshForwardRows([{ ...makeRow(), kind: "Local" }])).toBeNull();
  });

  it("refuses ports outside 1..65535 and non-integers", () => {
    for (const listenPort of [0, 65536, -1, 80.5, Number.NaN, "80"]) {
      expect(parseSshForwardRows([makeRow({ listenPort: listenPort as unknown as number })])).toBeNull();
    }
    for (const targetPort of [0, 65536, 1.5]) {
      expect(parseSshForwardRows([makeRow({ targetPort: targetPort as unknown as number })])).toBeNull();
    }
  });

  it("refuses a dynamic row that carries a target (a contradiction, not a hint)", () => {
    expect(parseSshForwardRows([makeRow({ kind: "dynamic", targetHost: "x.example" })])).toBeNull();
    expect(parseSshForwardRows([makeRow({ kind: "dynamic", targetPort: 80 })])).toBeNull();
  });

  it("refuses local/remote rows missing a target member", () => {
    expect(parseSshForwardRows([{ kind: "local", listenPort: 5432, bindHost: null }])).toBeNull();
    expect(parseSshForwardRows([{ kind: "remote", listenPort: 9090, bindHost: null, targetHost: "h" }])).toBeNull();
  });

  it("refuses an absent or non-null bindHost member: presence is required, null is the default spelling", () => {
    expect(parseSshForwardRows([{ kind: "local", listenPort: 5432, targetHost: "h", targetPort: 1 }])).toBeNull();
    expect(parseSshForwardRows([makeRow({ bindHost: "" })])).toBeNull();
  });

  it("refuses a row with an unknown key rather than dropping it", () => {
    expect(parseSshForwardRows([{ ...makeRow(), extra: true }])).toBeNull();
  });

  it("refuses a duplicate listen end, case-insensitively on the name", () => {
    expect(parseSshForwardRows([makeRow(), makeRow({ targetHost: "other.example" })])).toBeNull();
    expect(parseSshForwardRows([makeRow({ bindHost: "LOCALHOST" }), makeRow({ bindHost: "localhost" })])).toBeNull();
  });

  it("accepts two rows on one port under different literal names (the bind race is ssh's warning, not this grammar's)", () => {
    const rows = [makeRow({ bindHost: "localhost" }), makeRow({ bindHost: "127.0.0.1" })];
    expect(parseSshForwardRows(rows)).toEqual(rows);
  });

  it("refuses a non-array list", () => {
    expect(parseSshForwardRows({ 0: makeRow() })).toBeNull();
    expect(parseSshForwardRows("local")).toBeNull();
    expect(parseSshForwardRows([null, undefined, 42, []])).toBeNull();
  });

  it("refuses over the cap rather than truncating", () => {
    const over = Array.from({ length: SSH_MAX_FORWARD_ROWS + 1 }, (_, i) => makeRow({ listenPort: i + 1 }));
    expect(parseSshForwardRows(over)).toBeNull();
    const atCap = over.slice(0, SSH_MAX_FORWARD_ROWS);
    expect(parseSshForwardRows(atCap)).toEqual(atCap);
  });

  it("returns rebuilt rows, never the input objects (stray-array mutation cannot ride along)", () => {
    const input = [makeRow()];
    const parsed = parseSshForwardRows(input) ?? [];
    expect(parsed).toEqual(input);
    expect(parsed[0]).not.toBe(input[0]);
  });
});

describe("isLoopbackForwardBind", () => {
  const loopback = [null, "localhost", "LOCALHOST", "Localhost", "[::1]", "127.0.0.1", "127.9.9.9", "127.0.0.0"];
  for (const bindHost of loopback) {
    it(`confines ${bindHost ?? "(omitted)"}`, () => {
      expect(isLoopbackForwardBind(makeRow({ bindHost }))).toBe(true);
    });
  }
  const wide = ["0.0.0.0", "::", "[::]", "10.0.0.5", "example.com", "[::ffff:127.0.0.1]", "mybox.internal"];
  for (const bindHost of wide) {
    it(`names ${bindHost} wide (fails closed: the test is the written name, not a DNS answer)`, () => {
      expect(isLoopbackForwardBind(makeRow({ bindHost }))).toBe(false);
    });
  }
});

describe("SSH_FORWARD_KINDS / isSshForwardKind", () => {
  it("the runtime list matches the type census", () => {
    expect([...SSH_FORWARD_KINDS].sort()).toEqual(["dynamic", "local", "remote"]);
  });
  it("accepts exactly the named kinds, case-sensitively", () => {
    for (const kind of SSH_FORWARD_KINDS) expect(isSshForwardKind(kind)).toBe(true);
    expect(isSshForwardKind("LOCAL")).toBe(false);
    expect(isSshForwardKind(undefined)).toBe(false);
  });
});
