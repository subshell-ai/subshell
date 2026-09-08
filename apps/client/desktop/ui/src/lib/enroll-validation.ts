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
import { type EnrollFieldName, MAX_NODE_NAME_LEN, SETUP_KEY_RE } from "@/lib/copy";

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
  args: { server: string; key: string; name: string | null };
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
      errors.server = `'${server}' is not a full URL — include the scheme, e.g. https://subshell.example.com`;
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

  const nameLength = [...name].length;
  if (nameLength > MAX_NODE_NAME_LEN) {
    errors.name = `That name is ${nameLength} characters — the control plane accepts at most ${MAX_NODE_NAME_LEN}.`;
  }

  return {
    errors,
    invalid: Boolean(errors.server || errors.key || errors.name),
    // Blank means "let the agent default to this machine's hostname", which is
    // what the CLI does — this app cannot read the hostname and will not guess.
    args: { server, key, name: name === "" ? null : name },
  };
}
