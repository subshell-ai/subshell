import { SSH_NAME_MAX_CHARS } from "@internal/subshell-protocol";

export function sshPresetNameProblem(value: string): string | null {
  if (!value.trim()) return "Enter a preset name.";
  if (value.length > 120) return "Keep the preset name within 120 characters.";
  if (/\p{Cc}/u.test(value)) return "Remove control characters from the preset name.";
  return null;
}

/** Validate explicit input without guessing which aliases exist on the connecting node. */
export function sshDestinationProblem(value: string): string | null {
  if (!value) return "Enter an SSH destination.";
  if (value.length > SSH_NAME_MAX_CHARS) return `Keep the SSH destination within ${SSH_NAME_MAX_CHARS} characters.`;
  if (/\s|\p{Cc}/u.test(value)) return "Remove spaces and control characters from the SSH destination.";
  const parts = value.split("@");
  if (parts.length > 2 || parts.some((part) => !part))
    return "Enter a hostname or SSH alias, optionally preceded by user@.";
  const hostPort = parts[parts.length - 1];
  let host = hostPort;
  let port: string | undefined;
  if (hostPort.startsWith("[")) {
    const close = hostPort.indexOf("]");
    if (close < 2) return "Put the IPv6 address inside brackets, for example [::1]:22.";
    host = hostPort.slice(0, close + 1);
    const tail = hostPort.slice(close + 1);
    if (tail && !tail.startsWith(":")) return "Add a port after the closing bracket, for example [::1]:22.";
    if (tail) port = tail.slice(1);
  } else {
    const colon = hostPort.indexOf(":");
    if (colon !== -1) {
      host = hostPort.slice(0, colon);
      port = hostPort.slice(colon + 1);
      if (port.includes(":")) return "Put the IPv6 address inside brackets, for example [::1]:22.";
    }
    if (/[[\]]/.test(host)) return "Put the IPv6 address inside brackets, for example [::1]:22.";
  }
  if (!host || host.startsWith("-") || value.startsWith("-"))
    return "Enter a hostname or SSH alias that doesn’t start with a dash.";
  if (port !== undefined && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535))
    return "Enter a port between 1 and 65535.";
  return null;
}
