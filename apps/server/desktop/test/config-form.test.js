import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONFIG_FIELDS,
  configPayload,
  derivedBaseUrl,
  effectiveForm,
  explicitFields,
  fieldProblems,
} from "../ui/config-form.js";

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

describe("effectiveForm", () => {
  test("prefills port, bind address and base URL with what the server would boot with", () => {
    // The fields used to be blank whenever the value was derived, which left
    // the reader to notice greyed placeholder text to learn the configuration.
    expect(
      effectiveForm(
        settings({
          SERVER_PORT: ["3080", "default"],
          HOST: ["0.0.0.0", "default"],
          APP_BASE_URL: ["http://localhost:3080", "default"],
          TRUSTED_ORIGINS: ["http://localhost:5174,http://localhost:5173", "default"],
        }),
      ),
    ).toEqual({
      port: "3080",
      host: "0.0.0.0",
      baseUrl: "http://localhost:3080",
      // NOT prefilled: its default is the dev Vite origins, which would be a
      // bizarre thing to show someone configuring a real instance.
      trustedOrigins: "",
    });
  });

  test("shows a chosen value over a derived one", () => {
    expect(effectiveForm(settings({ SERVER_PORT: ["4000", "config.env"] })).port).toBe("4000");
  });

  test("is empty before the first probe lands", () => {
    expect(effectiveForm(undefined)).toEqual({ port: "", host: "", baseUrl: "", trustedOrigins: "" });
    expect(effectiveForm({})).toEqual({ port: "", host: "", baseUrl: "", trustedOrigins: "" });
  });
});

describe("explicitFields", () => {
  test("marks only what somebody chose", () => {
    const e = explicitFields(
      settings({
        SERVER_PORT: ["4000", "config.env"],
        HOST: ["0.0.0.0", "default"],
        APP_BASE_URL: ["http://box.local:4000", "process env"],
      }),
    );
    expect(e.port).toBe(true);
    expect(e.baseUrl).toBe(true);
    expect(e.host).toBeUndefined();
    expect(e.trustedOrigins).toBeUndefined();
  });

  test("an empty chosen value is not a choice", () => {
    expect(explicitFields(settings({ TRUSTED_ORIGINS: ["", "config.env"] })).trustedOrigins).toBeUndefined();
  });

  test("nothing is explicit before the first probe", () => {
    expect(explicitFields(undefined)).toEqual({});
  });
});

describe("derivedBaseUrl", () => {
  test("mirrors the CLI's derivation, so a prefilled base URL can follow the port", () => {
    expect(derivedBaseUrl("4000")).toBe("http://localhost:4000");
    expect(derivedBaseUrl(" 9000 ")).toBe("http://localhost:9000");
  });

  test("falls back to the default port for an empty field mid-edit", () => {
    expect(derivedBaseUrl("")).toBe("http://localhost:3080");
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
  test("declares one row per form key, and every key effectiveForm fills", () => {
    expect(CONFIG_FIELDS.map((f) => f.name).sort()).toEqual(Object.keys(effectiveForm({})).sort());
  });

  test("every field names the status key it seeds from", () => {
    for (const field of CONFIG_FIELDS) {
      expect(field.settingKey).toMatch(/^[A-Z_]+$/);
    }
  });
});

describe("configPayload", () => {
  const filled = {
    port: "3080",
    host: "0.0.0.0",
    baseUrl: "http://localhost:3080",
    trustedOrigins: "http://box.local:3080",
  };

  test("sends every field when nothing is known about choices", () => {
    expect(configPayload(filled)).toEqual(filled);
  });

  test("a value nobody chose is sent EMPTY, so the CLI keeps deriving it", () => {
    // The fields are prefilled, so without this the derived base URL would be
    // written into config.env and would then name a dead port after the next
    // port change. This is the failure the whole form was added to fix.
    expect(configPayload(filled, { port: true })).toEqual({
      port: "3080",
      host: "",
      baseUrl: "",
      trustedOrigins: "",
    });
  });

  test("a CHOSEN value is sent even when untouched, or saving would wipe it", () => {
    // trustedOrigins is the emptyable flag: an empty one means "no extra
    // addresses". Opening Configure and saving without touching the field must
    // not clear a stored list.
    expect(
      configPayload(filled, explicitFields(settings({ TRUSTED_ORIGINS: ["http://box.local:3080", "config.env"] }))),
    ).toEqual({ port: "", host: "", baseUrl: "", trustedOrigins: "http://box.local:3080" });
  });

  test("clearing a chosen field still clears it", () => {
    // The user typed in it, so it is explicit, and empty means empty.
    expect(configPayload({ ...filled, trustedOrigins: "" }, { trustedOrigins: true }).trustedOrigins).toBe("");
  });

  test("trims what it sends", () => {
    expect(configPayload({ port: "  4000  " }, { port: true }).port).toBe("4000");
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
  /**
   * The form is prefilled, so `configPayload` decides what to send from an
   * `explicit` map rather than from blankness. That map MUST be seeded from
   * `explicitFields` when the configure form opens: keyed on editing alone,
   * opening Configure and saving without touching the addresses field sends an
   * empty `trustedOrigins`, which means "no extra addresses" and wipes a
   * stored list. Pinned at the source because this wiring lives in `main.js`,
   * which imports Tauri and cannot be loaded here.
   */
  test("the configure form seeds `explicit` from explicitFields, not from editing alone", () => {
    const js = readFileSync(join(ROOT, "ui/main.js"), "utf8");
    const fn = js.slice(js.indexOf("function showConfigure()"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    expect(body).toContain("explicitFields(");
    // And every send goes through the map.
    for (const call of js.match(/configPayload\([^)]*\)/g) ?? []) {
      expect(call).toBe("configPayload(form, explicit)");
    }
  });

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
      // "Set up and start" is the one press that runs the whole chain, so it
      // inherits the "Install server" gate it replaced: the chain ends in
      // `init` and `service install`, both of which the CLI refuses without
      // tmux. The agent buttons carry the flag as POLICY (no pane to run an
      // agent in without tmux), pinned here so the policy cannot rot.
      "Set up and start",
      "Also install Claude Code",
      "Install Claude Code",
      "Save and start",
      "Install and start as a service",
      "Start",
      "Save and restart",
    ]) {
      const at = js.indexOf(`["${label}",`);
      expect(at, `no action entry found for "${label}"`).toBeGreaterThan(-1);
      expect(args(entryAt(at))[3], `"${label}" is not tmux-gated`).toBe("true");
    }
  });

  test("the setup step offers nothing that cannot run without a server", () => {
    // `setup` is emitted exactly when no binary resolves (`Setup` replaces
    // `InstallServer` only where `resolve` found nothing), and every write
    // verb — `desktop_init`, `desktop_service` — answers "no subshell-server
    // found" there. "Change addresses…" lived on this screen briefly: its
    // save could only ever fail, and the next "Set up and start" discarded
    // what was typed without a word. The form is reachable the moment a
    // server exists, which is every screen after this one.
    const js = readFileSync(join(ROOT, "ui/main.js"), "utf8");
    const at = js.indexOf("  setup: {");
    expect(at).toBeGreaterThan(-1);
    const entry = js.slice(at, js.indexOf("\n  },", at));
    expect(entry).not.toContain("showConfigure");
    expect(entry).not.toContain("doInit");
  });

  test("the tmux warning links out to the docs", () => {
    // Spec §6.1 requires the no-Homebrew screen to LINK to the tmux formula
    // page, not just show a command. The link is a button calling a Rust
    // command that holds the URL as its own constant (the page sends no URL
    // anywhere, the same rule `desktop_open_control_plane` follows), and
    // `applyPlan` decides visibility from the plan's `docsUrl`.
    const js = readFileSync(join(ROOT, "ui/main.js"), "utf8");
    expect(js).toContain("desktop_open_tmux_docs");
    expect(js).toContain("docsUrl");
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
