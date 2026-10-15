import { expect, it } from "bun:test";
import { sshDestinationProblem, sshPresetNameProblem } from "@/lib/ssh-input-validation";

it("accepts SSH aliases, explicit users and ports, and bracketed IPv6", () => {
  for (const value of ["build", "user@build", "user@build:2222", "[::1]", "user@[2001:db8::1]:65535"])
    expect(sshDestinationProblem(value)).toBeNull();
});
it("rejects incomplete destinations, unsafe tokens, invalid ports, and oversized input", () => {
  for (const value of [
    "",
    "@host",
    "user@",
    "user@@host",
    "-host",
    "user@-host",
    "host name",
    "host\nname",
    "host:0",
    "host:65536",
    "host:abc",
    "host:",
    "[::1",
    "[::1]oops",
    "[::1]:",
    "::1",
    "a".repeat(254),
  ])
    expect(sshDestinationProblem(value)).not.toBeNull();
});
it("validates names after whitespace checks without rejecting ordinary Unicode", () => {
  for (const name of ["", "   ", "\t", "name\nline", "a".repeat(121)])
    expect(sshPresetNameProblem(name)).not.toBeNull();
  for (const name of [" Build ", "レビュー", "a".repeat(120)]) expect(sshPresetNameProblem(name)).toBeNull();
});
