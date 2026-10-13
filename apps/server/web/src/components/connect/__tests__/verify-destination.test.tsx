import { afterEach, expect, test } from "bun:test";
import { ApiError, setConfirmHandler } from "@internal/node-admin";
import { launchWithDestinationVerification } from "@/components/connect/verify-destination";
import type { SshLaunchRequest, SshLaunchResponse } from "@/lib/ssh";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  setConfirmHandler(null);
});
const request: SshLaunchRequest = {
  node: "connecting",
  destination: "user@host:22",
  keyHome: "keys",
  fingerprints: ["SHA256:key"],
};
const result = { subshell: { id: "pane" } } as SshLaunchResponse;
const missing = () => new ApiError(409, "First connection", { code: "SSH_HOST_PIN_MISSING" });
function wire(accept: boolean) {
  const calls: { path: string; body: unknown }[] = [];
  setConfirmHandler(async (options) => {
    expect(options.confirmLabel).toBe("Trust and connect");
    return accept;
  });
  globalThis.fetch = (async (path, init) => {
    calls.push({ path: String(path), body: JSON.parse(String(init?.body)) });
    return new Response(
      JSON.stringify(
        String(path).endsWith("/accept")
          ? { accepted: true }
          : { token: "bound-check", destination: "user@host:22", fingerprint: "SHA256:host" },
      ),
      { headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  return calls;
}
test("cancelling discovery writes no trust and does not retry launch", async () => {
  const calls = wire(false);
  let launches = 0;
  expect(
    await launchWithDestinationVerification(request, async () => {
      launches++;
      throw missing();
    }),
  ).toBeNull();
  expect(launches).toBe(1);
  expect(calls.map((call) => call.path)).toEqual(["/api/ssh/verify-destination"]);
});
test("confirmation accepts only the server-issued check before retrying the same launch", async () => {
  const calls = wire(true);
  let launches = 0;
  expect(
    await launchWithDestinationVerification(request, async (sent) => {
      expect(sent).toEqual(request);
      if (++launches === 1) throw missing();
      return result;
    }),
  ).toEqual(result);
  expect(launches).toBe(2);
  expect(calls[1]).toEqual({ path: "/api/ssh/verify-destination/accept", body: { token: "bound-check" } });
});
test("a changed identity never offers first-connection acceptance", async () => {
  const calls = wire(true);
  const changed = new ApiError(409, "Changed identity", { code: "SSH_HOST_PIN_CHANGED" });
  await expect(
    launchWithDestinationVerification(request, async () => {
      throw changed;
    }),
  ).rejects.toBe(changed);
  expect(calls).toEqual([]);
});
