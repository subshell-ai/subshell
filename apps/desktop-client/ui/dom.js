/**
 * DOM construction, with no knowledge of what this app is for.
 *
 * Every node on this page is built here rather than from a template string:
 * the bundle's CSP is `script-src 'self'` / `style-src 'self'`, under which
 * `innerHTML` is not merely discouraged but inert — an assignment paints
 * nothing and reports nothing, so the failure looks like a blank panel rather
 * than an error. Same for inline `on*` handlers and `style` attributes.
 * `createElement` + `textContent` + `addEventListener` is the whole toolkit.
 */

export const el = (id) => document.getElementById(id);
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A step's field that may be a live function of the current probe, or a constant. */
export const text = (value) => (typeof value === "function" ? value() : (value ?? ""));
export const list = (value) => (typeof value === "function" ? value() : (value ?? []));

export function paragraph(content, className) {
  const p = document.createElement("p");
  if (className) p.className = className;
  p.textContent = content;
  return p;
}

export function button(label, handler, primary, extra) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  const classes = [];
  if (primary) classes.push("primary");
  if (extra) classes.push(extra);
  if (classes.length > 0) b.className = classes.join(" ");
  b.addEventListener("click", handler);
  return b;
}

/** One `dt`/`dd` pair in the facts list. */
export function fact(dl, key, value, cls) {
  const dt = document.createElement("dt");
  dt.textContent = key;
  const dd = document.createElement("dd");
  dd.textContent = value;
  if (cls) dd.className = cls;
  dl.append(dt, dd);
}

/**
 * Show a result's own words, VERBATIM.
 *
 * `apps/client` owns every operator-facing message — the tmux refusal, the
 * `loginctl enable-linger` hint, the live-pane refusal, every enrollment
 * failure — and its strings are pinned by its own tests. Re-wording them here
 * would drift; matching them with a regex would break on the next copy edit.
 * So this prints them and nothing else. `ok:false` is styled as a failure
 * rather than as output.
 */
export function show(result) {
  const parts = [];
  if (result?.stdout?.trim()) parts.push(result.stdout.trim());
  if (result?.stderr?.trim()) parts.push(result.stderr.trim());
  const out = el("output");
  out.textContent = parts.join("\n\n");
  out.classList.toggle("output-bad", result?.ok === false);
}
