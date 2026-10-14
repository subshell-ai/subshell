import { afterEach, describe, expect, it } from "bun:test";
import { ApiError, apiFetch, parseErrorBody } from "../api";

/**
 * `ApiError.body` (Task 3's un-truncation): the display message is a
 * `API <status>: <detail>` string sliced to 200 chars, and a structured
 * refusal body can be longer than the slice. The parsed JSON object must
 * survive on `err.body` so a renderer (the SSH launcher's 422 `outcome`)
 * reads the WHOLE answer; the message stays byte-identical, and a legacy
 * text body carries no `body` at all.
 */
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("ApiError.body", () => {
  it("keeps a 422-shaped outcome on err.body even when the message is sliced to 200 chars", async () => {
    // The launch route answers the refused resolve with `{outcome}` — NOT the
    // standard envelope — so `message` there is the raw JSON text and the
    // slice lands mid-body. Many blocking settings push it past 200 chars.
    const settings = Array.from({ length: 40 }, (_, i) => `BlockingSetting${i}`);
    const body = { outcome: { accepted: false, code: "unsupported_setting", settings } };
    const raw = JSON.stringify(body);
    expect(raw.length).toBeGreaterThan(200); // the slice is actually exercised
    globalThis.fetch = (async () => new Response(raw, { status: 422 })) as unknown as typeof fetch;
    const err = (await apiFetch("/api/ssh/launch", { method: "POST", body: "{}" }).catch(
      (e: unknown) => e,
    )) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(422);
    // The display string is byte-identical to the old sliced form.
    expect(err.message).toBe(`API 422: ${raw.slice(0, 200)}`);
    // The whole refusal survived the slice: every setting is readable.
    const outcome = (err.body as { outcome: { accepted: boolean; code: string; settings: string[] } }).outcome;
    expect(outcome.accepted).toBe(false);
    expect(outcome.settings).toEqual(settings);
  });

  it("carries the parsed envelope too (code/errId unchanged, body added)", async () => {
    const body = { errId: "e1", code: "SSH_GATE_OFF", message: "Subshell SSH is off on this machine", statusCode: 403 };
    globalThis.fetch = (async () => new Response(JSON.stringify(body), { status: 403 })) as unknown as typeof fetch;
    const err = (await apiFetch("/api/ssh/launch").catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(403);
    expect(err.code).toBe("SSH_GATE_OFF");
    expect(err.errId).toBe("e1");
    expect(err.message).toBe("API 403: Subshell SSH is off on this machine");
    expect(err.body).toEqual(body);
  });

  it("leaves body undefined for a legacy plain-text failure (nothing to keep)", async () => {
    globalThis.fetch = (async () => new Response("Bad Gateway", { status: 502 })) as unknown as typeof fetch;
    const err = (await apiFetch("/api/anything").catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toBe("API 502: Bad Gateway");
    expect(err.body).toBeUndefined();
  });

  it("parseErrorBody hands the object to every caller unchanged", () => {
    const parsed = parseErrorBody(JSON.stringify({ outcome: { accepted: false } }));
    expect(parsed.message).toContain("outcome"); // no `message` key: raw text stands
    expect(parsed.body).toEqual({ outcome: { accepted: false } });
    expect(parseErrorBody("plain").body).toBeUndefined();
  });
});
