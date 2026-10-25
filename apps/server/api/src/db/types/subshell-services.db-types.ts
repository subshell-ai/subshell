export interface SubshellServiceTable {
  id: string;
  subshellId: string;
  name: string;
  host: string;
  port: number;
  protocol: "http" | "https";
  createdAt: string;
}
