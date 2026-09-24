/**
 * The agent side of the `/ws/node` link handshake — spec 2026-09-24 §4/§5.
 *
 * One instance per socket, created by `runConnection` before it dials, and
 * the ONLY thing that touches the wire until the link is established. The
 * daemon's message listener routes every admitted frame here first: text and
 * bytes before establishment belong to this module (ack, register-ok, or a
 * 4410 refusal), and bytes after it are opened here and handed on as
 * plaintext for the existing command loop. Handshake frames are not commands
 * and never join the daemon's `frameChain`/`seqTracker` machinery.
 *
 * **The client sequence has NO server `kx` reply (ruling R6).** `crypto_kx`
 * is a single DH and the node already holds the server's pinned static
 * (`controlEncryptPublicKey`, from enroll or §5's `register-ok`), so the
 * node derives its side the moment the socket opens and pushes
 * `[kx-text, sealed-binding]` back-to-back with NOTHING inbound. The server's
 * first bytes are the sealed `{t:"ok"}`; opening it is what makes the link
 * established. A first inbound that cannot be opened means the pinned server
 * key is wrong — close 4410 and let the backoff loop redial.
 *
 * **§6 is symmetric here:** once classified, this socket never runs on
 * plaintext. Undecryptable ciphertext on an established link closes 4410 —
 * the secretstream is ratcheted, and resyncing it on attacker-chosen bytes is
 * not a recovery. (Unlike the byte-size guards, which `admitFrame` runs
 * before any of this.)
 *
 * **§5 is the self-heal:** a config with NEITHER field registers its long-term
 * static and waits for `register-ok`. The keypair is generated once and
 * PERSISTED BEFORE THE REGISTER FRAME IS SENT — the plane pins the claim on
 * arrival, so a node that minted a fresh pair per reconnect would eventually
 * handshake against a pin it no longer holds. A lost `register-ok` therefore
 * resumes with the SAME static (pair on disk, pin absent = continuation);
 * only the other half-state (pin without pair) is unrepairable by definition
 * — nothing local can derive with a missing private half — so it logs and
 * closes. After `register-ok` lands the socket closes NORMALLY (ruling R7):
 * the next dial is handshake mode. **R11 as narrowed by ruling R12b**
 * extends the entry to that continuation: a 4411 (`NODE_CLOSE_REPAIR_REQUIRED`
 * — the plane's re-pair signal, emitted by R10 when key rotation left the
 * row pin-less while this config still holds both link fields) BEFORE
 * establishment drops the CONTROL PIN from the config via `onClosed`, so the
 * next `begin()` registers the SAME static instead of re-refusing forever.
 * A generic 4410 does NOT drop it: the plane also closes pre-establishment
 * sockets with 4410 for its 10-second handshake deadline, and clearing the
 * pin THERE would send the redial to register against the STILL-PINNED row —
 * a network blip permanently bricking a healthy node (final review I-1). The
 * pair is never dropped here.
 *
 * 4410 (`NODE_CLOSE_HANDSHAKE_REQUIRED`) and 4411 (`NODE_CLOSE_REPAIR_REQUIRED`)
 * are both NON-TERMINAL for this process — `runDaemon`'s close loop treats
 * either like an ordinary disconnect; unlike 4409/4406 nothing here exits.
 *
 * The crypto itself is entirely the protocol module's (`node-link-crypto`
 * subpath — libsodium's official kx + secretstream, nothing of ours); this
 * file is sequencing and policy only.
 */
import {
  NODE_CLOSE_HANDSHAKE_REQUIRED,
  NODE_CLOSE_REPAIR_REQUIRED,
  NODE_PROTOCOL_VERSION,
} from "@internal/subshell-protocol";
import {
  createClientSession,
  ensureSodium,
  generateLinkKeyPair,
  type LinkKeyPair,
  type LinkSession,
  parseLinkAck,
  parseRegisterOkFrame,
} from "@internal/subshell-protocol/node-link-crypto";
import type { NodeConfig } from "./config.js";

/** The socket surface the negotiator drives; `WsLike` satisfies it structurally. */
export interface LinkWs {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

/**
 * Wrap sealed bytes as a `Buffer` VIEW for the send — the `wsBinaryPayload` /
 * `binaryPayload` lesson (ledger 2026-09-24): a raw `Uint8Array` handed to
 * some send paths gets text-framed, which would ship ciphertext as JSON and
 * every later frame desyncs. A view, not a copy: seal output is fresh and
 * never mutated afterwards.
 */
export function binaryPayload(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Everything the negotiator reaches outside itself. All injected, so tests drive it bare. */
export interface LinkNegotiatorArgs {
  /** The live daemon config. The negotiator never writes it; {@link persist} does, and the daemon mirrors the patch onto this object so the NEXT dial reads the fresh fields. */
  config: NodeConfig;
  /** One-line logger (the daemon's `log`). */
  log(message: string): void;
  /**
   * Persist named config keys (the daemon wires this to `updateConfig` + a
   * write-back onto {@link config}). The register flow's write path: the
   * keypair lands BEFORE the register frame, the pin lands on `register-ok`.
   */
  persist(patch: Partial<NodeConfig>): Promise<void>;
  /** Fires EXACTLY once, when the sealed ack opened: the daemon sends `ready` and arms its timers here. */
  onEstablished(): void;
}

/** The per-socket handle `daemon.ts` talks to. */
export interface LinkNegotiator {
  /**
   * Emit this connection's opening frames. Resolves once they are on the wire
   * (or after the refusal close) — production fire-and-forgets it, tests await
   * it to pin the exact outbound sequence.
   */
  begin(ws: LinkWs): Promise<void>;
  /** An admitted TEXT frame. Consumed here, or refused with 4410 — never forwarded while the link is not established. */
  onTextFrame(ws: LinkWs, text: string): void;
  /**
   * An admitted BYTES frame. Returns the decrypted JSON for the command loop
   * (established links only); `null` means the negotiator consumed it (the
   * ack), dropped it, or closed the socket.
   */
  onBytesFrame(ws: LinkWs, bytes: Uint8Array): string | null;
  /**
   * The socket CLOSED with `code` and the plane's `reason` — the daemon's
   * `finish()` feeds every close here, exactly once per socket (idempotent
   * even if called twice). The DECISION reads the code — `reason` is never
   * matched against prose (the repo's `detail`-equality doctrine); it rides
   * into the operator's log line verbatim.
   *
   * **R11 as narrowed by ruling R12b (spec 2026-09-24 §5):** a 4411
   * (`NODE_CLOSE_REPAIR_REQUIRED`) the PLANE sends before this socket ever
   * established means the row no longer pairs with the pinned identity — key
   * rotation clears `encrypt_public_key` server-side, and the R10 rule then
   * refuses this config's handshake-mode `kx` by name WITH that code. The
   * answer is to drop the CONTROL PIN and nothing else: the next `begin()`
   * sees pair-without-pin, which §5's continuation rule already reads as
   * "register with what is stored", so the node re-presents the SAME static
   * and the row re-pairs. Every other close keeps the config byte-identical
   * — the GENERIC 4410 foremost, which is NOT the post-rotation state: the
   * plane emits it for the 10-second handshake deadline and every other
   * handshake refusal on a row that is usually still pinned, and dropping
   * the pin THERE would brick a healthy node on a transient stall (the
   * redial's register against the still-pinned row is refused forever —
   * final review I-1). Above all a stream that ESTABLISHED and died redials
   * fully provisioned exactly as before (RF#3's byte-flip recovery and the
   * never-resync doctrine depend on it).
   */
  onClosed(code: number, reason: string): void;
  established(): boolean;
  /** The session to seal outbound frames with — only meaningful once {@link established} is true. */
  session(): LinkSession | undefined;
}

/** Where the socket stands. `dead` = a refusal close is in flight; later frames are ignored. */
type Phase =
  | "idle"
  | "awaiting-ack"
  | "awaiting-register-ok"
  | "persisting-pin"
  | "provisioned"
  | "established"
  | "dead";

/** Decode a base64 key and enforce its 32 bytes; junk is undefined (never a throw at call sites). */
async function decode32(value: string): Promise<Uint8Array | undefined> {
  try {
    const s = await ensureSodium();
    const decoded = s.from_base64(value);
    return decoded.length === 32 ? decoded : undefined;
  } catch {
    return undefined;
  }
}

/** Soft JSON.parse for inbound text: unparseable is undefined, never a throw. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Build the per-connection negotiator. The mode is decided from `config` at
 * `begin()` time: BOTH link fields → handshake; NEITHER → §5's register;
 * exactly one → §5's unrecoverable half-state. (A pair with no pin is NOT the
 * half-state here — it is a register in progress, and it continues with the
 * SAME static; see the module header.)
 */
export function createLinkNegotiator(args: LinkNegotiatorArgs): LinkNegotiator {
  let phase: Phase = "idle";
  let session: LinkSession | undefined;
  /** Set at `begin()` classification. Drives the bytes-drop-vs-refuse split below. */
  let mode: "handshake" | "register" | "incomplete" | undefined;
  /** R11: this socket's own `refuse()` fired — a close it caused clears nothing. */
  let selfRefused = false;
  /** R11: the sealed ack opened here — a stream that PROVED the pair redials provisioned, whatever closes it. */
  let reachedEstablished = false;
  /** R11: `onClosed` decides once per socket; later calls are inert (the daemon's finish is settled-once; this is the belt). */
  let closedDecided = false;

  const refuse = (ws: LinkWs, reason: string): void => {
    if (phase === "dead") return;
    phase = "dead";
    selfRefused = true; // R11: the 4410 finish() will see came from HERE, not the plane
    args.log(`link handshake refused: ${reason}`);
    try {
      ws.close(NODE_CLOSE_HANDSHAKE_REQUIRED, reason);
    } catch {
      /* already gone — the daemon's close path proceeds regardless */
    }
  };

  /** Handshake mode (spec §4): derive immediately, then [kx-text, sealed binding], no inbound first. */
  const beginHandshake = async (ws: LinkWs, pair: LinkKeyPair, serverPub: string): Promise<void> => {
    const { config } = args;
    let derived: { session: LinkSession; ephemeralPublicKey: string };
    try {
      // A junk pinned key throws here (decodeKey) — that is the loud local failure.
      derived = await createClientSession({ serverStaticPublicKey: serverPub });
    } catch (err) {
      refuse(
        ws,
        `handshake failed: the pinned control encrypt key is unusable (${err instanceof Error ? err.message : String(err)})`,
      );
      return;
    }
    if (phase === "dead") return; // refused while deriving (e.g. ciphertext landed first) — send nothing
    session = derived.session;
    phase = "awaiting-ack";
    // The claim is the LONG-TERM pair from config — identity, never derivation
    // input (spec §4 step 2; the server compares it against the row's pin).
    ws.send(JSON.stringify({ t: "kx", eph: derived.ephemeralPublicKey, pub: pair.publicKey }));
    // R6: the binding follows in the SAME turn, sealed — the server answers nothing
    // to kx, so waiting for a reply would wait forever. The FIRST seal carries the
    // 24-byte secretstream header; the server's pull state is initialized by it.
    ws.send(
      binaryPayload(
        derived.session.sealFrame(
          JSON.stringify({
            nodeId: config.nodeId,
            nodeKey: config.nodeKey,
            protocolVersion: NODE_PROTOCOL_VERSION,
          }),
        ),
      ),
    );
  };

  /** Legacy mode (spec §5): the keypair is stored BEFORE the claim is sent. */
  const beginRegister = async (ws: LinkWs): Promise<void> => {
    const { config } = args;
    let pair = config.encryptKeyPair;
    try {
      if (!pair) {
        pair = await generateLinkKeyPair();
        // Persist BEFORE sending: the plane pins this exact claim on arrival,
        // and a mint-per-attempt would eventually handshake against a pin the
        // node no longer holds. `persist` also mirrors it onto the live config.
        await args.persist({ encryptKeyPair: pair });
      }
    } catch (err) {
      refuse(
        ws,
        `link registration failed: the node's link keypair could not be stored (${err instanceof Error ? err.message : String(err)})`,
      );
      return;
    }
    if (phase === "dead") return; // refused during the store — send nothing
    phase = "awaiting-register-ok";
    ws.send(JSON.stringify({ t: "register", pub: pair.publicKey }));
  };

  /** The legacy plane's answer: store the pin, then R7's NORMAL close for the encrypted redial. */
  const acceptRegisterOk = (ws: LinkWs, pin: string): void => {
    phase = "persisting-pin";
    void decode32(pin).then(async (key) => {
      if (!key) {
        refuse(ws, "register-ok named a control encrypt key that is not a 32-byte X25519 key");
        return;
      }
      try {
        await args.persist({ controlEncryptPublicKey: pin });
      } catch (err) {
        refuse(ws, `the register-ok pin could not be stored (${err instanceof Error ? err.message : String(err)})`);
        return;
      }
      phase = "provisioned";
      args.log("link provisioned by registration; reconnecting encrypted");
      try {
        ws.close(); // normal close (R7) — NOT a 4410: the backoff redial is the success path
      } catch {
        /* already gone */
      }
    });
  };

  return {
    begin: async (ws: LinkWs): Promise<void> => {
      const { config } = args;
      if (config.encryptKeyPair && config.controlEncryptPublicKey) {
        mode = "handshake";
        await beginHandshake(ws, config.encryptKeyPair, config.controlEncryptPublicKey);
        return;
      }
      if (!config.controlEncryptPublicKey) {
        // No pin. Whether the pair is already on disk is the pair's own
        // question: absent means mint-and-store-first, present means CONTINUE
        // the registration with the SAME static — the plane may already have
        // pinned it from a lost ack, and a fresh mint could never handshake
        // against the pin it stops matching.
        mode = "register";
        await beginRegister(ws);
        return;
      }
      // Pin without the private half: nothing local can derive. Repair is a
      // config edit or a re-enroll — the close just makes the reason visible on
      // every retry instead of a silent 10-second handshake timeout on the plane.
      mode = "incomplete";
      refuse(
        ws,
        "link identity incomplete: the control-plane pin is set but the node's keypair is not (repair config.json or re-enroll)",
      );
    },

    onTextFrame: (ws: LinkWs, text: string): void => {
      if (phase === "dead" || phase === "provisioned") return;
      if (phase === "established") {
        refuse(ws, "plaintext on an established link");
        return;
      }
      if (phase === "awaiting-register-ok") {
        const ok = parseRegisterOkFrame(parseJson(text));
        if (ok) {
          acceptRegisterOk(ws, ok.controlEncryptPublicKey);
          return;
        }
        refuse(ws, "the only frame a registering node accepts is register-ok");
        return;
      }
      // Handshake mode before the ack (idle mid-derive, awaiting-ack, persisting):
      // the server answers kx in SILENCE (R6) — any plaintext here is the wrong
      // kind at the wrong phase, including a register-ok on a provisioned config,
      // which must NEVER touch the stored keys.
      refuse(ws, "plaintext before the link was established");
    },

    onBytesFrame: (ws: LinkWs, bytes: Uint8Array): string | null => {
      if (phase === "dead" || phase === "provisioned" || phase === "persisting-pin") return null;
      if (phase === "established") {
        const plaintext = session?.openFrame(bytes);
        if (plaintext === null || plaintext === undefined) {
          refuse(ws, "ciphertext undecryptable — the link stream is dead, never resynced");
          return null;
        }
        return plaintext;
      }
      if (phase === "awaiting-ack") {
        const plaintext = session?.openFrame(bytes);
        if (plaintext === null || plaintext === undefined) {
          refuse(ws, "the server's first frame did not open — the pinned control key is wrong");
          return null;
        }
        if (!parseLinkAck(parseJson(plaintext))) {
          refuse(ws, 'the server\'s first frame was not the {t:"ok"} ack');
          return null;
        }
        phase = "established";
        reachedEstablished = true; // R11: from here on, NO close may clear the pin — the pair is proven live
        args.onEstablished();
        return null;
      }
      if (mode === "register" || mode === "incomplete") {
        // A socket with no stream to open: drop with the old ignore-don't-close
        // posture — the server's legacy path drops binary the same way, and the
        // daemon must not close over a stray byte frame it cannot even attribute.
        args.log("ignored binary frame (no encrypted link)");
        return null;
      }
      // Handshake mode, still deriving: ciphertext cannot be opened and, per §6,
      // is not merely noise — it is the wrong kind at the wrong phase.
      refuse(ws, "ciphertext before the kx was sent");
      return null;
    },

    onClosed: (code: number, reason: string): void => {
      if (closedDecided) return; // one decision per socket
      closedDecided = true;
      // R11 as narrowed by R12b — the drop needs ALL four gates, else the
      // config stays byte-identical: the plane said 4411 (REPAIR_REQUIRED — the
      // re-pair signal R10 emits, and the ONLY code that means "your pin is
      // stale"); WE did not cause the close; this socket dialed in handshake
      // mode; and it NEVER established. A generic 4410 is DELIBERATELY not the
      // trigger — it is what the plane's 10-second handshake deadline emits on a
      // row that is usually still PINNED, and clearing the pin there would send
      // the redial to register against a still-pinned row (refused forever) —
      // the final-review I-1 bricking this narrowing closes.
      if (code === NODE_CLOSE_REPAIR_REQUIRED && !selfRefused && mode === "handshake" && !reachedEstablished) {
        // The reason is relayed verbatim, never matched against — the code
        // decided, this line is for the operator reading the node's log.
        const why = reason ? ` (${reason})` : "";
        args.log(
          `plane required re-pair before establishment (4411)${why} — dropping the pinned control key only, so the next connect re-registers this node's SAME static (R11/R12b)`,
        );
        // The PIN only — never the pair. §5's continuation rule (begin():
        // pair-without-pin) turns the redial into a register of what is already
        // stored; the daemon's persist mirrors onto the live config and gates
        // the redial on the write, so no dial can race past this. A failed drop
        // stays LOUD (config.json is the identity's home).
        void args
          .persist({ controlEncryptPublicKey: undefined })
          .catch((err: unknown) =>
            args.log(
              `could not drop the control pin after a re-pair refusal (4411, R11/R12b): ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
        return;
      }
      // The crash-window's AGENT half (§5's register self-heal aimed at a row
      // that STILL pins this node's identity): a generic 4410 closes a socket
      // that dialed in REGISTER mode and never established. 4411 does NOT fire
      // here — a register is not the re-pair signal — so NOTHING is dropped
      // (config byte-identical), but the loop is dead-on-arrival: the node has
      // no control pin to lose and the row will never take its register. The log
      // names the ONLY remedy so the spin reads as a known failure, not a mere
      // "offline"; the docs record it as the state 4411 deliberately does NOT
      // heal (that would need the declined plaintext-register-on-v14 arm).
      if (code === NODE_CLOSE_HANDSHAKE_REQUIRED && !selfRefused && mode === "register" && !reachedEstablished) {
        const why = reason ? ` (${reason})` : "";
        args.log(
          `register refused by a row that still pins this node (4410)${why} — this node's control pin is already gone, so a re-pair (4411) cannot heal it; the remedy is manual: rotate the node key on the plane (that clears the row's pin), then install the new key with \`subshell configure --key <new>\` and restart`,
        );
        return;
      }
      // Every other close keeps the config byte-identical, no persist: a generic
      // 4410 on a handshake-mode socket that never established (THE DEADLINE —
      // the I-1 case this gate defends: redial fully provisioned, fresh eph, the
      // pin matches, heal); our OWN refusal; a stream that established and later
      // died (RF#3's "4410-and-redial, never resync" recovery); 1006/1012; or a
      // 4411 on a socket that already established (the pair is proven live).
    },

    established: (): boolean => phase === "established",
    session: (): LinkSession | undefined => (phase === "established" ? session : undefined),
  };
}
