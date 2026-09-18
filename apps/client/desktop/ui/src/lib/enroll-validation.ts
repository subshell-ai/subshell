/**
 * Check what can be checked before a setup key is spent.
 *
 * The same three rules as `validate_server_url` / `validate_setup_key` /
 * `validate_node_name` on the Rust side, run here so a typo never reaches a
 * spawn. The Rust side still runs them — this is a courtesy, not the gate.
 *
 * The KEY is never echoed into a message: it is a one-time credential, and an
 * error string is the easiest place for one to end up on a screenshot.
 */
import { NODE_NAME_MAX, normalizeNodeName } from "@internal/subshell-protocol";
import { type EnrollFieldName, SETUP_KEY_RE } from "@/lib/copy";

/** The typed values of the enroll form, held outside the DOM. */
export type EnrollValues = Record<EnrollFieldName, string>;

/** Per-field refusals, keyed like {@link EnrollValues}; "" means no refusal. */
export type EnrollErrors = Record<EnrollFieldName, string>;

export const EMPTY_ENROLL_VALUES: EnrollValues = { server: "", key: "", name: "" };
export const NO_ENROLL_ERRORS: EnrollErrors = { server: "", key: "", name: "" };

/** What {@link validateEnroll} decided. */
export interface EnrollValidation {
  errors: EnrollErrors;
  invalid: boolean;
  /** The arguments to send to `node_enroll`, valid only when `invalid` is false. */
  args: { server: string; key: string; name: string };
}

export function validateEnroll(values: EnrollValues): EnrollValidation {
  const server = values.server.trim();
  const key = values.key.trim();
  const name = values.name.trim();
  const errors: EnrollErrors = { server: "", key: "", name: "" };

  if (server === "") {
    errors.server = "Enter the control plane's URL, e.g. https://subshell.example.com";
  } else {
    let parsed: URL | null = null;
    try {
      parsed = new URL(server);
    } catch {
      parsed = null;
    }
    if (parsed === null) {
      errors.server = `'${server}' is not a full URL. Include the scheme, e.g. https://subshell.example.com`;
    } else if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      errors.server = `The server URL must be http or https, not '${parsed.protocol.replace(":", "")}'.`;
    } else if (parsed.hostname === "") {
      errors.server = `'${server}' names no host.`;
    }
  }

  if (key === "") {
    errors.key = "Paste the setup key minted on the Nodes page.";
  } else if (!SETUP_KEY_RE.test(key)) {
    errors.key = "A setup key is `nsk_` followed by 32 letters, digits, `-` or `_`. Check for a partial paste.";
  }

  // Required since the 2026-09-17 node-setup revamp, and this is the field that
  // pays for it: the Add-node dialog used to ask for a name that only ever became
  // the SETUP KEY's label, while `enroll` quietly defaulted to the hostname. The
  // question moved to where the answer is known — here, and at `subshell setup`.
  // The cap is checked on what was TYPED because `normalizeNodeName` truncates,
  // and a name silently chopped at 64 characters is a worse surprise than one
  // bounced back to the person who typed it.
  // Checked through the SAME rule the value is sent through, not by `=== ""` on the
  // trimmed text: `String.trim()` strips whitespace and nothing else, so a field
  // holding one stray control character — an NFC card's terminator, a paste with a
  // `\u000e` in it — trims to itself, looks answered, and hands `normalizeNodeName`
  // a name that reduces to "". Rust refuses that before any spawn, so no key is
  // spent, but a form that enables its own submit button for an answer it cannot
  // send is the bug whoever downstream catches it.
  const nameLength = [...name].length;
  if (normalizeNodeName(name) === "") {
    errors.name = "Name this machine — the Nodes page lists it by this name.";
  } else if (nameLength > NODE_NAME_MAX) {
    errors.name = `That name is ${nameLength} characters. The control plane accepts at most ${NODE_NAME_MAX}.`;
  }

  return {
    errors,
    invalid: Boolean(errors.server || errors.key || errors.name),
    // What is SENT is what the control plane will STORE: one rule
    // (`normalizeNodeName`) shared with enroll, rename, and the CLI's pre-flight,
    // so a pasted name carrying a stray newline cannot arrive here intact and be
    // collapsed only later.
    args: { server, key, name: normalizeNodeName(name) },
  };
}
