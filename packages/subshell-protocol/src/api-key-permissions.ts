/** Explicit grants for automation keys. Selecting all snapshots today's grants, never a wildcard. */
export const API_KEY_PERMISSION_GROUPS = [
  {
    id: "nodes",
    label: "Node provisioning",
    permissions: [
      { id: "nodes:read", label: "Read nodes", description: "Read node inventory, configuration, and sharing grants." },
      {
        id: "nodes:enroll",
        label: "Enroll nodes",
        description: "Generate, list, and revoke new-node setup keys. Recovery keys remain private.",
      },
      {
        id: "nodes:configure",
        label: "Configure nodes",
        description: "Change names and calling-agent guidance, and recheck installed agents.",
      },
      { id: "nodes:diagnostics", label: "Change logging", description: "Turn debug logging on or off on a node." },
    ],
  },
  {
    id: "node-security",
    label: "Node access and operations",
    permissions: [
      {
        id: "nodes:directories",
        label: "Change directory rules",
        description: "Replace directory restrictions. An empty list makes the node unrestricted.",
      },
      {
        id: "nodes:share",
        label: "Change node sharing",
        description: "Grant or revoke other users' access to launch subshells on a node.",
      },
      {
        id: "nodes:ssh",
        label: "Change SSH access",
        description: "Enable or disable Subshell SSH and use of the machine's keys.",
      },
      {
        id: "nodes:preview",
        label: "Preview panes",
        description: "Turn pane preview on or off on a node.",
      },
      {
        id: "nodes:ssh-wide-forwards",
        label: "Allow network-accessible forwards",
        description: "Allow SSH forwards to listen on addresses other machines can reach.",
      },
      {
        id: "nodes:maintenance",
        label: "Change maintenance state",
        description: "Stop every running subshell on a node or return it to service.",
      },
    ],
  },
  {
    id: "subshells",
    label: "Subshells",
    permissions: [
      {
        id: "subshells:read",
        label: "Read subshells",
        description: "Read accessible subshells, output, and agent state. Output may contain secrets.",
      },
      {
        id: "subshells:execute",
        label: "Run commands",
        description:
          "Create and restart subshells, send input, and attach terminals. Commands run with the machine user's privileges.",
      },
      {
        id: "subshells:update",
        label: "Update subshell details",
        description: "Change names and notification preferences.",
      },
      {
        id: "subshells:stop",
        label: "Stop and delete subshells",
        description: "Interrupt running work and delete subshell history.",
      },
    ],
  },
  {
    id: "library",
    label: "Presets and prompts",
    permissions: [
      { id: "presets:read", label: "Read presets", description: "Read accessible launch presets and harness schemas." },
      { id: "prompts:read", label: "Read prompts", description: "Read saved prompts and prompt stacks." },
      {
        id: "prompts:write",
        label: "Manage prompts",
        description: "Create, change, and delete saved prompts and stacks.",
      },
    ],
  },
  {
    id: "communication",
    label: "Communication",
    permissions: [
      {
        id: "channels:read",
        label: "Read channels",
        description: "Read channels, members, encrypted posts, and public encryption identities.",
      },
      {
        id: "channels:write",
        label: "Manage channels and identities",
        description: "Create and join channels, post messages, and rotate the system account's encryption identity.",
      },
    ],
  },
  {
    id: "transfers",
    label: "File transfers",
    permissions: [
      {
        id: "transfers:write",
        label: "Transfer files",
        description: "Copy archives between accessible subshells, reading and writing files on their machines.",
      },
    ],
  },
  {
    id: "instance",
    label: "Instance information",
    permissions: [
      {
        id: "instance:read",
        label: "Read instance information",
        description: "Read server version, public settings, and installed plugin information.",
      },
    ],
  },
] as const;

/** One grant accepted by the API and shown in the key creation form. */
export type ApiKeyPermission = (typeof API_KEY_PERMISSION_GROUPS)[number]["permissions"][number]["id"];

/** Concrete grants available at key creation; future grants are never added to an existing key. */
export const API_KEY_PERMISSIONS: readonly ApiKeyPermission[] = API_KEY_PERMISSION_GROUPS.flatMap((group) =>
  group.permissions.map((permission) => permission.id),
);

/** Validates stored grants without treating unrecognized values as authority. */
export function isApiKeyPermission(value: unknown): value is ApiKeyPermission {
  return typeof value === "string" && (API_KEY_PERMISSIONS as readonly string[]).includes(value);
}
