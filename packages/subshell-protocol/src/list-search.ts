/** Search limits in UTF-16 units, shared by HTML inputs and API validation. */
export const LIST_SEARCH_MAX = {
  // Node names allow 128 units and enrolled hostnames allow 128.
  nodes: 128,
  // Includes working directories; matches the allowed-directory path ceiling.
  subshells: 4096,
  // Descriptions/labels allow 120, but bodies and inline stack items allow 20,000.
  prompts: 20000,
  workspaces: 120,
} as const;
