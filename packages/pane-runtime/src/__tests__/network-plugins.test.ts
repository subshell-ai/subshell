import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NetworkPlugin } from "@subshell-ai/plugin-api";
import { createPluginHost, resetPluginDataDirForTests, setPluginDataDir, withPluginOutput } from "../plugin-host.js";
import { createInProcessRuntime } from "../plugin-runtime.js";
import { createPluginSecrets, secretPath } from "../plugin-secrets.js";

/**
 * The network half of the plugin system, at the layer the HOST owns.
 *
 * Three things are proved here and nowhere else: that the loader requires a
 * different set of members per type (so a network plugin need not ship harness
 * stubs, and a harness cannot pass as one), that `host.run` refuses the two
 * argv shapes a plugin must never be able to execute, and that a stored
 * credential is never readable through the contract a plugin is handed.
 */

const FIXTURES = join(import.meta.dir, "fixtures", "plugins");

function tempDataDir(): string {
  return mkdtempSync(join(tmpdir(), "network-plugins-"));
}

describe("loading a network plugin", () => {
  it("loads one that implements status, join and leave", async () => {
    const result = await createInProcessRuntime().load(join(FIXTURES, "network-good"));
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.manifest.type).toBe("network");
    expect(result.manifest.network?.exposure).toBe("private");
    expect(result.manifest.network?.privileged?.linux?.[0]?.command).toBe("sudo apt install meshtool");

    // The port comes from the CONTEXT on every call, which is what lets a
    // server that changed its port be right without republishing anything.
    const plugin = result.plugin as NetworkPlugin;
    const status = await plugin.status({ port: 3080, settings: {}, secrets: { has: () => false } });
    expect(status.addresses[0]?.url).toBe("http://fixture:3080");
  });

  it("does not demand buildCommand or validatePreset of it", async () => {
    // The whole reason the required-member list is keyed by type: a network
    // plugin has no argv to build and no preset to validate, and stubs for
    // both would make "implements the contract" mean nothing.
    const result = await createInProcessRuntime().load(join(FIXTURES, "network-good"));
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect("buildCommand" in result.plugin).toBe(false);
  });

  it("refuses a network plugin missing a required member, by name", async () => {
    const result = await createInProcessRuntime().load(join(FIXTURES, "network-missing-join"));
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error).toContain("join");
  });

  it("refuses publish declared without unpublish", async () => {
    const result = await createInProcessRuntime().load(join(FIXTURES, "network-half-publish"));
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error).toContain("publish");
  });

  it("still refuses a harness missing ITS required members", async () => {
    // The type-conditional list must not have loosened the harness path.
    const result = await createInProcessRuntime().load(join(FIXTURES, "missing-validate"));
    expect("error" in result).toBe(true);
  });
});

describe("host.run refusals", () => {
  const host = () => createPluginHost({ pluginId: "fixture" });

  it("refuses a bare executable name", async () => {
    // A name would resolve against a PATH the plugin cannot see and did not
    // choose, so "which binary did this run" would have no answer.
    await expect(host().run(["tailscale", "status"])).rejects.toThrow(/absolute path/);
  });

  it("refuses sudo and its siblings", async () => {
    for (const cmd of ["/usr/bin/sudo", "/usr/bin/doas", "/usr/bin/pkexec"]) {
      await expect(host().run([cmd, "apt", "install", "x"])).rejects.toThrow(/password prompt/);
    }
  });

  it("refuses an empty argv", async () => {
    await expect(host().run([])).rejects.toThrow();
  });

  it("reports a missing binary as a result rather than a throw", async () => {
    // Every caller is deciding what to tell a person; an exception here just
    // moves that decision somewhere with less context.
    const result = await host().run(["/nonexistent/definitely-not-here"]);
    expect(result.code).toBe(null);
    expect(result.stderr).not.toBe("");
  });

  it("runs an absolute command and reports its streams separately", async () => {
    const result = await host().run(["/bin/sh", "-c", "echo out; echo err 1>&2"]);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("out");
    expect(result.stderr.trim()).toBe("err");
  });

  it("holds the deadline even when a child leaves the pipe open", async () => {
    // Killing a process does not close a pipe its children still hold, which
    // is why the readers are cancelled rather than only the child killed.
    const started = Date.now();
    const result = await host().run(["/bin/sh", "-c", "sleep 30 & echo started; wait"], { timeoutMs: 500 });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("ends early on an abort without calling it a failure", async () => {
    // What an interactive login needs: the URL has already been printed, so
    // the plugin stops waiting rather than holding the request open.
    const controller = new AbortController();
    const seen: string[] = [];
    const result = await host().run(["/bin/sh", "-c", "echo visit https://example.invalid/a; sleep 30"], {
      timeoutMs: 20_000,
      onLine: (line) => {
        seen.push(line);
        if (line.includes("https://")) controller.abort();
      },
      signal: controller.signal,
    });
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(seen.some((l) => l.includes("https://example.invalid/a"))).toBe(true);
  });

  it("does not hand the child this process's whole environment", async () => {
    process.env.SUBSHELL_TEST_FAKE_SECRET = "must-not-leak";
    try {
      const result = await host().run(["/bin/sh", "-c", 'echo "[$SUBSHELL_TEST_FAKE_SECRET]"']);
      expect(result.stdout.trim()).toBe("[]");
    } finally {
      delete process.env.SUBSHELL_TEST_FAKE_SECRET;
    }
  });

  it("will not let a caller replace PATH", async () => {
    // A plugin that could set PATH would choose which binaries this process
    // finds, which is the lookup ladder's whole job.
    const result = await host().run(["/bin/sh", "-c", "echo $PATH"], { env: { PATH: "/nowhere" } });
    expect(result.stdout.trim()).not.toBe("/nowhere");
  });
});

describe("the plugin secret store", () => {
  it("writes 0600 in a 0700 directory and reports presence only", async () => {
    const dir = tempDataDir();
    const secrets = createPluginSecrets(dir, "cloudflare-tunnel");

    expect(await secrets.has("tunnel-token")).toBe(false);
    await secrets.set("tunnel-token", "eyJhIjoiMSJ9");
    expect(await secrets.has("tunnel-token")).toBe(true);

    const path = secretPath(dir, "cloudflare-tunnel", "tunnel-token");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, "plugins-state", "cloudflare-tunnel"))).mode & 0o777).toBe(0o700);
    // The value is on disk for the HOST to hydrate into a child process; the
    // contract a plugin holds simply has no way to ask for it.
    expect(await readFile(path, "utf8")).toBe("eyJhIjoiMSJ9");
    expect("get" in secrets).toBe(false);
  });

  it("replaces a value and deletes it, and a missing delete is not an error", async () => {
    const dir = tempDataDir();
    const secrets = createPluginSecrets(dir, "cf");
    await secrets.set("t", "first");
    await secrets.set("t", "second");
    expect(await readFile(secretPath(dir, "cf", "t"), "utf8")).toBe("second");
    await secrets.delete("t");
    expect(await secrets.has("t")).toBe(false);
    await expect(secrets.delete("t")).resolves.toBeUndefined();
  });

  it("refuses a name that is not a single path segment", async () => {
    const dir = tempDataDir();
    // Names become file names, so traversal has to be impossible rather than
    // merely unlikely.
    for (const bad of ["../escape", "a/b", ".hidden", "UPPER", ""]) {
      expect(() => secretPath(dir, "cf", bad)).toThrow();
    }
  });

  it("gives each plugin its own corner", async () => {
    const dir = tempDataDir();
    await createPluginSecrets(dir, "one").set("t", "a");
    expect(await createPluginSecrets(dir, "two").has("t")).toBe(false);
  });

  it("refuses to write when the host was built without a data directory", async () => {
    // The node agent's case. Inventing a path would put a credential
    // somewhere nothing else on the machine knows to protect or remove.
    resetPluginDataDirForTests();
    const host = createPluginHost({ pluginId: "cf" });
    expect(await host.secrets.has("t")).toBe(false);
    await expect(host.secrets.set("t", "x")).rejects.toThrow(/no secret store/);
  });

  it("uses the process-wide data directory when a caller names none", async () => {
    const dir = tempDataDir();
    setPluginDataDir(dir);
    try {
      const host = createPluginHost({ pluginId: "cf" });
      await host.secrets.set("t", "x");
      expect(await host.secrets.has("t")).toBe(true);
    } finally {
      resetPluginDataDirForTests();
    }
  });
});

describe("withPluginOutput", () => {
  it("tees a plugin's command output to a watching act", async () => {
    // The gap this closes: a host is built at registry construction, long
    // before any request exists, and `run`'s own `onLine` belongs to the
    // PLUGIN. Without this a route streaming a join could narrate only its own
    // steps, never the thirty seconds of output the vendor CLI produced.
    const host = createPluginHost({ pluginId: "fixture" });
    const watched: string[] = [];
    const byThePlugin: string[] = [];

    await withPluginOutput(
      "fixture",
      (line) => watched.push(line),
      async () => {
        await host.run(["/bin/sh", "-c", "echo first; echo second"], {
          onLine: (line) => byThePlugin.push(line),
        });
      },
    );

    // Both sinks see it: the tee adds a reader, it never replaces one.
    expect(watched).toEqual(["first", "second"]);
    expect(byThePlugin).toEqual(["first", "second"]);
  });

  it("stops teeing once the act settles", async () => {
    // A response stream closes when the act ends, so a later run writing to it
    // would be writing to a reader that is gone.
    const host = createPluginHost({ pluginId: "fixture" });
    const watched: string[] = [];
    await withPluginOutput(
      "fixture",
      (line) => watched.push(line),
      async () => {
        await host.run(["/bin/sh", "-c", "echo during"]);
      },
    );
    await host.run(["/bin/sh", "-c", "echo after"]);
    expect(watched).toEqual(["during"]);
  });

  it("removes the sink even when the act throws", async () => {
    const host = createPluginHost({ pluginId: "fixture" });
    const watched: string[] = [];
    await expect(
      withPluginOutput(
        "fixture",
        (line) => watched.push(line),
        async () => {
          throw new Error("the plugin gave up");
        },
      ),
    ).rejects.toThrow("the plugin gave up");
    await host.run(["/bin/sh", "-c", "echo after"]);
    expect(watched).toEqual([]);
  });

  it("survives a sink that throws, because a closed stream is ordinary", async () => {
    // The page navigated away mid-join. That has nothing to do with whether
    // the command worked, so it must not fail the run.
    const host = createPluginHost({ pluginId: "fixture" });
    const result = await withPluginOutput(
      "fixture",
      () => {
        throw new Error("nobody is reading");
      },
      () => host.run(["/bin/sh", "-c", "echo hello"]),
    );
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
  });
});
