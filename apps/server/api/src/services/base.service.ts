import type { Kysely } from "kysely";
import type { ILogLayer } from "loglayer";
import type { Repositories } from "@/db/repositories/index.js";
import type { Database } from "@/db/types/index.js";
import type { Services } from "@/services/index.js";

/** Everything a service needs from the request context. */
export interface CommonServiceParams {
  /** Request-scoped logger (carries the request id when built by contextPlugin). */
  log: ILogLayer;
  /** The application database. */
  db: Kysely<Database>;
  /** The repositories built by `ApiContext` (shared instance, not per service). */
  repos: Repositories;
}

/**
 * Shared plumbing for the per-resource services: holds the context's log/db/
 * repos and receives the sibling {@link Services} map after construction
 * (services are built together, so they can only be linked post-constructor).
 */
export class BaseService {
  log: ILogLayer;
  db: Kysely<Database>;
  repos: Repositories;
  services: Services;

  constructor({ log, db, repos }: CommonServiceParams) {
    this.repos = repos;
    this.log = log;
    this.db = db;
    this.services = {} as Services;
  }

  /** Links the full services map; called by `ApiContext` after all services exist. */
  withServices(services: Services) {
    this.services = services;
  }
}
