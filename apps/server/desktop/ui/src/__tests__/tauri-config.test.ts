/**
 * The bits of `tauri.conf.json` the page depends on, pinned.
 *
 * `tauri.conf.json` is strict JSON with `deny_unknown_fields`, so it cannot
 * carry a comment explaining any of this. This file is where the reasons live
 * — including the two that replaced the old `test/` layout's guard: the asset
 * root is now a Vite output (a test file cannot ship from inside it any more
 * than a React component can ship from `apps/server/web/src`), and the dev
 * hooks are what keep `tauri dev`/`tauri build` from ever bundling a stale
 * assistant.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const config = JSON.parse(readFileSync(join(import.meta.dir, "../../../src-tauri/tauri.conf.json"), "utf8")) as {
  build: { frontendDist: string; devUrl: string; beforeDevCommand: string; beforeBuildCommand: string };
  app: { withGlobalTauri: boolean; security: { csp: string; devCsp: string } };
};

const viteConfig = readFileSync(join(import.meta.dir, "../../../vite.config.ts"), "utf8");
const pkg = JSON.parse(readFileSync(join(import.meta.dir, "../../../package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

describe("the production CSP stays strict", () => {
  const csp = config.app.security.csp;

  it("allows no inline script or style", () => {
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self'");
  });

  it("keeps the network surface to the app and the IPC channel", () => {
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("connect-src 'self' ipc: http://ipc.localhost");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  /**
   * The reason `vite.config.ts` carries the two flags it does: the production
   * policy would silently block a module-preload polyfill injected as an
   * inline <script> and any asset inlined as a `data:` URL. Asserting against
   * the config text keeps the pairing — a "cleanup" that re-enables either
   * breaks the console with no error anywhere.
   */
  it("matches the Vite build's CSP-clean output rules", () => {
    expect(viteConfig).toContain("polyfill: false");
    expect(viteConfig).toContain("assetsInlineLimit: 0");
    // Relative asset URLs survive both tauri's protocol and opening the file.
    expect(viteConfig).toContain('base: "./"');
  });
});

describe("the dev CSP relaxes dev and only dev", () => {
  // Vite's dev server injects <style> tags for HMR, which the production
  // policy blocks. `app.security.devCsp` applies ONLY to `tauri dev`, so
  // relaxing it here does not widen a single shipped bundle.
  it("permits Vite's style injection and its HMR socket", () => {
    const dev = config.app.security.devCsp;
    expect(dev).toContain("script-src 'self' 'unsafe-inline'");
    expect(dev).toContain("style-src 'self' 'unsafe-inline'");
    const port = /const DEV_PORT = (\d+);/.exec(viteConfig)?.[1];
    expect(port).toBeDefined();
    expect(dev).toContain(`ws://localhost:${port}`);
  });

  it("names the same origin the Vite dev server binds", () => {
    const port = /const DEV_PORT = (\d+);/.exec(viteConfig)?.[1];
    expect(config.build.devUrl).toBe(`http://localhost:${port}`);
    // strictPort, so a port collision is a refusal to start rather than Vite
    // walking to the next free port while `devUrl` keeps pointing at this one.
    expect(viteConfig).toContain("strictPort: true");
  });

  it("does not collide with the other dev servers in the repo", () => {
    const port = /const DEV_PORT = (\d+);/.exec(viteConfig)?.[1];
    // apps/server/web starts at 5174 and walks UP when busy, and
    // apps/client/desktop is strict on 5177 — 5175/5176 are exactly where a
    // busy SPA lands, and 5178 must not double-book the client.
    expect(["5174", "5175", "5176", "5177"]).not.toContain(port);
  });
});

describe("the window's ambient surface", () => {
  /**
   * `lib/ipc.ts` imports `invoke` from `@tauri-apps/api/core`, so the CONSOLE
   * needs no global. The `main` window's page does: the SPA's desktop bridge
   * (`apps/server/web/src/lib/desktop.ts`) reads `window.__TAURI__` rather
   * than importing anything, and it takes its desktop branch because THIS
   * app's `windows.rs` marks `main`'s user agent with `SubshellDesktop/…`.
   * Subshell Client ships `false` precisely because it strips that marker —
   * so the invariant is the PAIR, not either half: as long as the marker is
   * set here, the global must exist, or every `main` command silently no-ops
   * through the SPA's never-throws bridge (measured 2026-09-10 when the
   * migration copied the client's config: handshake, "Manage server",
   * notifications and dragging all went dead with the ACL untouched).
   */
  it("ships the global the SPA's bridge reads, for as long as the marker ships", () => {
    const windows = readFileSync(join(import.meta.dir, "../../../src-tauri/src/windows.rs"), "utf8");
    expect(windows).toContain("SubshellDesktop");
    expect(config.app.withGlobalTauri).toBe(true);
  });
});

describe("the build wiring", () => {
  it("serves the Vite output, not the source directory", () => {
    expect(config.build.frontendDist).toBe("../ui/dist");
  });

  it("builds the ONE bundled page, CSP-clean", () => {
    // The input is named rather than left to Vite's default, which is
    // `index.html` — a file this app no longer has. A missing rollup input
    // does not fail the build: it ships a bundle in which
    // `WebviewUrl::App("wizard.html")` resolves to nothing, which a release
    // build only discovers on someone's machine. So the pairing is pinned at
    // the config text, like the CSP half.
    expect(viteConfig).toContain('wizard: path.resolve(dirname, "ui/wizard.html")');
    expect(existsSync(join(import.meta.dir, "../../wizard.html"))).toBe(true);
    // And there is exactly one: a second page is a second window, which is
    // the shape this app spent a release removing.
    expect(viteConfig.match(/path\.resolve\(dirname, "ui\/[^"]+\.html"\)/g)).toHaveLength(1);
    // The page the console left behind is gone, not merely unreferenced — an
    // orphan `index.html` beside a config that names `wizard.html` is how the
    // wrong page gets bundled back in.
    expect(existsSync(join(import.meta.dir, "../../index.html"))).toBe(false);
    const wizard = readFileSync(join(import.meta.dir, "../../wizard.html"), "utf8");
    // script-src 'self' / style-src 'self': a module script with a src,
    // nothing inline.
    expect(wizard).not.toMatch(/<script(?![^>]*\bsrc=)/);
    expect(wizard).not.toMatch(/style=/);
    expect(wizard).toContain('src="/src/wizard.ts"');
  });

  it("drives the app's own scripts", () => {
    expect(config.build.beforeDevCommand).toBe("bun run dev:ui");
    expect(config.build.beforeBuildCommand).toBe("bun run build");
    expect(pkg.scripts["dev:ui"]).toBe("vite");
    expect(pkg.scripts.build).toBe("vite build");
  });

  // Root `bun run start` is `turbo watch dev`, which runs every workspace's
  // `dev` task. A `dev` script here would spawn a Vite server for everyone
  // working on the backend.
  it("has no `dev` script for turbo watch to find", () => {
    expect(pkg.scripts.dev).toBeUndefined();
  });

  it("type-checks both halves of the app", () => {
    expect(pkg.scripts["verify-types"]).toContain("tsconfig.json");
    expect(pkg.scripts["verify-types"]).toContain("ui/tsconfig.json");
  });
});

describe("the test runs", () => {
  it("reaches the release-script tests and the page's", () => {
    expect(pkg.scripts.test).toContain("src");
    expect(pkg.scripts.test).toContain("ui/src");
  });

  it("needs no happy-dom preload, and has no bunfig to carry one", () => {
    // The page's tests are pure — the same fs-and-pure-import shape as the
    // release script's. The moment a component test with a DOM arrives, this
    // assertion should be replaced by the client app's ui/bunfig.toml pattern
    // rather than by registering DOM globals unconditionally.
    expect(existsSync(join(import.meta.dir, "../../../bunfig.toml"))).toBe(false);
    expect(existsSync(join(import.meta.dir, "../../bunfig.toml"))).toBe(false);
  });
});
