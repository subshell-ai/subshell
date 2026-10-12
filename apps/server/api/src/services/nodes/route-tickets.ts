import { NODE_ROUTE_TICKET_MS } from "@internal/subshell-protocol/node-route";

interface RouteTicket {
  nodeKey: string;
  nodePublicKey: string;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}

/** Tickets never enter a URL or a log. Their scope is one encrypted node upgrade. */
export class RouteTickets {
  private readonly tickets = new Map<string, RouteTicket>();

  constructor(private readonly now: () => number = Date.now) {}

  issue(nodeKey: string, nodePublicKey: string): string {
    for (const [key, value] of this.tickets) {
      if (value.expiresAt <= this.now()) {
        clearTimeout(value.timer);
        this.tickets.delete(key);
      }
    }
    if (this.tickets.size >= 1024) throw new Error("Too many pending node connections");
    const ticket = crypto.randomUUID() + crypto.randomUUID();
    const timer = setTimeout(() => this.tickets.delete(ticket), NODE_ROUTE_TICKET_MS);
    timer.unref?.();
    this.tickets.set(ticket, { nodeKey, nodePublicKey, expiresAt: this.now() + NODE_ROUTE_TICKET_MS, timer });
    return ticket;
  }

  consume(ticket: string): RouteTicket | undefined {
    const value = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    if (value) clearTimeout(value.timer);
    return value && value.expiresAt > this.now() ? value : undefined;
  }
}

export const nodeRouteTickets = new RouteTickets();
