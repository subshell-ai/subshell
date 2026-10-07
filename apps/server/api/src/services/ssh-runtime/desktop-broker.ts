import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { NodeCommandBody } from "@internal/subshell-protocol";
import { parseNodeCommandBody } from "@internal/subshell-protocol";
import { HttpError, UnauthorizedError } from "@/api/auth-guard.js";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { accountDisabled, accountPending } from "@/services/account-status.js";
import { backupPasswordChangeRequired } from "@/services/backup-admin-recovery.js";
import { NodeRpcError } from "@/services/nodes/node-rpc.js";
import { deliverSessionFrame, deliverSessionLost, markSessionsLostForNode } from "./session-registry.js";

const nodes = new NodesRepository(db);
const pairings = new Map<string, { id: string; owner: string; expires: number }>();
const links = new Map<string, DesktopLink>();
const MAX_FRAME = 1024 * 1024;
const MAX_PENDING = 32;
export const isDesktopBroker = (id: string): boolean => /^desktop:[0-9a-f-]{36}$/.test(id);
const digest = (token: string): string => createHash("sha256").update(token).digest("hex");
export type DesktopCommand = Extract<
  NodeCommandBody,
  {
    type: "ssh_discover_aliases" | "ssh_resolve_config" | "ssh_session_open" | "ssh_session_send" | "ssh_session_close";
  }
>;
export function parseDesktopCommand(value: unknown): DesktopCommand | null {
  const cmd = parseNodeCommandBody(value);
  if (
    !cmd ||
    ![
      "ssh_discover_aliases",
      "ssh_resolve_config",
      "ssh_session_open",
      "ssh_session_send",
      "ssh_session_close",
    ].includes(cmd.type)
  )
    return null;
  return cmd as DesktopCommand;
}

async function liveOwner(owner: string): Promise<boolean> {
  return (
    !!(await new UsersRepository(db).findByIdBasic(owner)) &&
    !(await accountDisabled(db, owner)) &&
    !(await accountPending(db, owner)) &&
    !(await backupPasswordChangeRequired(db, owner))
  );
}
export async function desktopOwnerLive(id: string, owner: string): Promise<boolean> {
  const row = await nodes.findById(id);
  return (
    isDesktopBroker(id) &&
    row?.kind === "runtime" &&
    row.ownerUserId === owner &&
    links.get(id)?.ready === true &&
    (await liveOwner(owner))
  );
}
export async function listDesktopBrokers(owner: string) {
  const rows = await db
    .selectFrom("nodes")
    .select(["id", "name"])
    .where("ownerUserId", "=", owner)
    .where("kind", "=", "runtime")
    .where("id", "like", "desktop:%")
    .execute();
  return { brokers: rows.map((row) => ({ ...row, online: links.has(row.id) })) };
}
export async function pairDesktopBroker(owner: string, body: { name: string; id?: string }) {
  const id = body.id ?? `desktop:${randomUUID()}`;
  if (!isDesktopBroker(id)) throw new HttpError(404, "Desktop broker not found.");
  const row = await nodes.findById(id);
  if (body.id && (row?.kind !== "runtime" || row.ownerUserId !== owner))
    throw new HttpError(404, "Desktop broker not found.");
  if (links.has(id)) throw new HttpError(409, "This desktop is already connected.");
  // A bounded owner set, including expired tokens, cannot exhaust this process.
  for (const [key, value] of pairings) if (value.expires <= Date.now() || value.id === id) pairings.delete(key);
  if ([...pairings.values()].filter((value) => value.owner === owner).length >= 8 || pairings.size >= 1024)
    throw new HttpError(409, "Too many pending desktop pairings.");
  if (!row) {
    const named = await db
      .selectFrom("nodes")
      .select("id")
      .where("ownerUserId", "=", owner)
      .where("name", "=", body.name)
      .executeTakeFirst();
    if (named)
      throw new HttpError(
        409,
        "This name is already in use. Pair again with the existing desktop, or choose a different name.",
      );
    const count = await db
      .selectFrom("nodes")
      .select("id")
      .where("ownerUserId", "=", owner)
      .where("id", "like", "desktop:%")
      .execute();
    if (count.length >= 16) throw new HttpError(409, "Too many desktop brokers.");
    try {
      await nodes.create({ id, ownerUserId: owner, name: body.name, kind: "runtime", status: "offline" });
    } catch (error) {
      // The preceding name check is helpful UX; this guards a simultaneous
      // add or node rename that wins the same database uniqueness constraint.
      if (error && typeof error === "object" && "code" in error && error.code === "SQLITE_CONSTRAINT_UNIQUE")
        throw new HttpError(
          409,
          "This name is already in use. Pair again with the existing desktop, or choose a different name.",
        );
      throw error;
    }
  }
  const pairingToken = `dsp_${randomBytes(32).toString("base64url")}`;
  const expires = Date.now() + 5 * 60_000;
  const pairingHash = digest(pairingToken);
  await db
    .updateTable("nodes")
    .set({ publicKey: `pair:${pairingHash}` })
    .where("id", "=", id)
    .execute();
  pairings.set(pairingHash, { id, owner, expires });
  return { id, name: row?.name ?? body.name, pairingToken, expiresAt: new Date(expires).toISOString() };
}
export async function revokeDesktopBroker(owner: string, id: string): Promise<void> {
  const row = await nodes.findById(id);
  if (!isDesktopBroker(id) || row?.ownerUserId !== owner || row.kind !== "runtime")
    throw new HttpError(404, "Desktop broker not found.");
  for (const [key, value] of pairings) if (value.id === id) pairings.delete(key);
  await db.updateTable("nodes").set({ publicKey: null, status: "offline" }).where("id", "=", id).execute();
  links.get(id)?.close();
}
export interface DesktopIdentity {
  id: string;
  owner: string;
  name: string;
  credential?: string;
  credentialHash: string;
}
export async function authenticateDesktopBroker(authorization: string | null): Promise<DesktopIdentity> {
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  const hash = digest(token);
  const pairing = pairings.get(hash);
  if (pairing) {
    pairings.delete(hash); // spend synchronously before any awaited authority check
    if (pairing.expires <= Date.now()) throw new UnauthorizedError();
    const row = await nodes.findById(pairing.id);
    if (!row || row.ownerUserId !== pairing.owner || links.has(row.id) || !(await liveOwner(pairing.owner)))
      throw new UnauthorizedError();
    const credential = `dsb_${row.id.slice(8)}_${randomBytes(32).toString("base64url")}`;
    const credentialHash = digest(credential);
    const updated = await db
      .updateTable("nodes")
      .set({ publicKey: credentialHash })
      .where("id", "=", row.id)
      .where("publicKey", "=", `pair:${hash}`)
      .executeTakeFirst();
    if (updated.numUpdatedRows !== 1n) throw new UnauthorizedError();
    return { id: row.id, owner: pairing.owner, name: row.name, credential, credentialHash };
  }
  const match = /^dsb_([0-9a-f-]{36})_[A-Za-z0-9_-]{43}$/.exec(token);
  const row = match ? await nodes.findById(`desktop:${match[1]}`) : undefined;
  if (row?.kind !== "runtime" || row.publicKey !== hash || links.has(row.id) || !(await liveOwner(row.ownerUserId)))
    throw new UnauthorizedError();
  return { id: row.id, owner: row.ownerUserId, name: row.name, credentialHash: hash };
}
export interface DesktopSocket {
  send(data: string): unknown;
  close(code?: number, reason?: string): void;
  readonly bufferedAmount?: number;
}
interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}
export class DesktopLink {
  readonly pending = new Map<string, Pending>();
  readonly refs = new Set<string>();
  ready = false;
  private requestSequence = 0;
  private stopped = false;
  private checking = false;
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(
    readonly identity: DesktopIdentity,
    readonly socket: DesktopSocket,
  ) {
    this.timer = setInterval(() => {
      if (!this.checking) {
        this.checking = true;
        void this.authorized()
          .then((ok) => {
            if (!ok) this.close();
          })
          .catch(() => this.close())
          .finally(() => {
            this.checking = false;
          });
      }
    }, 5000);
  }
  async authorized(): Promise<boolean> {
    if (this.stopped || links.get(this.identity.id) !== this) return false;
    const row = await nodes.findById(this.identity.id);
    return (
      row?.ownerUserId === this.identity.owner &&
      row.publicKey === this.identity.credentialHash &&
      (await liveOwner(this.identity.owner))
    );
  }
  async rpc(cmd: DesktopCommand, timeoutMs: number): Promise<unknown> {
    if (!this.ready) throw new NodeRpcError("offline", "Desktop broker is not attached.", this.identity.id);
    if (!(await this.authorized())) {
      this.close();
      throw new NodeRpcError("offline", "Desktop broker unavailable.", this.identity.id);
    }
    if (
      !parseDesktopCommand(cmd) ||
      this.pending.size >= MAX_PENDING ||
      this.stopped ||
      (this.socket.bufferedAmount ?? 0) > MAX_FRAME
    )
      throw new NodeRpcError("failed", "Desktop broker queue unavailable.", this.identity.id);
    if (cmd.type === "ssh_session_open") this.refs.add(cmd.ref);
    else if ((cmd.type === "ssh_session_send" || cmd.type === "ssh_session_close") && !this.refs.has(cmd.ref))
      throw new NodeRpcError("failed", "session_unknown", this.identity.id, "session_unknown");
    const requestId = String(++this.requestSequence);
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new NodeRpcError("timeout", "Desktop broker did not acknowledge the command.", this.identity.id));
        this.close();
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify({ type: "command", requestId, command: cmd }));
      } catch {
        this.close();
      }
    })
      .catch((error: unknown) => {
        if (cmd.type === "ssh_session_open") this.refs.delete(cmd.ref);
        throw error;
      })
      .finally(() => {
        if (cmd.type === "ssh_session_close") this.refs.delete(cmd.ref);
      });
  }
  async message(value: unknown): Promise<void> {
    if (!(await this.authorized())) {
      this.close();
      return;
    }
    if (typeof value === "string") {
      if (value.length > MAX_FRAME) {
        this.close();
        return;
      }
      try {
        value = JSON.parse(value);
      } catch {
        this.close();
        return;
      }
    }
    if (!value || typeof value !== "object" || JSON.stringify(value).length > MAX_FRAME) {
      this.close();
      return;
    }
    const frame = value as Record<string, unknown>;
    if (frame.type === "result" && typeof frame.requestId === "string" && typeof frame.ok === "boolean") {
      const pending = this.pending.get(frame.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(frame.requestId);
      if (frame.ok) pending.resolve(frame.data);
      else
        pending.reject(
          new NodeRpcError(
            "failed",
            "Desktop SSH command refused.",
            this.identity.id,
            typeof frame.error === "string" ? frame.error : "connection_failed",
          ),
        );
    } else if (
      frame.type === "session_frame" &&
      typeof frame.ref === "string" &&
      this.refs.has(frame.ref) &&
      typeof frame.data_b64 === "string" &&
      frame.data_b64.length <= 262144 &&
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.data_b64)
    ) {
      deliverSessionFrame(this.identity.id, frame.ref, frame.data_b64);
    } else if (frame.type === "session_lost" && typeof frame.ref === "string" && this.refs.has(frame.ref)) {
      this.refs.delete(frame.ref);
      deliverSessionLost(this.identity.id, frame.ref);
    } else this.close();
  }
  close(): void {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    if (links.get(this.identity.id) === this) {
      links.delete(this.identity.id);
      markSessionsLostForNode(this.identity.id);
      void nodes.setStatus(this.identity.id, "offline").catch(() => {});
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new NodeRpcError("offline", "Desktop broker disconnected.", this.identity.id));
    }
    this.pending.clear();
    this.socket.close(1000, "Desktop broker closed");
  }
}
export async function attachDesktopBroker(identity: DesktopIdentity, socket: DesktopSocket): Promise<DesktopLink> {
  if (links.has(identity.id)) throw new UnauthorizedError();
  const link = new DesktopLink(identity, socket);
  links.set(identity.id, link);
  if (!(await link.authorized())) {
    link.close();
    throw new UnauthorizedError();
  }
  try {
    await nodes.setStatus(identity.id, "online");
    if (!(await link.authorized())) throw new UnauthorizedError();
    socket.send(
      JSON.stringify({
        type: "attached",
        id: identity.id,
        name: identity.name,
        ...(identity.credential ? { brokerCredential: identity.credential } : {}),
      }),
    );
    link.ready = true;
  } catch (error) {
    link.close();
    throw error;
  }
  return link;
}
export async function desktopCommand(id: string, cmd: DesktopCommand, timeoutMs = 60_000): Promise<unknown> {
  const link = links.get(id);
  if (!link) throw new NodeRpcError("offline", "Desktop broker unavailable.", id);
  return await link.rpc(cmd, timeoutMs);
}

/** Pin a session to this exact attachment; resumed desktops never inherit uncertain RPCs. */
export function getDesktopLink(id: string): DesktopLink | undefined {
  return links.get(id);
}
