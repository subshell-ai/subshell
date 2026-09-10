/**
 * The e2e fake npm registry — a THIRD process in the stack, and that is why
 * it is a file rather than a few lines inside stack.ts: the Playwright runner
 * is Node (`@playwright/test/cli.js`'s shebang is `env node`, measured), so
 * globalSetup cannot host a `Bun.serve` itself. stack.ts spawns `bun
 * fake-registry.ts <port>` at boot and kills it in teardown.
 *
 * It serves exactly ONE package — `e2e/fixtures/plugin-demo/`, packed with
 * `bun pm pack` at startup — as an abbreviated packument at `/e2e-demo` and
 * the tarball at `/e2e-demo-1.0.0.tgz`. The integrity hash is COMPUTED from
 * the real tgz bytes, never hardcoded: what npm would say about a real
 * package is exactly what a mirror can lie about, and the whole phase-3
 * install path (resolve → verify over raw bytes → vendored extract →
 * load-check → swap) runs against it unmodified.
 *
 * Boundaries by design: no public network, ever — the backend child's
 * `SUBSHELL_PLUGIN_REGISTRY_URL` points HERE (ports.ts), so no spec in the
 * suite can dial a real registry by accident, and nothing here fetches
 * anything from anywhere but the fixture directory.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * The two `Bun` globals this file uses, declared rather than typed by a
 * dependency: the e2e package is deliberately Node-typed (its tsconfig is
 * `types: ["node"]` — the Playwright RUNNER is what that typing describes),
 * and adding `@types/bun` to retype the whole package for one bun-process
 * script would re-type the wrong half of it. This is a bun script, run by
 * `bun fake-registry.ts` (stack.ts spawns it); the declaration states the
 * subset it actually calls.
 */
declare const Bun: {
  spawnSync(
    cmd: string[],
    opts: { cwd: string; stdout: "pipe"; stderr: "pipe" },
  ): { exitCode: number; stdout: { toString(): string }; stderr: { toString(): string } };
  serve(opts: { hostname: string; port: number; fetch: (req: Request) => Response }): {
    hostname: string;
    port: number;
  };
};

const PORT = Number(process.argv[2] ?? "3198");
const FIXTURE_DIR = path.join(import.meta.dirname, "fixtures", "plugin-demo");
const NAME = "e2e-demo";
const VERSION = "1.0.0";

/** Packs the fixture the way npm would and returns the `.tgz` bytes. */
function packFixture(): Uint8Array {
  const out = mkdtempSync(path.join(tmpdir(), "ss-e2e-pack-"));
  // `--destination`, not npm's `--pack-destination`: bun 1.4.2's `bun pm
  // pack` flags (measured — the unknown flag is silently swallowed and the
  // tgz lands in the fixture dir instead, a stray file nothing reads).
  const res = Bun.spawnSync(["bun", "pm", "pack", "--destination", out, "--quiet"], {
    cwd: FIXTURE_DIR,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (res.exitCode !== 0) {
    console.error(`[fake-registry] bun pm pack failed (${res.exitCode}): ${res.stderr.toString()}`);
    process.exit(1);
  }
  const tgz = readdirSync(out).find((f) => f.endsWith(".tgz"));
  if (tgz === undefined) {
    console.error(`[fake-registry] bun pm pack produced no .tgz in ${out}`);
    process.exit(1);
  }
  return new Uint8Array(readFileSync(path.join(out, tgz)));
}

const tgz = packFixture();
// SRI over the RAW bytes — the same computation `fetchVerifiedTarball`
// re-runs on the other end, so a byte changed anywhere between pack and
// install is a refusal, exactly as it would be against the real npm.
const integrity = `sha512-${createHash("sha512").update(tgz).digest("base64")}`;

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);
    // The packument: the abbreviated form the client requests, and all the
    // fields `resolvePackageVersion` actually reads (npm-registry.ts).
    if (url.pathname === `/${NAME}`) {
      return Response.json({
        name: NAME,
        "dist-tags": { latest: VERSION },
        versions: {
          [VERSION]: {
            name: NAME,
            version: VERSION,
            dist: { tarball: `http://127.0.0.1:${PORT}/${NAME}-${VERSION}.tgz`, integrity },
          },
        },
      });
    }
    if (url.pathname === `/${NAME}-${VERSION}.tgz`) {
      // `.buffer as ArrayBuffer`: TS 5.7+ typed-array generics keep a plain
      // `Uint8Array` off `BodyInit` (same bump tar-vendor.ts notes); this
      // buffer is ours, fresh from readFileSync, and never shared.
      return new Response(tgz.buffer as ArrayBuffer, {
        headers: { "content-type": "application/octet-stream" },
      });
    }
    // Everything else is a 404 naming nothing: a spec that asks for a package
    // this fake does not serve must fail the way an unknown package fails on
    // a real registry, not through some bespoke error path.
    return new Response("not found", { status: 404 });
  },
});

console.log(`[fake-registry] listening on http://${server.hostname}:${server.port} (${NAME}@${VERSION})`);
