import { describe, expect, it } from "bun:test";
import {
  EMPTY_SSH_FORWARD_ROW,
  type SshForwardDraftRow,
  sshForwardListProblems,
  sshForwardRowProblems,
  sshForwardRowsFromWire,
  sshForwardRowsToWire,
} from "@/lib/ssh-forwards";

/** The form-side mirror of the launch-time refusals (spec 2026-10-15). */
function row(over: Partial<SshForwardDraftRow> = {}): SshForwardDraftRow {
  return { kind: "local", listenPort: "5432", bindHost: "", targetHost: "db.internal", targetPort: "5432", ...over };
}

describe("sshForwardRowProblems", () => {
  it("accepts a complete local row and a dynamic row with no target", () => {
    expect(sshForwardRowProblems(row())).toBeNull();
    expect(sshForwardRowProblems(row({ kind: "dynamic", targetHost: "", targetPort: "" }))).toBeNull();
  });

  it("refuses ports outside the range and non-numbers", () => {
    for (const listenPort of ["", "0", "65536", "abc", "1.5", "-1"]) {
      expect(sshForwardRowProblems(row({ listenPort }))).toMatch(/listen port/i);
    }
    expect(sshForwardRowProblems(row({ targetPort: "0" }))).toMatch(/target port/i);
  });

  it("refuses a local or remote row with no target host", () => {
    expect(sshForwardRowProblems(row({ targetHost: "" }))).toMatch(/host to reach/i);
    expect(sshForwardRowProblems(row({ kind: "remote", targetHost: "" }))).toMatch(/host to reach/i);
    // dynamic carries no target at all, so blank is correct there.
    expect(sshForwardRowProblems(row({ kind: "dynamic", targetHost: "", targetPort: "" }))).toBeNull();
  });

  it("refuses option-like or space-bearing bind hosts, and accepts blanks", () => {
    expect(sshForwardRowProblems(row({ bindHost: "-oProxyCommand=x" }))).toMatch(/bind host/i);
    expect(sshForwardRowProblems(row({ bindHost: "two words" }))).toMatch(/bind host/i);
    expect(sshForwardRowProblems(row({ bindHost: "" }))).toBeNull();
    expect(sshForwardRowProblems(row({ bindHost: "10.0.0.5" }))).toBeNull();
    expect(sshForwardRowProblems(row({ bindHost: "[::1]" }))).toBeNull();
  });
});

describe("sshForwardListProblems", () => {
  it("an all-empty list (including untouched blank rows) is ready", () => {
    expect(sshForwardListProblems([])).toBeNull();
    expect(sshForwardListProblems([EMPTY_SSH_FORWARD_ROW, { ...EMPTY_SSH_FORWARD_ROW }])).toBeNull();
  });

  it("refuses two rows binding the same port, case-insensitively on the name", () => {
    expect(sshForwardListProblems([row(), row({ targetHost: "other.internal" })])).toMatch(/same port/i);
    expect(sshForwardListProblems([row({ bindHost: "LOCALHOST" }), row({ bindHost: "localhost" })])).toMatch(
      /same port/i,
    );
    // Different literal names on one port is a bind race ssh reports itself.
    expect(sshForwardListProblems([row({ bindHost: "localhost" }), row({ bindHost: "127.0.0.1" })])).toBeNull();
  });

  it("refuses a blank bind beside an explicit 127.0.0.1, and keeps the remote pair distinct", () => {
    // A blank local bind renders as 127.0.0.1, so the rows are one listener twice.
    expect(sshForwardListProblems([row(), row({ bindHost: "127.0.0.1", targetHost: "other.internal" })])).toMatch(
      /same port/i,
    );
    // A blank remote bind rides the destination's own policy spelling.
    expect(
      sshForwardListProblems([
        row({ kind: "remote", bindHost: "" }),
        row({ kind: "remote", bindHost: "127.0.0.1", targetHost: "other.internal" }),
      ]),
    ).toBeNull();
  });

  it("refuses over the cap", () => {
    const many = Array.from({ length: 17 }, (_, i) => row({ listenPort: String(i + 1) }));
    expect(sshForwardListProblems(many)).toMatch(/at most 16/i);
  });

  it("reports the first row's problem before list rules", () => {
    expect(sshForwardListProblems([row({ listenPort: "" }), row()])).toMatch(/listen port/i);
  });
});

describe("sshForwardRowsToWire", () => {
  it("drops empty rows, parses numbers, and nulls the blanks", () => {
    expect(
      sshForwardRowsToWire([
        row({ listenPort: " 5432 ", targetHost: " db.internal " }),
        EMPTY_SSH_FORWARD_ROW,
        row({ kind: "dynamic", listenPort: "1080", targetHost: "", targetPort: "" }),
      ]),
    ).toEqual([
      { kind: "local", listenPort: 5432, bindHost: null, targetHost: "db.internal", targetPort: 5432 },
      { kind: "dynamic", listenPort: 1080, bindHost: null, targetHost: null, targetPort: null },
    ]);
  });
});

describe("sshForwardRowsFromWire", () => {
  it("round-trips wire rows into form strings and back", () => {
    const wire = [
      { kind: "remote" as const, listenPort: 9090, bindHost: "0.0.0.0", targetHost: "dev.local", targetPort: 3000 },
    ];
    expect(sshForwardRowsToWire(sshForwardRowsFromWire(wire))).toEqual(wire);
    expect(sshForwardRowsFromWire(undefined)).toEqual([]);
  });
});
