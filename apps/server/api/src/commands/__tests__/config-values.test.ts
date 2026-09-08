import { describe, expect, test } from "bun:test";
import {
  baseUrlPort,
  baseUrlProblem,
  type ConfigKey,
  FLAG_FOR_KEY,
  isLoopbackUrl,
  normalizeTrustedOrigins,
  OPTIONAL_KEYS,
  OWNED_KEYS,
  originProblem,
  validateValue,
} from "../config-values.js";

/**
 * The value rules `init`/`configure` enforce, tested directly rather than
 * through the command that calls them.
 *
 * Worth their own file because each one is the difference between an instance
 * a browser can sign in to and a 403 "Invalid origin" — and because since
 * defaults follow the FILE, every rule here also decides whether an existing
 * config.env still lets the command run at all.
 */

describe("validateValue — SERVER_PORT", () => {
  for (const good of ["1", "80", "3080", "65535"]) {
    test(`accepts ${good}`, () => expect(validateValue("SERVER_PORT", good)).toBeNull());
  }
  for (const bad of ["0", "-1", "65536", "70000", "abc", "1.5", "", " ", "3 080", "080a"]) {
    test(`refuses ${JSON.stringify(bad)}`, () => expect(validateValue("SERVER_PORT", bad)).toMatch(/port/i));
  }

  /**
   * A leading zero is the case where being LOOSER than the boot consumer is
   * actively destructive rather than merely permissive.
   *
   * `/^\d+$/` + a range check accepted "080", so `configure --port 080`
   * exited 0 and wrote `SERVER_PORT=080` — and then env-var's `asPortNumber()`
   * (measured: "should be a valid integer") refused it at import. Since
   * `constants.ts` is imported by every subcommand, that bricks the server AND
   * `status` AND the `configure` run that would repair it: an unbootable
   * instance with no CLI route back. `status` already had the right rule
   * (`String(parsed) === raw`); this makes the writer agree with it.
   */
  test("refuses a non-canonical integer, which the boot would reject after writing it", () => {
    for (const bad of ["080", "0080", "+80", "8_0"]) {
      expect(validateValue("SERVER_PORT", bad), bad).toMatch(/port/i);
    }
  });
});

describe("validateValue — HOST", () => {
  // Deliberately permissive: a bind address can be a name, a v4, a v6 or a
  // wildcard, and the OS is the real judge. Only emptiness is refusable.
  for (const good of ["0.0.0.0", "127.0.0.1", "::", "::1", "box.local"]) {
    test(`accepts ${good}`, () => expect(validateValue("HOST", good)).toBeNull());
  }
  test("refuses an empty host, naming both usual answers", () => {
    const msg = validateValue("HOST", "   ");
    expect(msg).toContain("127.0.0.1");
    expect(msg).toContain("0.0.0.0");
  });
});

describe("validateValue — APP_BASE_URL", () => {
  for (const good of ["http://localhost:3080", "https://subshell.example", "http://10.0.0.5:3080/sub"]) {
    test(`accepts ${good}`, () => expect(validateValue("APP_BASE_URL", good)).toBeNull());
  }
  // A path IS allowed here, unlike an origin: a plane can be mounted under a
  // reverse-proxy subpath, and better-auth's baseURL carries it.
  for (const bad of ["localhost:3080", "ftp://x.example", "not a url", ""]) {
    test(`refuses ${JSON.stringify(bad)}`, () => expect(validateValue("APP_BASE_URL", bad)).toMatch(/base[- ]url/i));
  }
});

describe("validateValue — TRUSTED_ORIGINS", () => {
  test("empty is a real answer: no extra origins", () => {
    expect(validateValue("TRUSTED_ORIGINS", "")).toBeNull();
    expect(validateValue("TRUSTED_ORIGINS", "   ")).toBeNull();
  });

  for (const good of [
    "http://box.local:3080",
    "https://subshell.example",
    "http://box.local:3080,http://10.0.0.5:3080",
    "http://box.local:3080 , http://10.0.0.5:3080",
    "http://[::1]:3080",
  ]) {
    test(`accepts ${JSON.stringify(good)}`, () => expect(validateValue("TRUSTED_ORIGINS", good)).toBeNull());
  }

  /**
   * Spellings that are reasonable to type or paste and that a URL canonicalizes
   * to the same origin a browser would send. Accepting them is only half the
   * job — what gets STORED has to be the canonical form, because both
   * consumers compare against the serialized origin. So each case asserts the
   * stored string, not merely that it was allowed: acceptance and
   * canonicalization drifting apart is the failure that writes a config which
   * 403s while telling the operator it was fine.
   */
  for (const [input, stored] of [
    ["http://box.local:3080/", "http://box.local:3080"], // an address bar's trailing slash
    ["http://Box.Local:3080", "http://box.local:3080"], // hosts are case-insensitive; DNS agrees
    ["http://[0:0:0:0:0:0:0:1]:3080", "http://[::1]:3080"], // the expanded IPv6 form
    ["https://box.local:443", "https://box.local"], // natural for a proxied deployment
    ["http://box.local:80", "http://box.local"],
  ] as const) {
    test(`accepts ${JSON.stringify(input)} and stores ${JSON.stringify(stored)}`, () => {
      expect(validateValue("TRUSTED_ORIGINS", input)).toBeNull();
      expect(normalizeTrustedOrigins(input)).toBe(stored);
    });
  }

  /**
   * Credentials are the one thing NOT canonicalized away. `URL.origin` drops
   * them silently — `http://u:p@box.local:3080` has origin
   * `http://box.local:3080` — so storing the origin would quietly discard a
   * secret the operator typed, and they would never learn it was ignored.
   * Refusing says so.
   */
  test("refuses embedded credentials rather than silently stripping them", () => {
    const msg = validateValue("TRUSTED_ORIGINS", "http://u:p@box.local:3080");
    expect(msg).toMatch(/credential|username|password/i);
  });

  for (const bad of [
    "box.local:3080", // no scheme — the commonest way to write one wrong
    "ftp://box.local:3080", // never a browser origin
    "http://box.local:3080/app", // an origin has no path
    "http://box.local:3080/app/", // …and a trailing slash does not make it one
    "http://box.local:3080#h", // nor a fragment
    "http://box.local:3080,", // a stray comma leaves an empty entry
    ",http://box.local:3080",
    "http://a.local:3080,nope", // one good entry does not excuse the other
  ]) {
    test(`refuses ${JSON.stringify(bad)}`, () => {
      expect(validateValue("TRUSTED_ORIGINS", bad)).toMatch(/trusted origin/i);
    });
  }

  /**
   * A wildcard is NOT an origin, and this is a security boundary rather than a
   * formatting preference.
   *
   * better-auth's `matchesOriginPattern` branches on the pattern: anything
   * containing `*` or `?` goes to `wildcardMatch` instead of the exact
   * `pattern === getOrigin(url)` comparison. Measured against better-auth
   * 1.7.1, `https://*` therefore trusts EVERY https origin — including
   * `https://evil.example` — which dissolves the static allowlist that
   * `docs/security.md` §8 describes as the thing closing the DNS-rebinding
   * hole. (`@elysiajs/cors` would still reject it, but CORS is a browser
   * courtesy, not a server-side gate: a non-browser client sends whatever
   * Origin it likes and only better-auth's check stands in the way.)
   *
   * `URL.origin` round-trips these happily — `new URL("https://*")` parses
   * with host `*` — so nothing in the origin comparison catches them and the
   * refusal has to be explicit. It matters now because this diff put the key
   * behind a CLI flag and a desktop text field; before, only a hand-edit of
   * config.env or an env var could reach it.
   */
  for (const wild of ["https://*", "http://*:3080", "https://*.example.com", "http://box.*.local:3080"]) {
    test(`refuses the wildcard ${JSON.stringify(wild)}`, () => {
      const msg = validateValue("TRUSTED_ORIGINS", wild);
      expect(msg).toMatch(/wildcard/i);
      expect(msg).toContain(wild);
    });
  }

  /**
   * A query is refused twice over, and the overlap is worth naming: `?` is
   * also the wildcard character, so the wildcard guard catches this shape
   * first. The `url.search` check is what would catch it if that guard were
   * ever narrowed — and a mutation run proved the point, since removing
   * `url.search` alone broke nothing until the fragment case above existed.
   */
  test("a query is refused (by the wildcard guard, which owns `?`)", () => {
    expect(validateValue("TRUSTED_ORIGINS", "http://box.local:3080?a=b")).toMatch(/wildcard/i);
  });

  test("a wildcard among valid entries still refuses the whole list", () => {
    expect(validateValue("TRUSTED_ORIGINS", "http://box.local:3080,https://*")).toMatch(/wildcard/i);
  });

  test("the message names the offending ENTRY, not the whole list", () => {
    expect(validateValue("TRUSTED_ORIGINS", "http://a.local:3080,nope")).toContain("nope");
  });
});

describe("validateValue — every key refuses a newline", () => {
  // A value with a newline would smuggle extra KEY=value lines into a file
  // systemd reads as an EnvironmentFile.
  const keys: ConfigKey[] = [...OWNED_KEYS, ...OPTIONAL_KEYS];
  for (const key of keys) {
    test(key, () => {
      expect(validateValue(key, "x\nEVIL=1")).toMatch(/single line/i);
      expect(validateValue(key, "x\rEVIL=1")).toMatch(/single line/i);
    });
  }
});

describe("normalizeTrustedOrigins", () => {
  test("trims entries and drops the trailing slash the validator forgives", () => {
    expect(normalizeTrustedOrigins("  http://a.local:3080/ , http://b.local:3080  ")).toBe(
      "http://a.local:3080,http://b.local:3080",
    );
  });

  /**
   * The strip is what keeps the forgiveness from reaching disk: better-auth
   * and the CORS plugin match against the browser's `Origin` header, which
   * never carries a trailing slash.
   */
  test("what is stored is what an Origin header would say", () => {
    expect(normalizeTrustedOrigins("http://box.local:3080/")).toBe("http://box.local:3080");
  });

  test("an all-empty list normalizes to empty, which is what removes the key", () => {
    expect(normalizeTrustedOrigins("   ")).toBe("");
    expect(normalizeTrustedOrigins(",")).toBe("");
  });
});

describe("baseUrlPort", () => {
  test("reads an explicit port", () => {
    expect(baseUrlPort("http://box.local:3080")).toBe(3080);
    expect(baseUrlPort("https://box.local:8443")).toBe(8443);
  });

  /**
   * The scheme default is what stops a PROXIED deployment from being reported
   * as a mismatch: `https://subshell.example` in front of a server on 3080 is
   * the normal production shape, and the browser dials 443.
   */
  test("falls back to the scheme's default port", () => {
    expect(baseUrlPort("https://subshell.example")).toBe(443);
    expect(baseUrlPort("http://subshell.example")).toBe(80);
  });

  test("null for anything that does not parse", () => {
    expect(baseUrlPort("not a url")).toBeNull();
  });
});

describe("isLoopbackUrl", () => {
  for (const yes of ["http://localhost:3080", "http://127.0.0.1:3080", "http://127.1.2.3:80", "http://[::1]:3080"]) {
    test(`${yes} is loopback`, () => expect(isLoopbackUrl(yes)).toBe(true));
  }
  for (const no of ["http://box.local:3080", "http://10.0.0.5:3080", "https://subshell.example", "not a url"]) {
    test(`${no} is not`, () => expect(isLoopbackUrl(no)).toBe(false));
  }
});

describe("FLAG_FOR_KEY", () => {
  test("names a flag for every key the flow can refuse a value for", () => {
    expect(Object.keys(FLAG_FOR_KEY).sort()).toEqual([...OWNED_KEYS, ...OPTIONAL_KEYS].sort());
  });

  test("every flag is a long option, since the refusal tells someone to type it", () => {
    for (const flag of Object.values(FLAG_FOR_KEY)) expect(flag).toMatch(/^--[a-z-]+$/);
  });
});

describe("originProblem — will this STORED entry match what a browser sends?", () => {
  /**
   * A different question from `validateValue`'s, and the distinction is the
   * whole reason this exists.
   *
   * `configure` is lenient and CANONICALIZES on write, so it accepts
   * `http://Box.Local:3080` and stores `http://box.local:3080`. But a value
   * that arrived by hand-edit or through the env layer — neither of which
   * passes through the validator — is used verbatim, and both consumers
   * compare against the serialized origin. So the runtime question is
   * "is this already canonical", which is strictly stricter than "would
   * configure take it". They share `isHttpOrigin`/`canonicalOrigin` rather
   * than sharing a predicate, because a diagnostic that disagreed with the
   * validator in either direction would make the tool look broken instead of
   * the config.
   */
  test("a canonical origin has no problem", () => {
    for (const good of ["http://box.local:3080", "https://subshell.example", "http://[::1]:3080", "http://10.0.0.5"]) {
      expect(originProblem(good)).toBeNull();
    }
  });

  /**
   * A non-http SCHEME and a MISSING scheme are different mistakes and need
   * different sentences. Suggesting `http://` + the raw entry produced
   * `browsers send e.g. "http://ftp://box.local:3080"` — advice that is
   * nonsense, in the one place whose entire job is to be actionable.
   */
  test("a non-http scheme is not told to prepend http://", () => {
    const reason = originProblem("ftp://box.local:3080");
    expect(reason).not.toBeNull();
    expect(reason).not.toContain("http://ftp://");
    expect(reason).toContain("ftp:"); // names the scheme it found
    expect(reason).toContain("http://box.local:3080"); // and the usable form
  });

  /**
   * `new URL("box.local:3080")` does NOT throw — the WHATWG parser reads
   * `box.local:` as a scheme — so "did it parse" is the wrong discriminator
   * between a missing scheme and a wrong one. `://` is the right one, and
   * getting it wrong made the commonest mistake of the two report itself as
   * using "the 'box.local:' scheme".
   */
  test("a bare host:port reads as a MISSING scheme, not a strange one", () => {
    const reason = originProblem("box.local:3080");
    expect(reason).toMatch(/no http\(s\) scheme/i);
    expect(reason).toContain('"http://box.local:3080"');
    expect(reason).not.toContain("box.local:' scheme");
  });

  /**
   * An entry that HAS a scheme but does not parse must not be told it has no
   * scheme. The discriminator was `url === null || !entry.includes("://")`, so
   * every throw fell into the no-scheme branch and
   * `http://box.local:99999` was reported as "has no http(s) scheme" — wrong
   * advice on the one surface whose whole job is to be actionable.
   */
  for (const entry of ["http://box.local:99999", "http://box.local:-1", "http://", "http://::1:3080"]) {
    test(`an unparseable ${JSON.stringify(entry)} is reported as unparseable, not schemeless`, () => {
      const reason = originProblem(entry);
      expect(reason).not.toBeNull();
      expect(reason).not.toMatch(/no http\(s\) scheme/i);
      expect(reason).toMatch(/could not be parsed|not a parseable/i);
    });
  }

  /**
   * `?` is the wildcard character AND the query delimiter, and the wildcard
   * early-out ran first — so a hand-edited `…?q=1` got no diagnostic at all,
   * even though better-auth treats it as a pattern that matches nothing. The
   * query/fragment check has to come before the wildcard silence.
   */
  test("a query string is diagnosed rather than mistaken for a wildcard", () => {
    const reason = originProblem("http://box.local:3080?q=1");
    expect(reason).not.toBeNull();
    expect(reason).toMatch(/query/i);
  });

  test("a fragment likewise", () => {
    expect(originProblem("http://box.local:3080#h")).toMatch(/fragment/i);
  });

  test("a mixed-case bare host is suggested in its canonical form", () => {
    expect(originProblem("Box.Local:3080")).toContain('"http://box.local:3080"');
  });

  test("a scheme with no host at all is refused without inventing one", () => {
    const reason = originProblem("mailto:a@b.c");
    expect(reason).not.toBeNull();
    expect(reason).not.toContain("http://mailto:");
  });

  for (const [entry, expected] of [
    ["box.local:3080", /scheme/i], // schemeless: cors matches it scheme-blind, better-auth never
    ["http://box.local:3080/", /http:\/\/box\.local:3080/], // names the canonical form
    ["http://Box.Local:3080", /http:\/\/box\.local:3080/],
    ["http://box.local:80", /http:\/\/box\.local/],
    ["http://[0:0:0:0:0:0:0:1]:3080", /http:\/\/\[::1\]:3080/],
    ["http://box.local:3080/app", /path/i],
  ] as const) {
    test(`reports ${JSON.stringify(entry)}`, () => {
      const reason = originProblem(entry);
      expect(reason).not.toBeNull();
      expect(reason).toMatch(expected);
    });
  }

  /**
   * The deliberate exclusion. better-auth honours `https://*.example.com`
   * natively (its `wildcardMatch` branch), so reporting it would be a lint
   * against a supported feature — and an unsilenceable one, since the operator
   * meant it. `configure` refuses to WRITE one; `status` does not complain
   * about one that is already there.
   */
  test("says nothing about a wildcard, which better-auth honours", () => {
    expect(originProblem("https://*.example.com")).toBeNull();
    expect(originProblem("https://*")).toBeNull();
  });
});

describe("baseUrlProblem", () => {
  test("a usable base URL has no problem, path included", () => {
    for (const good of ["http://localhost:3080", "https://subshell.example", "http://10.0.0.5:3080/sub"]) {
      expect(baseUrlProblem(good)).toBeNull();
    }
  });

  /**
   * The stronger case of the two. `localOriginsFor` swallows a parse failure
   * deliberately ("not worth a boot failure over"), so a malformed base URL
   * silently removes the instance's OWN origin from the allowlist — and it is
   * also better-auth's baseURL and the passkey rpID. Nothing anywhere says so.
   */
  for (const bad of ["localhost:3080", "not a url", "ftp://x.example", ""]) {
    test(`reports ${JSON.stringify(bad)} as dropping the instance's own origin`, () => {
      const reason = baseUrlProblem(bad);
      expect(reason).not.toBeNull();
      expect(reason).toMatch(/own origin|allowlist/i);
    });
  }
});
