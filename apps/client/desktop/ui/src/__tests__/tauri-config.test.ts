/**
 * The bits of `tauri.conf.json` the page depends on, pinned.
 *
 * `tauri.conf.json` is strict JSON with `deny_unknown_fields`, so it cannot
 * carry a comment explaining any of this. This file is where the reasons live.
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

  // The whole reason `__tests__/no-inline-styles.test.ts` exists. If
  // 'unsafe-inline' ever lands here, that guard is no longer load-bearing —
  // and it should be deleted deliberately rather than left as decoration.
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
});

describe("the dev CSP relaxes dev and only dev", () => {
  // Vite's dev server injects <style> tags for HMR and the React plugin's
  // refresh preamble is an inline module script, both of which the production
  // policy blocks. `app.security.devCsp` (tauri-utils 2.9.3) applies ONLY to
  // `tauri dev`, so relaxing it here does not widen a single shipped bundle.
  it("permits Vite's inline injections and its HMR socket", () => {
    const dev = config.app.security.devCsp;
    expect(dev).toContain("script-src 'self' 'unsafe-inline'");
    expect(dev).toContain("style-src 'self' 'unsafe-inline'");
    expect(dev).toContain("ws://localhost:5177");
  });

  it("names the same origin the Vite dev server binds", () => {
    const port = /const DEV_PORT = (\d+);/.exec(viteConfig)?.[1];
    expect(port).toBeDefined();
    expect(config.build.devUrl).toBe(`http://localhost:${port}`);
    expect(config.app.security.devCsp).toContain(`ws://localhost:${port}`);
    // strictPort, so a port collision is a refusal to start rather than Vite
    // walking to the next free port while `devUrl` keeps pointing at this one.
    expect(viteConfig).toContain("strictPort: true");
  });

  it("does not collide with apps/server/web's dev server", () => {
    const port = /const DEV_PORT = (\d+);/.exec(viteConfig)?.[1];
    expect(port).not.toBe("5174");
    // Vite walks UP from a taken port, so the neighbours of 5174 are exactly
    // where the SPA lands when its own port is busy.
    expect(port).not.toBe("5175");
    expect(port).not.toBe("5176");
  });
});

describe("the window's ambient surface", () => {
  /**
   * The global is BACK, and it is the plane window that needs it.
   *
   * It was `false` from the day `lib/ipc.ts` started importing `invoke` from
   * `@tauri-apps/api/core` — the bundled page has no use for a global, and one
   * fewer handle in the webview was a free win. What changed on 2026-09-14 is
   * that the OTHER window has something to invoke: `apps/server/web`'s bridge
   * (`src/lib/desktop.ts`) reads `window.__TAURI__` and imports nothing, by
   * design — it must not pull `@tauri-apps/api` into a bundle that is served
   * to browsers, and the repo forbids the dynamic import that would avoid it.
   *
   * The global GRANTS nothing: `capabilities/main.json` does, and it names one
   * command. Turning this back off would not close a hole — it would make that
   * one command silently unreachable, because the bridge never throws, exactly
   * the failure `apps/server/desktop` measured on 2026-09-10 when its own
   * config was copied from this file.
   *
   * So the invariant is the PAIR: while `windows.rs` ships a user-agent
   * marker, the global must exist for the page that reads it.
   */
  it("ships the global the plane SPA's bridge reads, for as long as the marker ships", () => {
    const windows = readFileSync(join(import.meta.dir, "../../../src-tauri/src/windows.rs"), "utf8");
    expect(windows).toContain("SubshellClient");
    expect(config.app.withGlobalTauri).toBe(true);
  });

  // And the marker is this app's OWN token. `SubshellDesktop` would make the
  // SPA take Subshell Server's chrome branches — an overlay title bar this
  // window does not implement, and update/reset/supervision cards backed by
  // commands nothing here grants.
  it("marks the plane window as the CLIENT, not the server app", () => {
    const windows = readFileSync(join(import.meta.dir, "../../../src-tauri/src/windows.rs"), "utf8");
    expect(windows).toContain('format!("SubshellClient/{version} ({platform}; p=1)")');
    expect(windows).not.toContain("SubshellDesktop/");
  });
});

describe("the build wiring", () => {
  it("serves the Vite output, not the source directory", () => {
    expect(config.build.frontendDist).toBe("../ui/dist");
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

describe("the two test runs", () => {
  // `bun test <arg>` treats the argument as a PATH FILTER, not a directory —
  // so a bare `bun test src` also collects `ui/src/__tests__/**`, and those
  // files then run with no bunfig, no preload and no DOM. It worked only for as
  // long as `ui/` had no tests. The ignore pattern is what keeps the release
  // script's run to the release script.
  it("keeps the release-script run away from ui/", () => {
    expect(pkg.scripts.test).toContain("--path-ignore-patterns");
    expect(pkg.scripts.test).toContain("ui/**");
  });

  it("runs the web half with ui/ as the cwd, which is how it finds its preload", () => {
    expect(pkg.scripts.test).toContain("cd ui && bun test");
    const bunfig = readFileSync(join(import.meta.dir, "../../bunfig.toml"), "utf8");
    expect(bunfig).toContain('preload = ["./src/test-setup.ts"]');
  });

  it("has no bunfig at the package root, so `bun test src` gets no DOM", () => {
    expect(existsSync(join(import.meta.dir, "../../../bunfig.toml"))).toBe(false);
  });
});
