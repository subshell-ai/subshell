import { describe, expect, it } from "bun:test";
import { readSubshellDrag, SUBSHELL_DND_TYPE } from "@/lib/subshell-dnd";

/** The two fields `readSubshellDrag` touches — a stand-in for DataTransfer. */
const transfer = (types: string[], values: Record<string, string>) => ({
  types,
  getData: (t: string) => values[t] ?? "",
});

describe("readSubshellDrag", () => {
  it("returns the id when our MIME is present", () => {
    expect(readSubshellDrag(transfer([SUBSHELL_DND_TYPE], { [SUBSHELL_DND_TYPE]: "sub-1" }))).toBe("sub-1");
  });

  it("returns null for a Files-only transfer (a terminal file-upload drag)", () => {
    expect(readSubshellDrag(transfer(["Files"], {}))).toBeNull();
  });

  it("returns null for a text/plain transfer (a dockview tab drag, an OS text drag)", () => {
    expect(readSubshellDrag(transfer(["text/plain"], { "text/plain": "whatever" }))).toBeNull();
  });

  it("returns null when the type is listed but the payload empty", () => {
    expect(readSubshellDrag(transfer([SUBSHELL_DND_TYPE], {}))).toBeNull();
  });
});
