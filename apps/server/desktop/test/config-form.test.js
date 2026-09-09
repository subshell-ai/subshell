import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_FIELDS, configPayload, fieldProblems, seedForm } from "../ui/config-form.js";

/**
 * The console's configure form is the only place these four keys are typed
 * together, and it is a NON-INTERACTIVE `init --yes` under the hood — so
 * `configure` resolves every unflagged key to its stored value. That makes the
 * seeding rule load-bearing rather than cosmetic: a field the form fails to
 * seed is a field the form sends back wrong, and the two failure modes are
 * silent (a repointed database, an origin list quietly dropped).
 *
 * These are the pure halves of `main.js` — no DOM, no Tauri.
 *
 * OUTSIDE `ui/` on purpose. `tauri.conf.json` sets `frontendDist: "../ui"`, so
 * that directory is copied verbatim into the shipped bundle — a `ui/__tests__/`
 * would put a file importing `bun:test` inside the installed app. Nothing would
 * load it, but the asset root is the app, and test sources are not part of it.
 */

/** A `status --json` settings map, one entry per key given. */
const settings = (entries) =>
  Object.fromEntries(Object.entries(entries).map(([key, [value, source]]) => [key, { value, source }]));

describe("seedForm", () => {
  test("seeds every field a user (or config.env) has actually chosen", () => {
    expect(
      seedForm(
        settings({
          SERVER_PORT: ["9000", "config.env"],
          HOST: ["127.0.0.1", "config.env"],
          APP_BASE_URL: ["http://box.local:9000", "config.env"],
          TRUSTED_ORIGINS: ["http://box.local:9000", "config.env"],
        }),
      ),
    ).toEqual({
      port: "9000",
      host: "127.0.0.1",
      baseUrl: "http://box.local:9000",
      trustedOrigins: "http://box.local:9000",
    });
  });

  /**
   * A `default`-sourced value is what the server WOULD boot with, not a choice
   * anyone made. Seeding it would turn every built-in into a stored value on
   * the next save, and a base URL nobody chose would stop being derived from
   * the port they answer.
   *
   * It does NOT protect a later port change, and it is worth not claiming it
   * does: `APP_BASE_URL` is always written, so it is `config.env`-sourced from
   * the first save onward and is seeded from then on. `configure`'s
   * port-mismatch warning is the guard there — and deriving it here instead
   * would silently rewrite a correct port-forward config (`SERVER_PORT=4000`
   * reached over `http://localhost:9000`).
   */
  test("leaves a default-sourced value BLANK, so the CLI keeps deriving it", () => {
    expect(
      seedForm(
        settings({
          SERVER_PORT: ["3080", "default"],
          HOST: ["0.0.0.0", "default"],
          APP_BASE_URL: ["http://localhost:3080", "default"],
          TRUSTED_ORIGINS: ["http://localhost:5174,http://localhost:5173", "default"],
        }),
      ),
    ).toEqual({ port: "", host: "", baseUrl: "", trustedOrigins: "" });
  });

  test("a process-env value is a real choice too — it is what the boot will see", () => {
    expect(seedForm(settings({ SERVER_PORT: ["4000", "process env"] })).port).toBe("4000");
  });

  test("a missing settings map yields an all-blank form rather than throwing", () => {
    expect(seedForm(undefined)).toEqual({ port: "", host: "", baseUrl: "", trustedOrigins: "" });
    expect(seedForm({})).toEqual({ port: "", host: "", baseUrl: "", trustedOrigins: "" });
  });
});

describe("configPayload", () => {
  test("sends every field, so a save means the form and not the file", () => {
    expect(
      configPayload({
        port: "9000",
        host: "0.0.0.0",
        baseUrl: "http://box.local:9000",
        trustedOrigins: "http://box.local:9000",
      }),
    ).toEqual({
      port: "9000",
      host: "0.0.0.0",
      baseUrl: "http://box.local:9000",
      trustedOrigins: "http://box.local:9000",
    });
  });

  /**
   * The asymmetry is the whole contract. An empty port/host/base-url means
   * "you decide" — the Rust side omits the flag. An empty origins field means
   * "none", which has to reach the CLI as an explicit empty `--trusted-origins`
   * or a cleared list would silently come back on the next save.
   */
  test("an empty origins field is sent as an explicit empty string, never dropped", () => {
    expect(configPayload({ port: "", host: "", baseUrl: "", trustedOrigins: "" })).toEqual({
      port: "",
      host: "",
      baseUrl: "",
      trustedOrigins: "",
    });
  });

  test("whitespace in the origins field is not mistaken for a value", () => {
    expect(configPayload({ trustedOrigins: "  " }).trustedOrigins).toBe("");
  });

  test("a partially filled form still names all four keys", () => {
    expect(Object.keys(configPayload({ port: "9000" })).sort()).toEqual(["baseUrl", "host", "port", "trustedOrigins"]);
  });
});

describe("CONFIG_FIELDS", () => {
  test("declares one row per form key, and every key seedForm fills", () => {
    expect(CONFIG_FIELDS.map((f) => f.name).sort()).toEqual(Object.keys(seedForm({})).sort());
  });

  test("every field names the status key it seeds from", () => {
    for (const field of CONFIG_FIELDS) {
      expect(field.settingKey).toMatch(/^[A-Z_]+$/);
    }
  });
});

describe("fieldProblems", () => {
  /**
   * The reason `status` carries problems as data rather than as a rendered
   * line: the console can put the diagnosis next to the field being edited,
   * instead of leaving it in the output block at the bottom.
   */
  test("returns the problems for the field's own status key", () => {
    const s = {
      TRUSTED_ORIGINS: {
        value: "box.local:3080",
        source: "config.env",
        problems: [{ entry: "box.local:3080", reason: "no scheme" }],
      },
    };
    expect(fieldProblems(s, "trustedOrigins")).toEqual([{ entry: "box.local:3080", reason: "no scheme" }]);
  });

  test("empty for a field with none, and for a missing settings map", () => {
    expect(fieldProblems({ TRUSTED_ORIGINS: { value: "x", source: "config.env" } }, "trustedOrigins")).toEqual([]);
    expect(fieldProblems(undefined, "trustedOrigins")).toEqual([]);
    expect(fieldProblems({}, "port")).toEqual([]);
  });

  test("does not leak one field's problems onto another", () => {
    const s = {
      APP_BASE_URL: { value: "nope", source: "config.env", problems: [{ entry: "nope", reason: "bad url" }] },
    };
    expect(fieldProblems(s, "baseUrl")).toHaveLength(1);
    expect(fieldProblems(s, "trustedOrigins")).toEqual([]);
    expect(fieldProblems(s, "port")).toEqual([]);
  });

  /**
   * A problem is about the STORED value, so it must not be shown beside a
   * field the user has since edited — that would report a complaint about a
   * value no longer on screen.
   */
  test("every CONFIG_FIELDS entry can be asked, so the render never has a gap", () => {
    for (const field of CONFIG_FIELDS) {
      expect(fieldProblems({}, field.name)).toEqual([]);
    }
  });
});

describe("the console's own asset root and stylesheet", () => {
  const ROOT = join(import.meta.dir, "..");

  /**
   * `frontendDist: "../ui"` copies that directory into the bundle as-is, so
   * anything left there ships inside the installed app. This is why these
   * tests live in `test/` — and the guard is here because the failure is
   * invisible: the app builds, runs, and simply carries dead files.
   */
  test("ui/ contains no test sources, since the whole directory is the bundle", () => {
    const stray = readdirSync(join(ROOT, "ui"), { recursive: true })
      .map(String)
      .filter((f) => /(^|[/\\])__tests__([/\\]|$)|\.test\.[jt]sx?$/.test(f));
    expect(stray).toEqual([]);
  });

  /**
   * `.warn-text` and `.hint` are both single-class selectors, so for an element
   * carrying BOTH the later declaration wins. The problem lines `main.js`
   * builds are `class="hint warn-text"` and rendered amber deliberately — with
   * `.warn-text` declared first they came out muted grey, indistinguishable
   * from the ordinary field hint directly above them. No test can see a
   * computed colour here, so the ORDER is what gets pinned.
   */
  /**
   * `renderStep` disables buttons flagged `data-tmux` while the probe finds no
   * tmux, and the flag is the 4th argument to `button()`. Every step that
   * ADVANCES setup must carry it: the CLI refuses `init`, `configure` and
   * `service install` without tmux, so an enabled button there only produces
   * the refusal.
   *
   * "Install server" was the one that did not. Installing the binary does not
   * itself need tmux — which is why it looked correct — but the step
   * immediately after it is `Create configuration`, which refuses. So the
   * console walked the user to a wall it already knew about. Pinned at the
   * source, since the flag lives in a DOM path these tests do not run.
   */
  test("every setup-advancing console action is tmux-gated", () => {
    const js = readFileSync(join(ROOT, "ui/main.js"), "utf8");

    /** The `[...]` starting at `from`, found by bracket depth rather than by regex. */
    const entryAt = (from) => {
      let depth = 0;
      for (let i = from; i < js.length; i++) {
        if (js[i] === "[") depth++;
        else if (js[i] === "]" && --depth === 0) return js.slice(from + 1, i);
      }
      throw new Error("unbalanced action entry");
    };

    /** Split on TOP-LEVEL commas: a handler like `service("install", true)` has its own. */
    const args = (entry) => {
      const out = [];
      let depth = 0;
      let start = 0;
      for (let i = 0; i < entry.length; i++) {
        const c = entry[i];
        if (c === "(" || c === "[") depth++;
        else if (c === ")" || c === "]") depth--;
        else if (c === "," && depth === 0) {
          out.push(entry.slice(start, i).trim());
          start = i + 1;
        }
      }
      out.push(entry.slice(start).trim());
      return out;
    };

    for (const label of [
      "Install server",
      "Create configuration",
      "Install and start as a service",
      "Start",
      "Save and restart",
    ]) {
      const at = js.indexOf(`["${label}",`);
      expect(at, `no action entry found for "${label}"`).toBeGreaterThan(-1);
      expect(args(entryAt(at))[3], `"${label}" is not tmux-gated`).toBe("true");
    }
  });

  test("`.warn-text` is declared after `.hint`, or a combined class renders muted", () => {
    const css = readFileSync(join(ROOT, "ui/style.css"), "utf8");
    const hint = css.indexOf(".hint {");
    const warn = css.indexOf(".warn-text {");
    expect(hint).toBeGreaterThan(-1);
    expect(warn).toBeGreaterThan(-1);
    expect(warn).toBeGreaterThan(hint);
  });
});
