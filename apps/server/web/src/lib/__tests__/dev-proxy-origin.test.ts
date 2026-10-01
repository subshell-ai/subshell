import { expect, test } from "bun:test";
import { devProxyOrigin } from "../dev-proxy-origin";

const known = ["http://172.16.1.197:5174", "http://localhost:5174", "http://[::1]:5174"];

test("translates only exact known dev origins to the trusted localhost dev origin", () => {
  for (const origin of known) expect(devProxyOrigin(origin, known)).toBe("http://localhost:5174");
});

test("preserves foreign, opaque, missing, and different-port origins for backend validation", () => {
  for (const origin of [
    undefined,
    "null",
    "https://attacker.example",
    "http://172.16.1.197:9999",
    "http://localhost:5174.attacker.example",
  ]) {
    expect(devProxyOrigin(origin, known)).toBe(origin);
  }
});
