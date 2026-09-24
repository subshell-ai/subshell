# Node Link Encryption — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every byte crossing `/ws/node` is encrypted and authenticated at the application layer (libsodium `crypto_kx` handshake + `crypto_secretstream` frame stream), so node traffic stays confidential even on a plain-`http://` deployment.

**Architecture:** Protocol 13→14 hard cutover. A row with a stored `encryptPublicKey` must handshake before anything else (`kx` text frames → encrypted binding payload → `ok`); every later frame both directions is a binary secretstream message carrying the existing JSON wire frames unchanged. A row without one (every node enrolled before this ships) is held-updatable exactly like a below-floor refusal, and a protocol-14 agent self-heals it by sending one authenticated `{t:"register"}` frame and reconnecting encrypted. The existing command-signing, gates, held path, and frame parsers run behind the cipher untouched.

**Tech Stack:** `libsodium-wrappers-sumo` (pinned exact; WASM + pure JS, Bun-supported) behind a new subpath export of `@internal/subshell-protocol`; Bun + Elysia `ws` on the server; the agent's injected `WebSocketImpl` seam on the node; `bun:test` on both ends.

**Spec:** `docs/superpowers/specs/2026-09-24-node-link-encryption-design.md` — read it before any task; this plan argues from it, and §-references below are its sections.

## Global Constraints

- **Pinned versions** (`.claude/rules/dependencies.md`): every `package.json` version is exact, no `^`/`~`. After `bun add` run `bun run lint:packages` (syncpack) — it must stay clean.
- **No dynamic imports** except the one sanctioned site (`plugin-runtime.ts`). `await import()` is forbidden everywhere else, including loading libsodium — use a static top-level `import`.
- **The protocol package's barrel is Metro-consumed** (`packages/subshell-protocol/src/index.ts:48-55`): the new crypto module is a **subpath export only** (`@internal/subshell-protocol/node-link-crypto`), with entries in `package.json` `exports`, `tsdown.config.ts` `entry`, and **no** barrel re-export. Mobile must keep importing only the barrel.
- **The lockstep rule** (`packages/subshell-protocol/src/versions.ts`): `NODE_PROTOCOL_VERSION` 13→14, `MIN_NODE_VERSION` → `"0.17.0"`, and `apps/node/agent/package.json` `version` → `"0.17.0"` ride in ONE commit (Task 3). Then `bun run lint:lockfile:fix` and commit `bun.lock`.
- **Changesets** (spec §8): `@internal/server` and `@internal/node` **minor**. The `versions.ts` note warns against a *version-only* minor on top of a hand-raised floor; this one carries a new dependency and new config fields, so spec §8's MINOR stands — recorded here so a reviewer doesn't "fix" it to a patch.
- **Verification after every task**: `bun run verify-types`, `bun run lint:check`, `bun run test` (root, or the touched package while iterating), and `bunx turbo build` once the protocol package changed (`.claude/rules/verification.md`, `.claude/rules/build.md`). The compiled-binary proof (`bun build --compile` bundling libsodium) is `bun run release:cli-node` preflight + a plan-local check in Task 11 — `bun run compile` on the agent is enough locally.
- **Import purity / boot order**: `node-ws-handler.ts`'s upgrade hook, `open` and `message` handlers must stay synchronous-import-safe (the handlers already are; do not add eager fs at module scope in new server modules — the keypair store mirrors `control-keys.ts`'s lazy pattern).
- **Commit style**: repo convention `feat(server,node): …` / `fix(…)` etc., one commit per task, attribution `Co-Authored-By: Claude Code <noreply@anthropic.com>` (`.claude/rules/*` + repo git log).
- **The held-socket contract is unchanged**: refused agents stay offline-but-updatable, the `update` command's wire shape stays frozen (`node-frames.ts`), and `node-rpc.ts:121`'s held fallback keeps working for OLD binaries on plaintext held sockets. A v14 socket never reaches `ready` without establishing encryption first.
- **`4410` is the handshake close code** (`NODE_CLOSE_HANDSHAKE_REQUIRED`, new constant in `node-frames.ts`; confirmed free by the sweep this session — its only prior uses are a `disconnectNode` test's arbitrary input and the spec itself). The agent treats it like other non-terminal closes: relay the reason to its own log, reconnect on the existing backoff ladder. 4409/4406 keep their terminal meaning.

## Review Focus

The failure classes the spec names that no single task's happy-path test will exercise — each line gets its pinning test in the named task:

1. **The downgrade attempt**: a protocol-14 agent that skips the handshake and opens with a plaintext `ready` (forced, or a bug in the agent) on a row with NO pin must be **held**, not accepted — on a row WITH a pin it must be closed 4410 — because "the old row" cannot be distinguished from "a v14 agent forced to plaintext" by anything the attacker doesn't control. Expected: plaintext never runs subshells. (Task 9)
2. **The replay**: handshake bytes and a binding payload captured from one connection and fed onto a fresh socket cannot produce a usable session (fresh ephemerals; a foreign socket's replay cannot derive keys). Expected: the replayed frames fail authentication (4410) and nothing stateful is touched. (Task 8 test + Task 11 integration)
3. **Mid-stream corruption**: a ciphertext frame that fails `pull` never resyncs — the stream's integrity is the contract — close 4410 and let the agent reconnect. Expected: one corrupt byte ends the connection, never a skipped frame. (Tasks 8, 10)
4. **The re-register injection**: a stolen node key trying to overwrite an already-pinned `encryptPublicKey` via `{t:"register"}` — refused (4410); register is accepted ONLY on a pin-less row, where the bearer key was already the trust root for every frame (spec §5). (Task 8 test)
5. **The updated-in-place config**: a legacy `config.json` (no encryption fields, no `REQUIRED_FIELDS` change) landing under the new binary must boot, must register-with-fresh-keys on first connect, and must persist them — plus `loadConfig`'s field-by-field rebuild must not drop them on the next unrelated `updateConfig` write. (Tasks 4, 10)

---

## File structure

**Created:**

| file | responsibility |
|---|---|
| `packages/subshell-protocol/src/node-link-crypto.ts` | the ONLY crypto glue: kx keypair/session derivation, secretstream seal/open, the five handshake frame shapes + validators, `4410` constant re-export helpers. Pure (no `node:` imports — the WASM lib is universal). |
| `packages/subshell-protocol/src/__tests__/node-link-crypto.test.ts` | known-answer vectors + seal/open round trip + corruption refusal + KAT against published libsodium kx vectors. |
| `apps/server/api/src/services/nodes/node-encryption-keys.ts` | the server static kx keypair store at `<dataDir>/node-encryption.json`, mirroring `control-keys.ts` (lazy, 0600, fail-closed on corrupt, clear-on-failure cache). |
| `apps/server/api/src/services/nodes/__tests__/node-encryption-keys.test.ts` | file lifecycle + mode + fail-closed reads, mirroring `control-keys.test.ts`. |
| `apps/server/api/src/services/nodes/link-session.ts` | server-side per-connection handshake state machine + the pre-handshake gate that `node-ws-handler` calls (kept OUT of `node-ws-handler.ts` because that file is already ~800 lines — `.claude/rules/code-style.md`). |
| `apps/server/api/src/services/nodes/__tests__/link-session.test.ts` | the acceptor's state machine, negative paths, pin rules. |
| `apps/node/agent/src/link-crypto.ts` | agent-side: own keypair generation/persistence helpers (config-mediated), the client handshake sequence, session state helpers. |
| `apps/node/agent/src/__tests__/link-crypto.test.ts` | unit coverage of the agent's handshake pieces. |
| `apps/server/api/src/db/migrations/0035-node-encrypt-public-key.ts` | the add-column migration (+ its map entry — the both-places rule). |

**Modified (each in the task that explains the change):** `node-frames.ts` (protocol 14, 4410, handshake type note), `versions.ts` (floor), `apps/node/agent/package.json` (lockstep), `packages/subshell-protocol/{package.json,tsdown.config.ts}`, `db/migrate.ts`, `db/types/nodes.db-types.ts`, `db/repositories/nodes.repository.ts` (`create` mirror + `setEncryptPublicKey`), `services/nodes/control-keys.ts` (doc pointer only if needed), `api/nodes/enroll.route.ts` (+ `api/nodes/__tests__/enroll-route.test.ts`), `api/nodes/rotate-node-key.route.ts` (+ test), `services/nodes/node-ws-handler.ts` (+ test), `services/nodes/node-rpc.ts` (+ test), `services/nodes/node-registry.ts` (`NodeConnection.enc`), `ws/ws.plugin.ts` (message filter accepts binary), `apps/node/agent/src/daemon.ts` (the handshake in `runConnection`, binary admit, send wrap), `apps/node/agent/src/config.ts` (`loadConfig` model + `updateConfig` persistence), `apps/node/agent/src/enroll.ts`, `apps/node/agent/src/status --probe` path if needed (decided Task 10), `api/nodes/node-view.ts` (held reason union + chip), the SPA node detail chip, `docs/security.md`, `.claude/rules/security-context.md`, `docs/security-overview.md`, `apps/docs` (add-node/managing-a-node + reference pages), `.changeset/*`.

---

## Task 1: The crypto module — `node-link-crypto.ts` (subpath export)

**Files:**
- Create: `packages/subshell-protocol/src/node-link-crypto.ts`
- Create: `packages/subshell-protocol/src/__tests__/node-link-crypto.test.ts`
- Modify: `packages/subshell-protocol/package.json` (add dependency + `exports` entry)
- Modify: `packages/subshell-protocol/tsdown.config.ts` (add `src/node-link-crypto.ts` to `entry`)

**Interfaces:**
- Consumes: `libsodium-wrappers-sumo` (new dependency, pinned — this task chooses the version).
- Produces (exact names the rest of the plan uses):
  - **What `crypto_kx` actually is** (so no implementer "fixes" the derivation from the spec's looser §2 prose): ONE X25519 DH — the client's FRESH per-connection ephemeral with the server's LONG-TERM static — plus a hash binding of both publics (`libsodium` `crypto_kx_client_session_keys(client_pk, client_sk, server_pk)` / `crypto_kx_server_session_keys(server_pk, server_sk, client_pk)`). Server authentication = only a holder of the server static derives keys that make the node's first ciphertext decryptable; node authentication = the binding payload's bearer key (spec §4 step 4: "the long-term static already matched at step 3" — a CLAIM compared against the row's pin, not a second DH). The known-answer vectors in this task are the authority; §2's "two DHs" names the protocol class, not the call count.
  - `ensureSodium(): Promise<Sodium>` (idempotent ready gate; every other export awaits it internally; the sodium instance is returned because Tasks 7/9 need `sodium.from_base64` for frame-field length checks). `type Sodium = typeof _sodium`.
  - `type LinkKeyPair = { publicKey: string; privateKey: string }` (base64, 32 bytes)
  - `generateLinkKeyPair(): Promise<LinkKeyPair>` (the LONG-TERM node pair, persisted at enroll; the server's, persisted at first use)
  - `createClientSession(opts: { serverStaticPublicKey: string }): Promise<{ session: LinkSession; ephemeralPublicKey: string }>` — generates the fresh per-connection ephemeral and derives via `crypto_kx_client_session_keys`; the ephemeral's private half is dropped after derivation (forward secrecy is the point of its freshness).
  - `createClientSessionWithEphemeral(opts: { serverStaticPublicKey: string; ephemeral: LinkKeyPair }): Promise<{ session: LinkSession; ephemeralPublicKey: string }>` — the deterministic twin. Production `createClientSession` is a thin wrapper over it with a fresh pair; the KAT vector pins the statics AND this ephemeral — a derivation the production path cannot reach is the one thing a KAT must not exercise.
  - `createServerSession(opts: { serverStatic: LinkKeyPair; clientEphemeralPublicKey: string }): Promise<LinkSession>` — the caller (Task 7) compares the frame's claimed `pub` against the row's pin BEFORE deriving; a mismatch never reaches this function.
  - `interface LinkSession { sealFrame(plaintext: string): Uint8Array; openFrame(ciphertext: Uint8Array): string | null; }` — the FIRST `sealFrame` output carries the 24-byte `crypto_secretstream` header prefixed; `openFrame` splits it on the first message. `openFrame` returns `null` on tag failure (never throws for adversary input).
  - Handshake frame types + validators: `type KxFrame = { t: "kx"; eph: string; pub?: string }`, `type RegisterFrame = { t: "register"; pub: string }`, `type RegisterOkFrame = { t: "register-ok"; controlEncryptPublicKey: string }`, `type LinkBinding = { nodeId: string; nodeKey: string; protocolVersion: number }`, `type LinkAck = { t: "ok" }`, plus `parseKxFrame(v: unknown): KxFrame | null`, `parseRegisterFrame(v: unknown): RegisterFrame | null`, `parseRegisterOkFrame(v: unknown): RegisterOkFrame | null`, `parseLinkBinding(v: unknown): LinkBinding | null`, `parseLinkAck(v: unknown): LinkAck | null`. Validators are hand-rolled in `node-frames.ts`'s style (`isRecord` from `guards.ts`, `default: null`).
  - `const LINK_HEADER_BYTES = 24;`

- [ ] **Step 1: choose and pin the library version.** `bun info libsodium-wrappers-sumo` (network — allowed: this is dependency resolution, not CI). Record the exact version; spec §2 wrote "0.8.4 at writing" — pin whatever the registry shows today (the `audit:deps` gate and `lint:packages` watch it from the first commit). Then:

```bash
cd packages/subshell-protocol
bun add libsodium-wrappers-sumo@<the-exact-version>
bun run lint:packages   # from repo root; must stay clean (fix with syncpack fix + bun install if not)
```

- [ ] **Step 2: register the subpath.** In `packages/subshell-protocol/package.json` `exports`, add beside `./release-signature`:

```json
    "./node-link-crypto": {
      "types": "./dist/node-link-crypto.d.ts",
      "import": "./dist/node-link-crypto.js"
    },
```

In `tsdown.config.ts` `entry`, add `"src/node-link-crypto.ts"`. **Do not** touch `src/index.ts` (the barrel NOTE at `index.ts:48-55` — mobile).

- [ ] **Step 3: write the failing test** — `packages/subshell-protocol/src/__tests__/node-link-crypto.test.ts`. Cover: kx known-answer vectors (the spec §7 requirement — use the published libsodium `crypto_kx` KAT pairs: fixed client/server statics + fixed client ephemeral → fixed rx/tx; transcribe one vector from the libsodium test-suite `tests/secretstream.c` / `crypto_kx` KAT output at implementation time and record its source in the comment), seal/open round trip (first frame carries the header, later ones do not), openFrame returns null on a flipped byte, validators reject junk shapes.

```ts
import { describe, expect, it } from "bun:test";
import {
  createClientSession,
  createClientSessionWithEphemeral,
  createServerSession,
  ensureSodium,
  generateLinkKeyPair,
  LINK_HEADER_BYTES,
  parseKxFrame,
  parseLinkAck,
  parseLinkBinding,
  parseRegisterFrame,
  parseRegisterOkFrame,
} from "../node-link-crypto.js";

describe("node-link-crypto", () => {
  it("round-trips frames between a client and server session", async () => {
    await ensureSodium();
    const server = await generateLinkKeyPair();
    const clientEph = await generateLinkKeyPair();
    const { session: client } = await createClientSessionWithEphemeral({
      serverStaticPublicKey: server.publicKey,
      ephemeral: clientEph,
    });
    const srv = await createServerSession({
      serverStatic: server,
      clientEphemeralPublicKey: clientEph.publicKey,
    });
    const a = srv.openFrame(client.sealFrame(JSON.stringify({ nodeId: "n", nodeKey: "k", protocolVersion: 14 })));
    expect(JSON.parse(a!)).toEqual({ nodeId: "n", nodeKey: "k", protocolVersion: 14 });
    const b = client.openFrame(srv.sealFrame(JSON.stringify({ t: "ok" })));
    expect(parseLinkAck(JSON.parse(b!))).toEqual({ t: "ok" });
    // later frames work too (the ratchet rekeys per message)
    client.openFrame(srv.sealFrame("second"));
    srv.openFrame(client.sealFrame("second"));
  });

  it("openFrame returns null — never throws — on tampered ciphertext", async () => { /* … flip a byte … */ });
  it("pins kx known-answer derivation", async () => { /* … vector + expected send/receive keys as base64 … */ });
  it("the first sealed frame carries the 24-byte secretstream header", async () => {
    /* sealFrame(...) length === LINK_HEADER_BYTES + sodium_crypto_secretstream_ABYTES + msg length */
  });
  it("validators reject every junk shape", async () => { /* null, "", {}, {t:"kx"}, {t:"kx",eph:123}, … */ });
});
```

(The test uses `createClientSessionWithEphemeral` to pin the ephemeral — see the Interfaces block: production `createClientSession` is the same function with a freshly generated ephemeral, so the vector exercises the real derivation, not a test-only one. Note the `node` pair appears in the test only as the server-static stand-in for seal/open; the kx derivation itself never sees a node static — one DH, ephemeral×static, per the Interfaces note.)

- [ ] **Step 4: run it, watch the module-not-found.** `cd packages/subshell-protocol && bun test src/__tests__/node-link-crypto.test.ts` → FAIL: cannot resolve `../node-link-crypto.js`.

- [ ] **Step 5: write `node-link-crypto.ts`.** Full implementation (match `node-frames.ts`'s doc-comment density — every non-obvious ordering gets its sentence):

```ts
/**
 * The /ws/node link encryption primitives — spec 2026-09-24 §2.
 *
 * Two official libsodium constructions do every cryptographic act here, and
 * this module adds NO protocol logic beyond choosing them and serializing:
 *
 * - `crypto_kx_*_session_keys`: a one-round two-message key exchange. Both
 *   sides hold a LONG-TERM static (the server's, pinned per node as
 *   `controlEncryptPublicKey`; the node's, provisioned at enroll as
 *   `nodes.encryptPublicKey`) and mix it with a FRESH per-connection
 *   ephemeral — forward secrecy for a leaked static, mutual authentication
 *   for the ephemeral.
 * - `crypto_secretstream_xchacha20poly1305`: a ratcheting authenticated
 *   byte stream. Per-message rekey is the library's construction, not a
 *   schedule of ours; a tampered message makes `pull` fail, which `openFrame`
 *   reports as `null` — the CALLER's job is to never resync a failed stream
 *   (spec §6: the stream's integrity is the contract).
 *
 * Pure JS/WASM by design (no `node:` imports), so a consumer CAN barrel it —
 * but it is a SUBPATH export (spec §2's Bun-support note; the wire.ts /
 * release-signature precedent): mobile imports the barrel and never needs
 * this, and WASM weight should not ride a barrel it cannot use.
 *
 * Base64 (libsodium's `to_base64`) is the on-file and on-text-frame encoding
 * for every key here — consistent with how the rest of the link serializes
 * (JWK JSON strings); binary frames themselves are raw bytes, never base64.
 */
import _sodium from "libsodium-wrappers-sumo";

let sodium: typeof _sodium | undefined;

/** Awaiting this is cheap after the first call; every export below calls it. */
export async function ensureSodium(): Promise<typeof _sodium> {
  if (!sodium) {
    await _sodium.ready;
    sodium = _sodium;
  }
  return sodium;
}
```

Then: `LinkKeyPair`, `generateLinkKeyPair` (`crypto_kx_keypair`, `to_base64`), `createClientSessionWithEphemeral` + `createClientSession` (which calls the former with a fresh `crypto_kx_keypair()`, and returns `{ session, ephemeralPublicKey }` — the caller sends `ephemeralPublicKey` as the frame's `eph`), `createServerSession`, the `LinkSession` returned object (per-direction state: `push` state with its header captured once and prefixed onto the first sealed frame, `pull` state initialized lazily when the first inbound frame arrives — split the first 24 bytes; `pull`/`push` wrapped in try/catch → `openFrame` null), the five frame types + `isRecord`-style validators, `LINK_HEADER_BYTES = 24`.

Derivation detail the session constructors must respect: client side gets `(clientPk, clientSk, serverPk)` → `{receiveKey, sendKey}` from `crypto_kx_client_session_keys`; server side `(serverPk, serverSk, clientEphPk)` from `crypto_kx_server_session_keys`. `LinkSession.sealFrame` uses the creator's SEND key (client: `sendKey`; server: `receiveKey` — verify the pairing direction against the KAT vector, NOT against intuition; the vectors exist precisely because the two libs disagree on which name is which).

- [ ] **Step 6: run the tests → green.** `bun test src/__tests__/node-link-crypto.test.ts`. If the kx vector mismatches, the derivation direction is wrong (see Step 5's note) — fix the wiring, not the vector.
- [ ] **Step 7: full gates + build** (the module must survive the workspace build): `cd /Users/theo/projects/subshell && bun run verify-types && bun run lint:check && bunx turbo build --filter=@internal/subshell-protocol`. Confirm `packages/subshell-protocol/dist/node-link-crypto.js` and the `.d.ts` exist after the build (the three coordinated registration bits — `exports`, `entry`, no barrel — are the reviewable set).
- [ ] **Step 8: commit** `git add -A packages/subshell-protocol bun.lock && git commit -m "feat(protocol): node-link crypto primitives — libsodium kx + secretstream glue"`

---

## Task 2: Server-side kx keypair store

**Files:**
- Create: `apps/server/api/src/services/nodes/node-encryption-keys.ts`
- Create: `apps/server/api/src/services/nodes/__tests__/node-encryption-keys.test.ts`

**Interfaces:**
- Consumes: `@internal/subshell-protocol/node-link-crypto` (`ensureSodium`, `generateLinkKeyPair`, `LinkKeyPair`), `SUBSHELL_SERVER_DATA_DIR` from `@/constants.js`.
- Produces: `loadNodeEncryptionKeys(): Promise<LinkKeyPair>`; `nodeEncryptionPublicKeysJson(): Promise<string>` (base64 — the enroll-response value); `resetNodeEncryptionKeysForTests(): void`.

- [ ] **Step 1: write the failing test** mirroring `control-keys.test.ts`'s structure verbatim (same `KEY_PATH` mirror, same `IS_TEST` guard, `rmSync` + reset per case): fresh boot generates the file and pins mode (`statSync(KEY_PATH).mode & 0o077 === 0` at 0600), a corrupt file THROWS naming `node-encryption` and the file survives untouched, a wrong-shape file throws, and `nodeEncryptionPublicKeysJson()` answers the stored pub.

```ts
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { IS_TEST, SUBSHELL_SERVER_DATA_DIR } from "@/constants.js";
import { loadNodeEncryptionKeys, nodeEncryptionPublicKeysJson, resetNodeEncryptionKeysForTests } from "../node-encryption-keys.js";

const KEY_PATH = `${SUBSHELL_SERVER_DATA_DIR}/node-encryption.json`;
// … beforeAll guard `if (!IS_TEST) throw …`; beforeEach rmSync(KEY_PATH, {force:true}); reset…();
// cases per control-keys.test.ts: generates+0600, refuses corrupt (file survives), refuses
// wrong-shape, publicKeysJson matches.
```

- [ ] **Step 2: run → fails (module missing).**
- [ ] **Step 3: write `node-encryption-keys.ts`** — a deliberate COPY of `control-keys.ts`'s shape, not an import/refactor of it: one file one key, and the doc header states why the shape diverges from signing (X25519 kx seed stored as base64 inside `{ publicKey, privateKey }` JSON rather than a JWK — libsodium's native encoding, and this key NEVER signs anything). Lazy (first use = first enroll that has to answer `controlEncryptPublicKey`, or the first handshake), `writeFileSync` + `chmodSync` at 0600, `isLinkKeyPair` shape gate requiring both base64 strings of the right decoded length, cache cleared on failure so a refusal never mutates the file.

```ts
/**
 * The server's static key for /ws/node link encryption — spec 2026-09-24 §3.
 *
 * A SECOND keypair beside the signing one, deliberately NOT derived from it:
 * one key one job, so a bug in one construction cannot reach the other. Same
 * lifecycle and rotation semantics as `node-signing.json`: lazy at first use,
 * 0600, fail-closed (a corrupt file refuses to start encryption and is NEVER
 * regenerated — a fresh key orphans every pin by design). Rotation is manual:
 * delete the file, every node's `controlEncryptPublicKey` pin breaks, machines
 * re-provision — the warning `docs/security.md` already carries for the
 * signing key applies verbatim.
 */
const KEY_PATH = `${SUBSHELL_SERVER_DATA_DIR}/node-encryption.json`;
```

- [ ] **Step 4: run → green.**
- [ ] **Step 5: commit** `feat(server): the node-link encryption keypair store (lazy, 0600, fail-closed)`

---

## Task 3: The protocol bump — 13→14, the floor, 4410

**Files:**
- Modify: `packages/subshell-protocol/src/node-frames.ts` (version line ~120 + changelog doc + the new `NODE_CLOSE_HANDSHAKE_REQUIRED` constant beside 4406/4409)
- Modify: `packages/subshell-protocol/src/__tests__/node-frames.test.ts` (the literal `.toBe(13)` → `14`)
- Modify: `packages/subshell-protocol/src/versions.ts` (`MIN_NODE_VERSION = "0.17.0"`)
- Modify: `apps/node/agent/package.json` (`"version": "0.17.0"`)

**Interfaces:**
- Produces: `NODE_PROTOCOL_VERSION = 14`, `NODE_CLOSE_HANDSHAKE_REQUIRED = 4410`, `MIN_NODE_VERSION = "0.17.0"` — consumed by Tasks 8–10.
- Note: after this commit, a node built from PREVIOUS commits is refused by a server at HEAD (protocol mismatch — the gates hold it, which is correct: server+node ship together). Intermediate commits on this branch are allowed to have a mismatched dev pair; nothing ships.

- [ ] **Step 1: update the pin test first** (so the bump is test-led): `node-frames.test.ts:185` → `expect(NODE_PROTOCOL_VERSION).toBe(14);`. Run `cd packages/subshell-protocol && bun test src/__tests__/node-frames.test.ts` → FAIL 13≠14.
- [ ] **Step 2: `node-frames.ts`** — version line → 14; add the changelog entry in the file's own style: `13→14: the link is encrypted end-to-end (spec 2026-09-24). kx handshake, secretstream frames, the register self-heal, close 4410. Hard cutover: protocol-14 nodes never write plaintext frames, and legacy rows are held-updatable until they register.` Add beside 4406/4409:

```ts
/** Close: the link refused to speak without the encryption handshake
 *  (spec 2026-09-24 §6). Not terminal for the agent: the reason is relayed
 *  to its own log and the existing backoff loop reconnects — the register
 *  self-heal (§5) rides the next dial. */
export const NODE_CLOSE_HANDSHAKE_REQUIRED = 4410;
```

- [ ] **Step 3: `versions.ts`** `MIN_NODE_VERSION` → `"0.17.0"`; `apps/node/agent/package.json` → `"0.17.0"` (the lockstep rule verbatim: the refusal must name a version that exists).
- [ ] **Step 4: tests green** — `bun test src/__tests__/node-frames.test.ts` (protocol pin) and `versions.test.ts` (its `nodeVersionSupported(MIN_NODE_VERSION)` case stays green automatically — it derives, doesn't hardcode).
- [ ] **Step 5: `bun run lint:lockfile:fix`** (the agent package version moved in its `package.json`; `bun install` does NOT resync the lockfile's workspace `version` field — the one sanctioned edit, `rules/dependencies.md`).
- [ ] **Step 6: full gates + commit** `feat(protocol): bump node link to protocol 14 — encrypted (floor 0.17.0, close 4410)`

---

## Task 4: The column, the rows, the node config field

**Files:**
- Create: `apps/server/api/src/db/migrations/0035-node-encrypt-public-key.ts`
- Modify: `apps/server/api/src/db/migrate.ts` (import + map entry `"0035-node-encrypt-public-key"`)
- Modify: `apps/server/api/src/db/types/nodes.db-types.ts` (`encryptPublicKey: string | null` with its JSDoc)
- Modify: `apps/server/api/src/db/repositories/nodes.repository.ts` (`create()`'s `?? null` mirror + `setEncryptPublicKey`)
- Test: extend `apps/server/api/src/db/repositories/__tests__/nodes.repository.test.ts` (or the route test that already covers create round-trips)
- Modify: `apps/node/agent/src/config.ts` (`NodeConfig` + `loadConfig` model both new fields — NOT `REQUIRED_FIELDS`)
- Test: `apps/node/agent/src/__tests__/config.test.ts` extension

**Interfaces:**
- Produces: `NodeTable.encryptPublicKey` (base64 X25519 pub or null); `NodesRepository.setEncryptPublicKey(id, string | null)`; agent config fields `encryptKeyPair?: { publicKey: string; privateKey: string }` and `controlEncryptPublicKey?: string`.
- Consumed by Tasks 5–9.

- [ ] **Step 1: the migration**, pattern-copied from `0031-node-maintenance.ts`:

```ts
import type { Kysely } from "kysely";

/**
 * `nodes.encryptPublicKey` — the node's static X25519 public half for the
 * /ws/node link encryption (spec 2026-09-24 §3). NULL is the whole migration
 * story: every node enrolled before this column exists reads NULL, which is
 * precisely "legacy mode — held-updatable until it registers" (§5). No
 * backfill and no default: a wrong key here is a pinned-identity break, not
 * a missing preference.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("nodes").addColumn("encryptPublicKey", "text").execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("nodes").dropColumn("encryptPublicKey").execute();
}
```

- [ ] **Step 2: the map entry** in `migrate.ts` (both-places rule; file name == map key) + the import line beside `favoritesNodeScopeMigration`.
- [ ] **Step 3: the type** — `NodeTable.encryptPublicKey: string | null;` with JSDoc ("base64 X25519 public key pinned for link encryption; null = legacy row (held-updatable until it registers — spec 2026-09-24 §5)"). `NewNode` picks it up as optional automatically (verified: `Pick`-and-`Partial` shape).
- [ ] **Step 4: the repository** — in `create()` mirror `encryptPublicKey: input.encryptPublicKey ?? null` beside `publicKey`; add `setEncryptPublicKey(id, key: string | null)` (mirror `setApiKeyId` verbatim: update + `updatedAt`).
- [ ] **Step 5: the agent config**: `NodeConfig` gains the two optional fields (JSDoc each: the private half's ONLY home is this 0600 file, same doctrine as `nodeKey`); `loadConfig`'s field-by-field rebuild MODELS both (a dropped field is silently cleared by the next unrelated `updateConfig` write — the retention/debug-logging precedent); `REQUIRED_FIELDS` stays EXACTLY as is (spec §3: a legacy config updated in place lacks them until the §5 self-heal).
- [ ] **Step 6: tests** — repository: create-with + round-trip read; config: `updateConfig({ debugLogging: true })` over a config that has the new fields keeps them (the merge discipline), and `loadConfig` survives their absence (legacy shape boots).
- [ ] **Step 7: full gates + commit** `feat(server,node): nodes.encryptPublicKey column + agent link-key config fields`

---

## Task 5: Enroll provisions both directions

**Files:**
- Modify: `apps/node/agent/src/enroll.ts` (generate kx keypair, POST `encryptPublicKey`, parse `controlEncryptPublicKey`)
- Modify: `apps/server/api/src/api/nodes/enroll.route.ts` (`EnrollBodySchema.encryptPublicKey`, validate pre-consume, `nodes.create` carries it, `EnrollResponseSchema` + response carry `controlEncryptPublicKey`)
- Test: `apps/server/api/src/api/nodes/__tests__/enroll-route.test.ts`, `apps/node/agent/src/__tests__/enroll.test.ts`

**Interfaces:**
- Consumes: Task 1 (`generateLinkKeyPair` via the agent — the agent imports the subpath), Task 2 (`nodeEncryptionPublicKeysJson()`), Task 4 (column + config fields).
- Produces: enroll requests carry `encryptPublicKey` (base64, 43-44 chars); enroll responses carry `controlEncryptPublicKey`; both land persisted (row + `config.json`).

- [ ] **Step 1: server-side failing test** — enroll with a valid `encryptPublicKey` stores it on the row and the 201 response includes `controlEncryptPublicKey` (base64, decodes to 32 bytes); enroll WITHOUT it (a pre-v14 one-liner stays valid) stores null and the response STILL includes the field (agents always pin it); malformed (non-base64/length) → 400 BEFORE the setup key is consumed (the `assertImportablePublicJwk` precedent's position: validation joins the pre-consume block at `enroll.route.ts:136-178`).
- [ ] **Step 2: implement server side** — `EnrollBodySchema`: `encryptPublicKey: t.Optional(t.String({ minLength: 43, maxLength: 44, description: "…base64 X25519…" }))`; validate by decoding via `ensureSodium().from_base64` (a wrong length → 400 naming the field); `nodes.create({ …, encryptPublicKey: body.encryptPublicKey ?? null })`; response: `controlEncryptPublicKey: await nodeEncryptionPublicKeysJson()`.
- [ ] **Step 3: agent-side failing test** — a faked-plane enroll generates a keypair (assert the POST body carries `encryptPublicKey`), and the config written afterward holds BOTH the pinned `controlEncryptPublicKey` and the `encryptKeyPair` (private + public); a response MISSING `controlEncryptPublicKey` fails enroll the way the missing `controlPublicKey` does today (malformed-response message; the key is already spent — same honesty).
- [ ] **Step 4: implement agent side** — `enroll.ts`: `const link = await generateLinkKeyPair();` (after identity load, before POST — a fresh keypair per enroll is the point: it is the node's identity for the link); body gains `encryptPublicKey: link.publicKey`; response parse gains the two fields; `saveConfig({ …, encryptKeyPair: link, controlEncryptPublicKey })`.
- [ ] **Step 5: gates + commit** `feat(server,node): enroll provisions link keys both directions`

---

## Task 6: The wire plumbing — binary-capable sockets on both ends

Nothing speaks binary yet; this task widens the seams and proves it with round-trip tests. Pure plumbing, no policy.

**Files:**
- Modify: `apps/server/api/src/services/nodes/node-registry.ts` (`NodeSocket.send` accepts binary; the held/live records gain `link?: LinkSession`)
- Modify: `apps/server/api/src/services/nodes/node-rpc.ts:180` (the single send site seals through `conn.link` when present)
- Modify: `apps/server/api/src/ws/ws.plugin.ts` (`/ws/node` message filter lets binary reach the handler)
- Modify: `apps/node/agent/src/daemon.ts` (`WsLike.send` binary; `admitFrame` returns bytes or text)
- Test: extend `node-registry` tests + a `node-rpc.test.ts` case; agent-side `daemon.test.ts` fake wrappers accept binary

**Interfaces:**
- Consumes: Task 1 `LinkSession`.
- Produces: `NodeConnection.link?: LinkSession` (undefined = plaintext legacy/held path); `NodeSocket.send(data: string | Buffer): unknown`; agent `WsLike.send(data: string | Uint8Array): void`; `admitFrame` returns `{ text } | { bytes } | null`.
- The **Buffer-view fact** (the Elysia 1.4.29 trap that bit `/ws/live`): a bare `Uint8Array` handed to `ElysiaWS.send` is JSON-stringified into a TEXT frame. Server binary sends must wrap: `Buffer.from(u8.buffer, u8.byteOffset, u8.length)` — the `wsBinaryPayload` precedent in `ws/viewers.ts`. Put a named helper in `node-rpc.ts` (`binaryPayload(u8)`) with that sentence as its comment.

- [ ] **Step 1: server tests first** — a `node-rpc.test.ts` case: a fake `NodeSocket` recording `send` payloads; a connection with a `link` session; `sendCommand` produces a Buffer (not a string) on the wire whose `link.openFrame(bytes)` round-trips to the `{"jws": …}` envelope. A connection with NO link still sends the plain text envelope (the held path unchanged).
- [ ] **Step 2: implement** — widen `NodeSocket`; `conn.ws.send(conn.link ? binaryPayload(conn.link.sealFrame(JSON.stringify({ jws }))) : JSON.stringify({ jws }))`. Registry records carry `link` (set by Task 8's acceptor).
- [ ] **Step 3: ws.plugin filter** — `/ws/node`'s message hook currently early-returns non-string non-object. Binary arrives as Buffer (typeof "object") — already passes the filter; VERIFY by test in `node-ws-integration.test.ts` (a raw binary send from the test client reaches `handleNodeMessageQueued` as Buffer, not dropped). If Elysia hands `ArrayBuffer`/typed arrays differently, normalize at the hook edge (the `/ws` browser path's `decodeIncoming` is the precedent for shape-normalizing there, NOT here — the node handler does its own).
- [ ] **Step 4: agent side** — `WsLike.send` widened; `admitFrame`: `typeof data === "string" → {text}`; Buffer/`ArrayBuffer`/`Uint8Array` → normalize to `Uint8Array` → `{bytes}`; oversize check applies to BOTH forms (bytes length, text byteLength — same cap). Test: the fake wrapper records binary sends; `wrapRealWsWithPump`'s `deliverBurst` accepts bytes.
- [ ] **Step 5: gates + commit** `feat(server,node): binary-capable node-link frames + send-sealing seam on the rpc path`

---

## Task 7: The handshake acceptor — `link-session.ts` (server policy)

The state machine that decides, per socket and per row, what the first frames may be. This is where spec §4 and §6's failure modes live. Kept out of `node-ws-handler.ts` (800-line file, `code-style.md`).

**Files:**
- Create: `apps/server/api/src/services/nodes/link-session.ts`
- Create: `apps/server/api/src/services/nodes/__tests__/link-session.test.ts`

**Interfaces:**
- Consumes: Task 1 (all frame types, `createServerSession`, `LinkSession`), Task 2 (`loadNodeEncryptionKeys`), Task 4 (`setEncryptPublicKey`).
- Produces:
  - `beginLinkUpgrade(node: NodeTable): { mode: "handshake" } | { mode: "legacy" }` — classification by the row (`node.encryptPublicKey !== null`), called by `authenticateNodeUpgrade` and stashed on `NodeWsIdentity` (extend it: `linkMode: "handshake" | "legacy"` + `encryptPublicKey: string | null` rides `ws.data`).
  - `type LinkDecision = "kx" | "register" | "established-text" | "reject"` + `handleLinkFrame(deps, ws, frame: {text} | {bytes}): Promise<LinkOutcome>` where `LinkOutcome` is `{ consumed: true, established?: LinkSession }` (drive the socket), `{ forwarded: string }` (plaintext JSON to hand to `parseNodeEvent` — legacy rows only), or `{ close: { code: 4410 | …, reason: string } }`.
  - `HANDSHAKE_TIMEOUT_MS` (arm per spec §6's close-without-resync doctrine; a socket that opens and says nothing closes 4410).

**The machine (spec §4/§5/§6), exactly:**
- **mode "handshake"** (row has a pin): the ONLY accepted first frame is text `{t:"kx", eph, pub}`. Verify BOTH `eph` and `pub` base64-decode to 32 bytes, and `pub` EQUALS the row's `encryptPublicKey` (constant-time compare — the claimed long-term identity must match the pin; a mismatch closes 4410 and never reaches derivation). Then `createServerSession({ serverStatic: await loadNodeEncryptionKeys(), clientEphemeralPublicKey: eph })`; reply text `{t:"kx", eph: serverEph}` (the server's OWN fresh kx ephemeral — generated in the same step); now **awaiting binding**: the next frame MUST be bytes that `openFrame` yields `LinkBinding` with `nodeId` equal to the bearer row's id, `nodeKey` matching the row's key by hash compare, `protocolVersion === NODE_PROTOCOL_VERSION`; on success reply bytes `sealFrame('{"t":"ok"}')` and establish. ANY other first frame, ANY frame before binding arrives that isn't the binding, binding mismatch, or an undecryptable first bytes → close **4410** with a specific reason.
- **mode "legacy"** (row null): text `{t:"register", pub}` (validated 32-byte base64) → `setEncryptPublicKey(id, pub)` → reply text `{t:"register-ok", controlEncryptPublicKey: <server static pub>}` → socket CLOSES normally (the agent reconnects encrypted; do not try to handshake on the same socket — spec §5). Otherwise (pre-v14 binary speaking today's plaintext): `forwarded` to the existing gates/hold path **unchanged** — that path's `ready`-based below-floor hold is what keeps a v13 agent offline-but-updatable, and protocol 14's exact-match hold keeps a v14-impostor-from-a-downgrade from passing.
- **Established**: bytes → `openFrame` → `forwarded` string (or 4410 on null). No plaintext accepted once established; no ciphertext accepted before established.
- **Caps** (spec §4.5): the byte cap runs on raw frame size pre-decrypt (`frameBytes` at `node-ws-handler.ts:434` unchanged), and on `forwarded.length` post-decrypt (the existing check stays — the forwarded string hits it on its way through). Ciphertext is ≤ plaintext + 17B (`crypto_secretstream_ABYTES`), so no second constant is needed.

- [ ] **Step 1: write the whole failing test file** covering every line of the machine above: handshake happy path (kx → kx reply → binding → ok, returns `established`), every reject at 4410 (plaintext ready as first frame on a handshake row — Review Focus #1's server half; wrong eph length; bad binding nodeId; wrong nodeKey; protocol mismatch; ciphertext before kx; garbage as first bytes), the timeout arming, legacy register→close, legacy forward-for-hold, and register validation rejects. Use `node-ws-handler.test.ts`'s `fakeSocket`/`makeHarness` shape (import or copy; a fake `ws.close` recorder suffices).
- [ ] **Step 2: run → red.**
- [ ] **Step 3: implement `link-session.ts`** with a per-connection mutable state stashed on `ws.data` (`linkState?: { phase: "awaiting-kx" | "awaiting-binding" | "established"; pendingEph?: string; session?: LinkSession }` — the Elysia fresh-wrapper-per-event fact means `ws.data` is the only scratch, exactly as the handler's own comment at 87–92). The binding payload's `nodeKey` comparison: hash compare the presented key against the row's stored key hash the same way the bearer verification does — reuse `verifyApiKey`-adjacent comparison or store the presented key's hash; **do not invent a new comparison** — check `auth/apikey-store.ts` for the hash helper and use it (the upgrade already authenticated this key; the binding is re-proving it INSIDE the encrypted channel, per spec §4 step 4).
- [ ] **Step 4: run → green.**
- [ ] **Step 5: commit** `feat(server): the link handshake state machine (kx, binding, register, 4410)`

---

## Task 8: Wire the acceptor into `node-ws-handler.ts`

**Files:**
- Modify: `apps/server/api/src/services/nodes/node-ws-handler.ts` (identity stash, message entry, `handleNodeOpen` timeout arming, the `NodeWsDeps` seam for `nodeEncryptionKeys` + `setEncryptPublicKey` repo handle)
- Modify: `apps/server/api/src/services/nodes/__tests__/node-ws-handler.test.ts`

**Interfaces:**
- Consumes: Task 7 (`beginLinkUpgrade`, `handleLinkFrame`), Task 6 (`NodeConnection.link`).
- Produces: every inbound node frame now routes through `handleLinkFrame` FIRST — including for the legacy row (which forwards to the existing parse path). After `established`: set `conn.link` on the registry record (so `sendCommand` seals) — and the registry record already exists at this point (attach happens at `open`); the established callback sets `link` on `ws.data.nodeConn`.

- [ ] **Step 1: failing tests at this layer** — (a) handshake row: a full kx→binding sequence over the REAL `handleNodeMessage` entry (fake sockets carrying text and Buffer frames) reaches `ready` handling only after establishment; (b) a `ready` as first frame on a handshake row closes 4410 BEFORE `parseNodeEvent`/`applyReady` runs (the existing test that asserts identity persists before the gates must still pass — classification uses the upgrade-stashed row facts, no second query, so persistence is untouched); (c) legacy row + register frame handled and socket closed after register-ok; (d) legacy row + today's plaintext frames still flow to the existing gates (the full held-path suite for below-floor/protocol mismatch stays green — it's the same code, now reached via `forwarded`).
- [ ] **Step 2: implement** — `authenticateNodeUpgrade`: after the `node` row is in hand (line ~238), stash `linkMode` + `encryptPublicKey` on the returned identity. `handleNodeMessage`: after the size cap, call `handleLinkFrame`; on `{close}` → `ws.close(code, reason)` + return; on `{consumed}` → return (register/kx done, socket closed by the machine); on `{forwarded}` → parse the forwarded string through the EXISTING rest of the function (`parseNodeEvent` onward untouched — that's the spec §4.5 promise); on `established` set the session on the connection record and continue. `handleNodeOpen`: arm the handshake timeout only for mode "handshake" sockets.
- [ ] **Step 3: run the suite; the WHOLE existing held/gates/supersede/disconnect body of tests must stay green** — this task may not change any downstream behavior, only pre-classify.
- [ ] **Step 4: gates + commit** `feat(server): classify every node socket through the link handshake before frames`

---

## Task 9: The agent's handshake — `link-crypto.ts` + `runConnection`

**Files:**
- Create: `apps/node/agent/src/link-crypto.ts`
- Create: `apps/node/agent/src/__tests__/link-crypto.test.ts`
- Modify: `apps/node/agent/src/daemon.ts` (`runConnection` open-listener sequence; `admitFrame` handshake interception; `send` seals once established; heartbeat/inventory/acceptedTimer arm AFTER established; `probeOnline` stays open-only)
- Test: `apps/node/agent/src/__tests__/daemon.test.ts` (fake plane speaks the handshake)

**Interfaces:**
- Consumes: Task 1 (`createClientSession`, frame validators), Task 4 (config fields), Task 6 (binary `WsLike`/`admitFrame`).
- Produces: an agent that (a) with `encryptKeyPair` + `controlEncryptPublicKey` configured → kx immediately on open, binding after the server's kx reply, `ready`/everything else only after the ack; (b) with NEITHER (legacy config, new binary — spec §5's ordered reality) → `{t:"register", pub: <fresh static pub — generated at first register attempt and saved via updateConfig>}`, await `{t:"register-ok", controlEncryptPublicKey}` → save pin + keypair → close and reconnect (the backoff loop redials within its cap); (c) handshake refusal (4410) → relay the reason to its own log, reconnect on the existing ladder (NOT terminal — unlike 4409/4406, and `daemon.ts`'s close-code terminal list stays as-is).

**The sequence, exactly (spec §4 — the mirror of Task 7's machine):**
open → generate fresh kx ephemeral; send text `{t:"kx", eph, pub: encryptKeyPair.publicKey}` (the `pub` claim is the long-term pair from config — identity, not derivation input); on the server's text `{t:"kx", eph}` reply: `createClientSessionWithEphemeral({ serverStaticPublicKey: config.controlEncryptPublicKey, ephemeral: <the pair generated at open> })`; send `sealFrame(JSON.stringify(binding))` with `{nodeId, nodeKey: config.nodeKey, protocolVersion: 14}`; await `openFrame` of the server's first bytes → `{"t":"ok"}`; established. If the first inbound can't be decrypted-or-read as the ack → the pinned server static was wrong → close 4410. **Ready ordering**: the existing comment at `daemon.ts:798-804` ("the send lands in the same turn the open event fires") becomes the established path's comment — handshake frames are the new first turn. The per-connection `frameChain`/`seqTracker` reset stays at connect; handshake frames BYPASS `frameChain` (they're not commands).

- [ ] **Step 1: `link-crypto.ts` failing unit tests** — client state machine driven by injected fake sockets: kx emitted on open with a fresh eph; binding sent only after the server's kx; ack failure → 4410 close; the register branch: no keys → register text frame, register-ok → `updateConfig` persists BOTH the keypair and the pin (Review Focus #5's write path), then close-for-reconnect; a `register-ok` on a config that ALREADY has keys (server answered unexpectedly) → ignore/close 4410, never clobber.
- [ ] **Step 2: implement `link-crypto.ts`** — a `LinkNegotiator` class-ish module (or functions + closure state) that `runConnection` instantiates per socket; it owns: ephemeral generation, `sendHandshake(ws)`, `onTextFrame(ws, text): "consumed" | "forward"`, `onBytesFrame(ws, bytes): string | null` (decrypt for the message loop), `established(): boolean`, `session(): LinkSession | undefined`. Keep `daemon.ts`'s listener bodies thin: call into the negotiator.
- [ ] **Step 3: `daemon.ts` integration + its tests** — extend `startPlane()`: an optional plane-mode where the fake server answers the handshake (kx reply derived against the pinned key, binding check, sealed ack — the test can import `createServerSession` from the protocol subpath directly). Test cases: (a) full encrypted attach → `ready` → command → result over REAL bytes both directions (Review: the round trip); (b) handshake refused (plane sends 4410) → agent logs reason, reconnects (backoff with `rand: () => 0` → immediate-ish), does NOT exit 1; (c) legacy-register: `startDaemon` with a config lacking both fields → register on first connect, config.json has them after, second connect handshakes; (d) plaintext `ready` never emitted before established — the fake plane asserts the first thing on its socket is `kx`.
- [ ] **Step 4: run daemon suite green (including every PRE-encryption test — those fixtures gain the handshake by making `startPlane` default to handshake-capable; a test that only needs open/close semantics must not have to learn crypto)** — the negotiator is DI'd through `DaemonDeps` (`link?: false | {…}` seam or auto: config fields absent + plane silent → legacy hold path is unreachable for the agent; keep it simple: `startPlane` gets `handshake: true` by default).
- [ ] **Step 5: gates + commit** `feat(node): the agent handshakes the link before any frame (kx, binding, register self-heal)`

---

## Task 10: The plane's held path, rotation clearing, and `probe` honesty

**Files:**
- Modify: `apps/server/api/src/api/nodes/rotate-node-key.route.ts` (+ its test) — `setEncryptPublicKey(id, null)` beside the apikey flip (step 2), so a rotated node re-provisions its encryption identity through the same register self-heal (spec §5). The evicted-socket drain note extends: `disconnectNode` already closes held + live.
- Modify: `apps/server/api/src/api/nodes/node-view.ts` — the `held` row already carries `{reason, agentVersion}`; confirm no change needed for the legacy-hold case (reason stays `below-floor`/`protocol-mismatch` — the legacy hold is produced by the EXISTING gates on forwarded plaintext `ready`, so the UI already renders it). Add nothing.
- Confirm `apps/node/agent/src/status --probe` / `probeOnline`: dials with the bearer, sends NOTHING — on a handshake row the server's handshake-timeout closes 4410 after `HANDSHAKE_TIMEOUT_MS`; the probe's answer ("dial reached the plane") is still true and still honest. A one-line comment at `probeOnline` records that its open-without-handshake shape is deliberately compatible with the handshake-required refusal. Test: an integration case that `probeOnline` against a handshake-mode fake records a connected-then-4410 close as success.
- Held-path regression lock (spec §5 "held update path unregressed"): an existing-style test — legacy v13 agent (plaintext `ready`, below floor) gets held, receives a plaintext `update` command over the held socket (its `sendCommand` path has no `link`), answers, completes.

- [ ] **Step 1: write the rotate + held-update tests, run red.**
- [ ] **Step 2: implement + green.**
- [ ] **Step 3: gates + commit** `fix(server): key rotation re-provisions the link identity; probe and held-update paths pinned`

---

## Task 11: End-to-end proof — real WS pair and the compiled binary

**Files:**
- Create: `apps/server/api/src/services/nodes/__tests__/link-handshake.integration.test.ts`
- Test-only helpers may extend `node-ws-integration.test.ts`'s `startPlane` pattern.

- [ ] **Step 1: the real-socket round trip** — the full lifecycle over `Bun.serve`-backed real WebSockets AND real `@internal/subshell-protocol/node-link-crypto` on both ends: authed upgrade (bearer) → agent kx → server kx reply → binding → ok → `ready` (row goes online) → a real `sendCommand` (via the scripted-node answer pattern, envelope sealed) → `result` settled → a pane-byte `output` relay frame both directions (server→agent command `input`, agent→server `output`). Assert the WIRE: every frame after the kx exchange is binary (the test client records raw message types), zero JSON text.
- [ ] **Step 2: the negative matrix on the real pair** — wrong pinned server static (agent derives, binding ack undecryptable) → 4410, never reaches `ready`; wrong pin (row pub ≠ agent's actual static) → 4410; **the replay** (Review Focus #2): capture a legitimate handshake + first frames from connect #1, replay them verbatim onto fresh connect #2 (different bearer ephemeral on the server's side) → rejected, and the replayed binding's `jti`-free payload touches no row; oversized ciphertext → 1009 per the existing cap; one flipped byte mid-stream → 4410 (Review Focus #3), the socket NOT half-resumed.
- [ ] **Step 3: the cutover matrix** (spec §7) as four cases: registered row refuses plaintext (4410); legacy row holds (below-floor reason); register self-heal completes and the NEXT connect is encrypted; `key_rotate` clears and re-provisions via the same path.
- [ ] **Step 4: the compiled-binary proof** (the spec's whole library bet rests on `bun build --compile` bundling the WASM) — `cd apps/node/agent && bun run compile` then `./dist/subshell version` (exercises the module graph at import; the handshake module isn't imported at version, so add: the compiled binary's `run` path imports `link-crypto.ts` — assert `bun run compile` succeeds AND a `bun repl`-style smoke: `./dist/subshell status --json` still answers, plus the daemon compiled path covered by `test:cli`'s existing node scenarios re-run). `bun run test:cli` runs on this host only if the per-user server-install refusal permits (AGENTS.md host fact); otherwise record its skip as an explicit operator-facing note in the PR.
- [ ] **Step 5: perf sanity (spec §7)** — a test measuring a 1000-frame secretstream round trip through a local socket stays under the existing latency envelope used by the Wave D budgets (assert generously: no regression budget, just a loud number in the test output + a loose bound like `< 2s` for 1000 small frames).
- [ ] **Step 6: commit** `test(server,node): the encrypted link — full round trip, cutover matrix, negatives, compiled binary`

---

## Task 12: Documentation aftercare + changesets (spec §8)

**Files:**
- Modify: `docs/security.md` — §1's "not defended against network-level attackers" narrows to the honest remainder (the out-list: browser↔server, downloads/install one-liners, the loopback dashboard); §4's "signing proves … never confidentiality" gains the link-encryption rule beside it (signing STILL proves authenticity independently — §9's non-goal stays: one bug is not fatal to the other); §6 node-link bullets rewritten for handshake/4410/register; §12's node-link prerequisite marked satisfied.
- Modify: `.claude/rules/security-context.md` — the Nodes section's signing bullet and handshake doctrine, rules-to-code-by form, §-pointers only.
- Modify: `docs/security-overview.md` — "Machines that run your agents" upgrades to always-encrypted on the node link; shortfall 5 (trusted-network) narrows: name what STILL needs TLS (the browser link) rather than deleting the honest sentence.
- Modify: `apps/docs` — `nodes/add-node.mdx`, `nodes/managing-a-node.mdx` one-liners; reference pages for the new `config.json` fields (`encryptKeyPair`, `controlEncryptPublicKey`) + `node-encryption.json` (rotation = every pin breaks, same warning the signing key carries).
- Create: `.changeset/node-link-encryption.md` — `"@internal/server": minor` + `"@internal/node": minor` (spec §8; the Global Constraints block explains why this minor is not the version-only kind `versions.ts` warns about). NEVER a changeset for an ignored package (`AGENTS.md`).
- Modify: `docs/superpowers/specs/2026-09-24-node-link-encryption-design.md` — a one-line footer naming the close-code reality and the register-on-next-connect refinement (spec §5's ordered reality was implemented as register→close→reconnect; if the implementation deviated anywhere from the spec's prose, the footer records it — the spec is the vision, the code is the truth).

- [ ] **Step 1: docs edits; grep-sweep** for stale claims: `grep -n "network-level attackers" docs/security.md`, `grep -rn "never confidentiality" docs .claude`, the overview's node bullets — every surviving sentence must be the narrowed one.
- [ ] **Step 2: changeset file; `bunx changeset status`** parses it.
- [ ] **Step 3: whole-tree gates one last time** — `bun run verify-types && bun run lint:check && bun run lint:design && bun run test && bunx turbo build` with pinned exit codes (`.claude/rules/verification.md`; pipe-swallowed exit codes are a known trap on this project).
- [ ] **Step 4: commit** `docs(security): the node link is encrypted — threat model, rules, public page, reference`

---

## Sequencing notes for the executor

- Tasks 1→2→3→4→5→6→7→8→9→10→11→12, strictly. 6 before 7/8 (plumbing before policy), 8 before 9 (the server accepts before the agent dials — so the server can be deployed without stranding nodes, since legacy rows keep working until each node updates: the spec's §5 ordering), 11 after both ends exist.
- **Deploy order is server first** (spec §4's comment in `node-frames.ts`): every intermediate state is survivable — new server + old nodes = held-updatable; old server + new nodes = the register frame arrives at a parser whose `default:` arm answers `{type:"error", code:"verify"}` (harmless, the agent retries per backoff — spec §5 says the new agent against an old server reconnects plaintext; pin this exact behavior as a test in Task 9's legacy branch, asserting the agent's register attempt failing leaves the socket usable… actually: against a PRE-14 server the register text frame is answered an error and the agent's next backoff attempt does the same forever. Spec §5 accepted this ("the register frame simply 404s… and the agent reconnects plaintext against a pre-bump server") — to honor it the agent needs a plaintext fallback ONLY against pre-14 servers, and there is no reliable way to tell "pre-14 server" from "broken encryption" from the client side. DECISION (spec §6 doctrine: fail closed): a v14 agent against a server that rejects its handshake keeps retrying encrypted; the operator updates the server. Record this in Task 9's comment and in the spec footer (Task 12 step 4) as the one place the implementation is stricter than the spec's prose — the "reconnects plaintext" path is NOT built.)
- The protocol package changes (1, 3) need `bunx turbo build` before dependent apps' tests trust them (verification.md).
