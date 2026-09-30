/** Published section order shared by the sidebar contract and AI index. */
export const DOC_SECTIONS = [
  { slug: "get-started", title: "Get started" },
  { slug: "install", title: "Installation" },
  { slug: "guides", title: "Use Subshell" },
  { slug: "agents", title: "Agents" },
  { slug: "nodes", title: "Manage nodes" },
  { slug: "administration", title: "Server administration" },
  { slug: "networking", title: "Networking" },
  { slug: "mcp", title: "MCP and agent communication" },
  { slug: "automation", title: "API and automation" },
  { slug: "concepts", title: "Concepts" },
  { slug: "reference", title: "Reference" },
  { slug: "troubleshooting", title: "Troubleshooting" },
  { slug: "developers", title: "Developers" },
] as const;

export const ROOT_PAGES = ["index", ...DOC_SECTIONS.map((section) => section.slug)];
