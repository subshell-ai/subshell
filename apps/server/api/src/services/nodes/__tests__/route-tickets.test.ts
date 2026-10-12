import { expect, test } from "bun:test";
import { RouteTickets } from "../route-tickets.js";

test("route tickets expire and can only be redeemed once", () => {
  let now = 1;
  const tickets = new RouteTickets(() => now);
  const token = tickets.issue("secret", "pin");
  expect(token).not.toContain("secret");
  expect(tickets.consume(token)?.nodePublicKey).toBe("pin");
  expect(tickets.consume(token)).toBeUndefined();
  const expired = tickets.issue("secret", "pin");
  now += 15_000;
  expect(tickets.consume(expired)).toBeUndefined();
});
