/**
 * Client-side mirrors of the backend's name-length rules, so inputs can
 * refuse an invalid value before the round-trip. Values copied verbatim from
 * the TypeBox schemas (`minLength: 1` + these maxima): subshells and
 * workspaces 120 (`subshells/update-subshell-name.route.ts`,
 * `workspaces/create-workspace.route.ts`), the instance name 64
 * (`settings.route.ts`).
 *
 * Node names are NOT here. Their cap moved to `NODE_NAME_MAX` /
 * `NODE_NAME_MAX_UNITS` in `@internal/subshell-protocol` with the 2026-09-17
 * node-setup revamp, because a node name is now typed at four doors — this SPA's
 * rename field, `subshell setup`/`--name`, the install pipe and Subshell Client's
 * Enroll step — and a fifth copy is how two of them start disagreeing. Import the
 * protocol one; note it is `…_UNITS` that an HTML `maxlength` wants, since the DOM
 * counts UTF-16 code units and the rule counts characters.
 */

/** Subshell / workspace display names. */
export const NAME_MAX_DEFAULT = 120;

/** Instance display name (`settings.route.ts`). */
export const INSTANCE_NAME_MAX = 64;
