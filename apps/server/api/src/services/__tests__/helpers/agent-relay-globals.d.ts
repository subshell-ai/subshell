/**
 * Ambient globals the agent's relay sources reference but this project's
 * typecheck lib (ES2023, no DOM) does not declare.
 *
 * The relay integration test imports the agent's relay modules (under
 * apps/node/agent) IN PLACE, so `verify-types` typechecks those sources under
 * this app's `lib`. The agent's own tsconfig carries `lib: ["ES2023", "DOM"]`,
 * which is where it gets the WebCrypto `JsonWebKey` global; this app
 * deliberately does not add DOM (it changes `Blob`/`Response` typing across
 * seven server files, measured). Adding only the one name the agent relay
 * sources actually use keeps the shim to its smallest honest size.
 *
 * Lives under `__tests__` so `tsc -p tsconfig.build.json` (whose exclude
 * list covers every `__tests__` tree under src) never sees it: the shipped
 * server emit is untouched. A double-star glob cannot be quoted here: the
 * comment-closing character pair occurs inside every double-star segment,
 * so writing one ends this comment mid-string. That is what mangled the
 * earlier wording in this file.
 */

/** The WebCrypto JSON Web Key shape, as lib.dom declares it (agent relay only). */
interface JsonWebKey {
  alg?: string;
  crv?: string;
  d?: string;
  dp?: string;
  dq?: string;
  e?: string;
  ext?: boolean;
  k?: string;
  key_ops?: string[];
  kty?: string;
  n?: string;
  oth?: Array<{ d?: string; n?: string; t?: string }>;
  p?: string;
  q?: string;
  qi?: string;
  use?: string;
  x?: string;
  y?: string;
}
