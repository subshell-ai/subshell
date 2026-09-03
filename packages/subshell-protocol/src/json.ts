/** A JSON value, structurally typed (this package stays schema-lib-free). */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
