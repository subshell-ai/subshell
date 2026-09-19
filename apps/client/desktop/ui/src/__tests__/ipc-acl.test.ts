/**
 * The three-way contract: the page, the Rust command set, and the ACL.
 *
 * A command name lives in `lib/ipc.ts`, in `src-tauri/permissions/desktop.toml`
 * and in `src-tauri/capabilities/node.json`. Changing one without the others
 * produces a command that is REFUSED AT RUNTIME with a message about
 * permissions — not a compile error, and not something any type checks. Nothing
 * held those three files together before this test.
 *
 * `node.json` and not `main.json`, and that is the point of the second block
 * here: `main` is the window showing a CONTROL PLANE's own page, and it holds
 * exactly one command — one that takes a path and can name no host. Nothing
 * else about the CLI surface is reachable from a remote origin, which is what
 * that block asserts entry by entry.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const TAURI_DIR = join(import.meta.dir, "../../../src-tauri");
const UI_SRC = join(import.meta.dir, "..");

const ipcSource = readFileSync(join(UI_SRC, "lib/ipc.ts"), "utf8");

/** The commands `lib/ipc.ts` actually invokes. */
function invokedCommands(): Set<string> {
  // `invoke<Probe>("node_probe")` and `invoke<void>("node_open_path", args)`.
  const found = new Set<string>();
  for (const match of ipcSource.matchAll(/\binvoke\s*(?:<[^>]*>)?\s*\(\s*"([^"]+)"/g)) {
    found.add(match[1] as string);
  }
  return found;
}

/** `[[permission]]` blocks in the app's ACL manifest, as identifier → commands. */
function manifestPermissions(): Map<string, string[]> {
  const toml = readFileSync(join(TAURI_DIR, "permissions/desktop.toml"), "utf8");
  const out = new Map<string, string[]>();
  let identifier: string | null = null;
  for (const line of toml.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) continue;
    const id = /^identifier\s*=\s*"([^"]+)"/.exec(trimmed);
    if (id) {
      identifier = id[1] as string;
      continue;
    }
    const allow = /^commands\.allow\s*=\s*\[([^\]]*)\]/.exec(trimmed);
    if (allow && identifier !== null) {
      const commands = [...(allow[1] as string).matchAll(/"([^"]+)"/g)].map((m) => m[1] as string);
      out.set(identifier, commands);
    }
  }
  return out;
}

function capabilityPermissions(): string[] {
  const capability = JSON.parse(readFileSync(join(TAURI_DIR, "capabilities/node.json"), "utf8")) as {
    permissions: string[];
  };
  return capability.permissions;
}

/** What the PLANE's window is granted — one entry, pinned in its own block. */
function mainPermissions(): string[] {
  const capability = JSON.parse(readFileSync(join(TAURI_DIR, "capabilities/main.json"), "utf8")) as {
    permissions?: string[];
  };
  return capability.permissions ?? [];
}

/**
 * A file's CODE, with comments removed.
 *
 * The prose in this app names `status --probe` repeatedly and has to: it is the
 * invocation everything here is arranged to avoid, and the reason is worth
 * writing down. What must not exist is a `--probe` the page could actually
 * emit. Crude by design (a `//` inside a string literal is stripped too), which
 * is harmless for a check that only asks whether one token survives.
 */
function codeOf(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Every `.ts`/`.tsx` file under `ui/src`, tests included. */
function sourceFiles(dir: string = UI_SRC): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path));
    } else if (path.endsWith(".ts") || path.endsWith(".tsx")) {
      out.push(path);
    }
  }
  return out;
}

describe("the IPC contract", () => {
  it("invokes exactly the commands the ACL grants this window", () => {
    const manifest = manifestPermissions();
    const granted = new Set(capabilityPermissions().flatMap((id) => manifest.get(id) ?? []));
    expect([...invokedCommands()].sort()).toEqual([...granted].sort());
  });

  it("names no permission the manifest does not define", () => {
    const manifest = manifestPermissions();
    // `core:*` and `opener:*` come from Tauri and its plugins; only this
    // app's own `allow-node-*` identifiers have to exist in desktop.toml.
    const own = capabilityPermissions().filter((id) => !id.includes(":"));
    for (const id of own) expect(manifest.has(id)).toBe(true);
  });

  it("defines no permission neither capability grants", () => {
    // A granted-nowhere permission is a command no page can call, which is the
    // same runtime rejection read from the other end — and after a deletion it
    // is also how a dead command survives in Rust unnoticed. BOTH files, since
    // `main.json` arrived: one of the manifest's entries is granted only there.
    const granted = new Set([...capabilityPermissions(), ...mainPermissions()]);
    for (const id of manifestPermissions().keys()) expect(granted.has(id), `${id} is granted nowhere`).toBe(true);
  });

  it("grants no dialog surface at all", () => {
    // There was one — `dialog:allow-open` for the agent-binary file chooser,
    // `dialog:allow-message` beside it, and deliberately no `ask`, because
    // this app's confirmations are several sentences of consequence and are
    // rendered in the page (components/confirm-panel.tsx). The picker is gone,
    // so nothing crosses that boundary any more, and a granted permission with
    // no caller is exactly the erosion these pins exist to catch. Zero, not
    // two: `ask` is still refused, and now so is everything beside it.
    const dialog = capabilityPermissions().filter((id) => id.startsWith("dialog:"));
    expect(dialog).toEqual([]);
  });
});

/**
 * The window that is granted ONE command.
 *
 * It was granted nothing until 2026-09-14, and the absence WAS the boundary: a
 * control plane can live on any host, so unlike `apps/server/desktop`'s
 * loopback window this one's origin cannot be enumerated in a capability file
 * at all. That has not changed. What changed is that "Open in browser" is
 * chrome any shell owes its user — a webview has no address bar and no second
 * tab — so the boundary moved one level in: the SCOPE is a wildcard, and the
 * narrowness lives in the command's ARGUMENT.
 *
 * Which makes three things worth pinning rather than one: that the scope is
 * exactly what was argued for, that the permission list is exactly one entry,
 * and that the Rust signature behind it takes a path and no host. Any of those
 * widening quietly is the failure this block exists to make loud.
 */
describe("the window that is granted one command", () => {
  /** Every capability file the app ships, parsed. */
  function capabilities(): {
    file: string;
    identifier: string;
    windows?: string[];
    local?: boolean;
    remote?: { urls?: string[] };
    permissions?: string[];
  }[] {
    const dir = join(TAURI_DIR, "capabilities");
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => ({ file: f, ...JSON.parse(readFileSync(join(dir, f), "utf8")) }));
  }

  const main = () => {
    const found = capabilities().find((c) => c.file === "main.json");
    if (!found) throw new Error("capabilities/main.json is missing");
    return found;
  };

  it("is the app's two capability files, and no more", () => {
    // A THIRD file is a third window, and a window added without a deliberate
    // grant list is exactly what `permissions/desktop.toml` exists to prevent.
    expect(
      capabilities()
        .map((c) => c.file)
        .sort(),
    ).toEqual(["main.json", "node.json"]);
  });

  it("keeps `main`'s scope to what was argued for", () => {
    const capability = main();
    // Any host, any PORT. `http://*` alone does NOT match a non-default port
    // in the `urlpattern` crate tauri 2.11.5 uses, so the `:*` is load-bearing
    // rather than decorative: without it a plane on :3080 — the default
    // deployment — is granted nothing and the row silently does nothing.
    expect(capability.remote?.urls?.slice().sort()).toEqual(["http://*:*", "https://*:*"]);
    // `local: false` keeps this a REMOTE capability. True would apply the
    // same grant to the bundled `node` page, which already has its own.
    expect(capability.local).toBe(false);
    // One window, by name.
    expect(capability.windows).toEqual(["main"]);
  });

  it("grants `main` exactly one permission, and nothing that drives the CLI", () => {
    const permissions = main().permissions ?? [];
    expect(permissions).toEqual(["allow-desktop-open-in-browser"]);
    // Stated as invariants too, not just as an equality: these are the
    // properties the equality is protecting, and they should be readable as
    // the reason it is there.
    for (const id of permissions) {
      expect(id.startsWith("allow-node-"), `${id} is a node verb on the plane's window`).toBe(false);
      expect(id.includes(":"), `${id} is a plugin permission on the plane's window`).toBe(false);
    }
    // `core:default` in particular: it carries the window, webview, event and
    // app command sets, which is a very different window from this one.
    expect(permissions).not.toContain("core:default");
  });

  it("keeps every CLI-driving command granted to `node` alone", () => {
    const nodeGrants = new Set(capabilityPermissions());
    for (const id of manifestPermissions().keys()) {
      if (id === "allow-desktop-open-in-browser") continue;
      expect(nodeGrants.has(id), `${id} must be the bundled page's`).toBe(true);
      expect(main().permissions ?? [], id).not.toContain(id);
    }
  });

  it("keeps the browser command to a PATH, so the plane's page names no host", () => {
    // The whole safety of granting anything to a wildcard origin. One
    // parameter, `path`, joined onto the origin `PlanePin` already enforces
    // for navigation. A second string parameter — an origin, a base URL, a
    // host — would make a compromised plane page able to name where the
    // system browser goes, and no assertion above would see it.
    const rust = readFileSync(join(TAURI_DIR, "src/control.rs"), "utf8");
    const signature = rust.slice(rust.indexOf("pub fn desktop_open_in_browser("));
    const params = signature.slice(signature.indexOf("(") + 1, signature.indexOf(")"));
    const names = params
      .split(",")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.split(":")[0]?.trim());
    expect(names).toEqual(["app", "path"]);
    expect(params).toContain("path: String");
    // The refusals are the SHARED ones, not a second copy written here:
    // `crates/desktop-core` holds the join and its tests, so the two apps
    // cannot disagree about what a path is.
    expect(rust).toContain("subshell_desktop_core::browser::browser_url");
  });

  it("keeps updating the APP on the bundled page alone", () => {
    // Two commands, both `node`-only (spec 2026-09-15 § 7.2). The check looks
    // harmless — one GET, nothing changed — and it still does not go on
    // `main`, because its sibling REPLACES THE APPLICATION and the wildcard
    // scope this window carries is exactly why nothing is added to it without
    // an argument being made. The equality above already says `main` holds one
    // permission; this says WHICH two must never move.
    const nodeGrants = new Set(capabilityPermissions());
    expect(nodeGrants.has("allow-node-check-app-update")).toBe(true);
    expect(nodeGrants.has("allow-node-install-app-update")).toBe(true);
    const mainGrants = main().permissions ?? [];
    expect(mainGrants).not.toContain("allow-node-check-app-update");
    expect(mainGrants).not.toContain("allow-node-install-app-update");
  });

  it("lets the app-update commands name no location, whatever else they take", () => {
    // The whole reason they can be commands at all: the release to install is
    // re-resolved in Rust, so the page asks for "the newest" and can never
    // name a URL, a tag or a file. So the pin is on the TYPES past the handle,
    // not on the count — `node_install_app_update` gained the § 13 selection
    // in review (2026-09-18) and it is a bool. A `String` there is exactly the
    // parameter this assertion exists to catch, and nothing else in this file
    // would see it.
    const rust = readFileSync(join(TAURI_DIR, "src/control.rs"), "utf8");
    for (const name of ["node_check_app_update", "node_install_app_update"]) {
      const signature = rust.slice(rust.indexOf(`pub async fn ${name}(`));
      const params = signature.slice(signature.indexOf("(") + 1, signature.indexOf(")"));
      const args = params
        .split(",")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => line.split(":").map((half) => half.trim()));
      expect(args[0]?.[0], `${name} does not take the app handle first`).toBe("app");
      for (const [argName, type] of args.slice(1)) {
        expect(type, `${name}'s ${argName} is not a bool`).toBe("bool");
      }
    }
  });

  // The corollary, unchanged: everything the CLI surface needs goes to the
  // bundled page, locally.
  it("grants the node surface to the bundled node window, locally", () => {
    const node = capabilities().find((c) => c.file === "node.json");
    expect(node?.windows).toEqual(["node"]);
    expect(node?.local).toBe(true);
  });
});

describe("the invocations that must stay unreachable", () => {
  // `status --probe` DIALS the control plane, and the node registry is
  // newest-wins, so a probe supersede-kicks whatever agent is live — possibly
  // one on another machine for this same node (close 4409). The Rust side's
  // `NodeCommand` enum is the real guard; this is the other half, so the page
  // cannot grow an affordance that asks for it.
  it("can emit --probe from no code path", () => {
    for (const file of sourceFiles()) {
      if (file.endsWith("ipc-acl.test.ts")) continue;
      expect(codeOf(file), file).not.toContain("--probe");
    }
  });

  // `subshell run` never resolves and competes with the installed service for
  // one node (both restart on exit, so the pair flaps); `subshell mcp` is
  // per-pane plumbing only a launch's environment can configure.
  it("keeps the service verbs to the five the CLI accepts", () => {
    const union = /export type ServiceVerb =([^;]+);/.exec(ipcSource)?.[1] ?? "";
    expect(union).not.toBe("");
    const verbs = [...union.matchAll(/"([^"]+)"/g)].map((m) => m[1] as string);
    expect(verbs.sort()).toEqual(["install", "restart", "start", "stop", "uninstall"]);
    expect(verbs).not.toContain("run");
    expect(verbs).not.toContain("mcp");
  });
});
