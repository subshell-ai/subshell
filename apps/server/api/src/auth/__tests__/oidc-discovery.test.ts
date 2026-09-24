import { afterAll, afterEach, describe, expect, it } from "bun:test";
import {
  DiscoveryError,
  EntryInputError,
  normalizeDomains,
  normalizeEntryOrigin,
  resolveEndpoints,
  slugifyProviderId,
} from "@/auth/oidc-discovery.js";

/**
 * The discovery resolver and the three entry validators (spec 2026-09-24
 * §3/§5/§8). `fetch` is mocked at `globalThis` — the resolver is the only
 * network path here and the route that calls it is tested separately.
 */

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): { urls: string[] } {
  const urls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    return handler(url, init);
  }) as typeof fetch;
  return { urls };
}

const DOC = {
  issuer: "https://idp.example",
  authorization_endpoint: "https://idp.example/authorize",
  token_endpoint: "https://idp.example/token",
  userinfo_endpoint: "https://idp.example/userinfo",
};

describe("resolveEndpoints", () => {
  it("resolves the triple, trailing issuer slashes trimmed", async () => {
    const { urls } = mockFetch(() => Response.json(DOC));
    const r = await resolveEndpoints("https://idp.example///");
    expect(r).toEqual({
      authorizationUrl: "https://idp.example/authorize",
      tokenUrl: "https://idp.example/token",
      userInfoUrl: "https://idp.example/userinfo",
    });
    expect(urls[0]).toBe("https://idp.example/.well-known/openid-configuration");
  });

  it("userInfoUrl is null when the document omits it", async () => {
    mockFetch(() => Response.json({ authorization_endpoint: "a", token_endpoint: "t" }));
    const r = await resolveEndpoints("https://idp.example");
    expect(r.userInfoUrl).toBeNull();
  });

  it("a missing token_endpoint refuses with the reason naming it", async () => {
    mockFetch(() => Response.json({ authorization_endpoint: "a", userinfo_endpoint: "u" }));
    await expect(resolveEndpoints("https://idp.example")).rejects.toThrow(DiscoveryError);
    await expect(resolveEndpoints("https://idp.example")).rejects.toThrow(/has no token_endpoint/);
  });

  it("a non-2xx discovery response refuses", async () => {
    mockFetch(() => new Response("nope", { status: 500 }));
    await expect(resolveEndpoints("https://dead.example")).rejects.toThrow(/discovery returned 500/);
  });

  it("a thrown fetch refuses with the fetch reason", async () => {
    mockFetch(() => {
      throw new TypeError("connection refused");
    });
    await expect(resolveEndpoints("https://dead.example")).rejects.toThrow(/could not be fetched/);
  });
});

describe("normalizeEntryOrigin", () => {
  it("canonicalizes to URL.origin, dropping path/query/fragment", () => {
    expect(normalizeEntryOrigin("https://x.example/path")).toBe("https://x.example");
    expect(normalizeEntryOrigin("https://x.example:8443/a?b=c#d ")).toBe("https://x.example:8443");
    expect(normalizeEntryOrigin("http://localhost:3080")).toBe("http://localhost:3080");
  });

  it("refuses wildcards, non-http schemes, credentials and garbage, naming the entry", () => {
    expect(() => normalizeEntryOrigin("https://*")).toThrow(EntryInputError);
    expect(() => normalizeEntryOrigin("https://*.example")).toThrow(/wildcard/);
    expect(() => normalizeEntryOrigin("ftp://x.example")).toThrow(/scheme/);
    expect(() => normalizeEntryOrigin("https://u:p@x.example")).toThrow(/credentials/);
    expect(() => normalizeEntryOrigin("not a url")).toThrow(/absolute/);
    expect(() => normalizeEntryOrigin("   ")).toThrow(/empty/);
    // The refusal always names what the admin actually sent.
    try {
      normalizeEntryOrigin("https://*");
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toInclude("https://*");
    }
  });
});

describe("normalizeDomains", () => {
  it("lowercases, trims, dedupes; empty input answers []", () => {
    expect(normalizeDomains("")).toEqual([]);
    expect(normalizeDomains(" , ")).toEqual([]);
    expect(normalizeDomains(" Acme.COM , acme.com , other.org ")).toEqual(["acme.com", "other.org"]);
  });

  it("refuses schemes, addresses and wildcards, naming the entry", () => {
    expect(() => normalizeDomains("https://acme.com")).toThrow(EntryInputError);
    expect(() => normalizeDomains("me@acme.com")).toThrow(/acme\.com/);
    expect(() => normalizeDomains("*.acme.com")).toThrow(/wildcard/);
    try {
      normalizeDomains("ok.com,*.acme.com");
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toInclude("*.acme.com");
    }
  });
});

describe("slugifyProviderId", () => {
  it("lowercases, replaces, collapses, trims and caps at 40", () => {
    expect(slugifyProviderId("Acme Corp")).toBe("acme-corp");
    expect(slugifyProviderId("  Acme -- Corp!!  ")).toBe("acme-corp");
    expect(slugifyProviderId("-Acme-")).toBe("acme");
    expect(slugifyProviderId("x".repeat(60))).toHaveLength(40);
  });

  it("refuses a name with no slug characters and the reserved email id", () => {
    expect(() => slugifyProviderId("!! ??")).toThrow(EntryInputError);
    expect(() => slugifyProviderId("Email")).toThrow(/reserved/);
  });
});
