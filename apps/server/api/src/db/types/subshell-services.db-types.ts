import type { Generated } from "kysely";

export interface SubshellServiceTable {
  id: string;
  subshellId: string;
  name: string;
  host: string;
  port: number;
  protocol: "http" | "https";
  ignoreCertificateErrors: Generated<number>;
  configuration: Generated<string | null>;
  revision: Generated<number>;
  createdAt: string;
}
