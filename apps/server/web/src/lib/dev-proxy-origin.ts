/** Only known dev addresses are translated; foreign origins keep their refusal. */
export function devProxyOrigin(origin: string | undefined, devOrigins: readonly string[]): string | undefined {
  return origin !== undefined && devOrigins.includes(origin) ? "http://localhost:5174" : origin;
}
