/** Connection choices carried through approval; URL values never trigger a launch. */
export function sshConnectSearch(search: Record<string, unknown>): {
  node?: string;
  destination?: string;
  keyHome?: string;
} {
  const text = (key: string, limit: number) =>
    typeof search[key] === "string" && search[key].length <= limit ? search[key] : undefined;
  return {
    node: text("node", 64),
    destination: text("destination", 253),
    keyHome: text("keyHome", 64),
  };
}
