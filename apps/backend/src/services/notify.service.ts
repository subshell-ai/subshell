import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Kysely } from "kysely";
import webpush from "web-push";
import { SUBSHELL_SERVER_DATA_DIR } from "@/constants.js";
import { db } from "@/db/index.js";
import { DeviceTokensRepository } from "@/db/repositories/device-tokens.repository.js";
import { NotificationsRepository } from "@/db/repositories/notifications.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UserMetaRepository } from "@/db/repositories/user-meta.repository.js";
import type { Database } from "@/db/types/index.js";
import type { SubshellTable } from "@/db/types/subshells.db-types.js";
import {
  badgeCount,
  buildExpoMessages,
  createExpoPushSender,
  type ExpoPushSender,
  isUnregisteredTicket,
  looksLikeExpoToken,
} from "@/services/expo-push.js";
import { isNodeOffline } from "@/services/nodes/node-registry.js";
import { logger } from "@/utils/logger.js";

/**
 * What happened to a subshell. The wire contract with the hooks and the
 * watcher. `crashed_final` is backend-internal (the reconcile sweep only):
 * it marks a crash whose auto-restart backoff is exhausted, so the copy must
 * not promise a restart. It is deliberately NOT part of the `/attention`
 * route's body union — hooks can only report `turn_complete`/`needs_attention`.
 */
export type NotifyKind = "turn_complete" | "needs_attention" | "exited" | "crashed" | "crashed_final";

const BODY: Record<NotifyKind, string> = {
  turn_complete: "Done — waiting for you",
  needs_attention: "Needs your approval",
  exited: "Subshell exited",
  crashed: "Crashed — auto-restarting",
  crashed_final: "Crashed",
};

/**
 * The push payload the service worker turns into an OS notification. `tag`
 * is the subshell id so a newer event replaces that subshell's older
 * notification instead of stacking. The URL is relative (same-origin), the
 * SW resolves it against its own scope.
 */
export function buildNotificationPayload(row: { id: string; name: string }, kind: NotifyKind) {
  return { title: row.name, body: BODY[kind], url: `/subshells/${row.id}`, tag: row.id };
}

/**
 * Minimal seam over web-push so tests inject a fake.
 *
 * CONTRACT — subscription pruning relies on HOW this fails: the sender must
 * REJECT with an error carrying a numeric `statusCode` of 403, 404 or 410
 * for a permanently-unusable endpoint (404/410 = gone; 403 = the gateway
 * rejects our VAPID JWT for this binding — Apple's BadJwtToken after a
 * server key rotation; that is exactly what `web-push` does);
 * `notifySubshell` deletes the subscription row on those codes. A sender that
 * instead RESOLVES with `{ statusCode: ... }` does NOT prune — the row is
 * kept as if the send had succeeded. Any other outcome (rejection with
 * another code, or a plain success) keeps the row: transient by contract.
 */
export type PushSender = (
  sub: { endpoint: string; p256dh: string; auth: string },
  payload: string,
) => Promise<{ statusCode: number }>;

/** VAPID key pair + subject (contact URI), exactly as persisted in `vapid.json`. */
type VapidPair = { publicKey: string; privateKey: string; subject: string };

export interface NotifyServiceDeps {
  subshells: Kysely<Database>;
  subs: NotificationsRepository;
  sender?: PushSender;
  /** Native-device transport; absent = pre-mobile behaviour (spec invariant 2). */
  devices?: DeviceTokensRepository;
  expoSender?: ExpoPushSender;
  /** Test escape hatch; production leaves it undefined and loads/generates VAPID from the data dir. */
  vapid?: VapidPair;
}

export function createNotifyService(deps: NotifyServiceDeps) {
  const send: PushSender =
    deps.sender ??
    senderOverride ??
    (async (sub, payload) => {
      // Only the real web-push path touches VAPID details, applied per send
      // (not once at boot): setVapidDetails validates the key material, so a
      // fake sender must never be reached by it.
      const { publicKey, privateKey, subject } = await keys();
      webpush.setVapidDetails(subject, publicKey, privateKey);
      return webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload,
        { TTL: 3600 },
      );
    });

  async function keys(): Promise<VapidPair> {
    if (deps.vapid) return deps.vapid;
    return loadOrGenerateVapid();
  }

  // Resolution order mirrors `send` above: explicit dep wins, then the test
  // override (which implies a singleton reset), then the production client.
  const expoSend: ExpoPushSender = deps.expoSender ?? expoSenderOverride ?? createExpoPushSender();
  // One repository per service — both transports read the same db handle.
  const subshellsRepo = new SubshellsRepository(deps.subshells);
  const userMetaRepo = new UserMetaRepository(deps.subshells);

  /**
   * Device fan-out (spec §Push): opaque messages built from ids and counts,
   * rows pruned only on the relay's DeviceNotRegistered verdict. A service
   * built without the device transport behaves exactly as it did before the
   * mobile app existed (invariant 2).
   */
  async function notifyDevices(row: SubshellTable, kind: NotifyKind): Promise<void> {
    if (!deps.devices) return;
    const enrolled = await deps.devices.listByUser(row.userId);
    if (enrolled.length === 0) return;
    // One pass partitions relay-usable rows from junk; the junk rows are ones
    // the relay can never use, so they go now rather than on every send.
    const live: typeof enrolled = [];
    const junk: typeof enrolled = [];
    for (const t of enrolled) (looksLikeExpoToken(t.token) ? live : junk).push(t);
    for (const dead of junk) {
      await deps.devices.deleteByToken(dead.token);
      logger.warn(`pruned invalid device token for user ${dead.userId}`);
    }
    if (live.length === 0) return;
    // F1: the badge count must ignore waiting rows whose node is
    // unreachable — the blessed predicate comes from the registry (importing
    // it from subshell-manager would cycle: subshell-manager already imports
    // this module).
    const counts = await subshellsRepo.countsByUser(row.userId, isNodeOffline);
    const badge = badgeCount(counts.waiting, kind, row.waitingSince);
    const messages = buildExpoMessages(
      live.map((t) => t.token),
      row.id,
      kind,
      badge,
    );
    try {
      const tickets = await expoSend(messages);
      // Tickets zip 1:1 with messages, in order (ExpoPushSender contract).
      for (let i = 0; i < tickets.length; i += 1) {
        const ticket = tickets[i];
        const token = messages[i]?.to;
        if (!ticket || !token) continue;
        if (isUnregisteredTicket(ticket)) {
          await deps.devices.deleteByToken(token); // the relay says the device is gone
        } else if (ticket.status === "error") {
          logger.warn(`expo push ticket error (kept): ${ticket.message}`); // e.g. MessageTooBig = our bug
        }
      }
    } catch (err) {
      // Transport exception is transient BY CONTRACT: every row survives.
      logger.withError(err).warn(`expo push send failed (kept) for ${live.length} device(s)`);
    }
  }

  return {
    async vapidPublicKey(): Promise<string> {
      return (await keys()).publicKey;
    },
    /**
     * Ring every one of the subshell OWNER's devices — web-push subscriptions
     * and native devices alike — but only if the subshell's bell is on. The
     * bell check is the SINGLE policy point above both transports (spec
     * §Push): flipping it takes effect on the next event with nothing to
     * invalidate. A dead web endpoint (403/404/410) or a DeviceNotRegistered
     * ticket prunes its row; every other failure keeps it (transient).
     */
    async notifySubshell(subshellId: string, kind: NotifyKind): Promise<void> {
      try {
        const row = await subshellsRepo.findById(subshellId);
        if (row?.notify !== 1) return;
        // Per-user master switch (spec 2026-08-31): off ⇒ total silence
        // regardless of any subshell bells. Read of user_meta only; a missing
        // row reads as enabled (getNotifyEnabled defaults to on).
        if (!(await userMetaRepo.getNotifyEnabled(row.userId))) return;
        // The transports are independent. Start the device fan-out NOW, before
        // the sequential web-push loop, so a phone never waits behind N HTTPS
        // round-trips to browser push gateways (review, efficiency #6).
        const deviceDelivery = notifyDevices(row, kind);
        const subs = await deps.subs.listByUser(row.userId);
        if (subs.length > 0) {
          const payload = JSON.stringify(buildNotificationPayload(row, kind));
          for (const sub of subs) {
            try {
              await send({ endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth }, payload);
            } catch (err) {
              const status = (err as { statusCode?: number }).statusCode;
              // 404/410 = the endpoint is gone. 403 = the gateway rejects our
              // VAPID JWT for this binding (Apple's BadJwtToken: the
              // subscription was made against a different server key — e.g.
              // after vapid.json rotation). Nothing we sign can ever heal it,
              // so it joins the prune set; the client re-subscribes on its
              // next enablePush (which now re-binds unconditionally).
              if (status === 403 || status === 404 || status === 410) {
                await deps.subs.deleteByEndpoint(sub.endpoint);
              } else {
                logger.withError(err).warn(`push send failed (kept): ${sub.endpoint.slice(0, 60)}…`);
              }
            }
          }
        }
        await deviceDelivery;
      } catch (err) {
        // Notifications must never break the caller (sweep / hook route).
        logger.withError(err).warn(`notifySubshell(${subshellId}, ${kind}) failed`);
      }
    },
  };
}

export type NotifyService = ReturnType<typeof createNotifyService>;

let singleton: NotifyService | null = null;
let senderOverride: PushSender | null = null;
let expoSenderOverride: ExpoPushSender | null = null;

/** The app-wide service (shared `db` + its own repositories + real senders). */
export function getNotifyService(): NotifyService {
  singleton ??= createNotifyService({
    // The typed app db is structurally the same Kysely<Database> the
    // repositories already take everywhere.
    subshells: db,
    subs: new NotificationsRepository(db),
    devices: new DeviceTokensRepository(db),
    // No explicit expoSender: the createExpoPushSender() fallback keeps
    // __setExpoSenderForTests working like its web-push sibling.
  });
  return singleton;
}

/**
 * @internal Test isolation: route the app-wide service through `sender`
 * instead of the real web-push sender. Resetting the singleton makes the
 * next `getNotifyService()` pick the override up.
 */
export function __setSenderForTests(sender: PushSender | null): void {
  senderOverride = sender;
  singleton = null;
}

/**
 * @internal Test isolation: route the device fan-out through `sender` instead
 * of the real Expo relay. Resetting the singleton makes the next
 * `getNotifyService()` pick the override up — same contract as
 * `__setSenderForTests`.
 */
export function __setExpoSenderForTests(sender: ExpoPushSender | null): void {
  expoSenderOverride = sender;
  singleton = null;
}

const VAPID_FILE = "vapid.json";

let cachedVapid: VapidPair | null = null;
let vapidDirOverride: string | null = null;

/** @internal Test isolation: read VAPID keys from `dir` instead of SUBSHELL_SERVER_DATA_DIR. */
export function __setVapidDirForTests(dir: string | null): void {
  vapidDirOverride = dir;
  cachedVapid = null;
}

/**
 * Load the instance's VAPID pair, generating and persisting it on first use.
 *
 * A stored file is only trusted when BOTH key fields are present non-empty
 * strings: JSON.parse succeeding says nothing about shape, and a truncated
 * or foreign file would otherwise serve `undefined` keys straight into
 * /config (a response-schema violation) and every send. A corrupt key file
 * is already unusable, so it is regenerated and overwritten in place.
 */
function loadOrGenerateVapid(): VapidPair {
  if (cachedVapid) return cachedVapid;
  const dir = vapidDirOverride ?? SUBSHELL_SERVER_DATA_DIR;
  const file = join(dir, VAPID_FILE);
  mkdirSync(dir, { recursive: true });
  let pair: VapidPair | null = null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<VapidPair>;
    if (
      typeof parsed.publicKey === "string" &&
      parsed.publicKey.length > 0 &&
      typeof parsed.privateKey === "string" &&
      parsed.privateKey.length > 0
    ) {
      pair = {
        publicKey: parsed.publicKey,
        privateKey: parsed.privateKey,
        subject: typeof parsed.subject === "string" && parsed.subject ? parsed.subject : "mailto:subshell@localhost",
      };
    }
  } catch {
    // Unreadable or unparseable — falls through to regeneration below.
  }
  if (!pair) {
    const g = webpush.generateVAPIDKeys();
    pair = { publicKey: g.publicKey, privateKey: g.privateKey, subject: "mailto:subshell@localhost" };
    writeFileSync(file, JSON.stringify(pair), { mode: 0o600 });
    logger.info(`generated VAPID keys → ${file}`);
  }
  cachedVapid = pair;
  return pair;
}
