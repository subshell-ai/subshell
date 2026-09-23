/**
 * Static export: the deployable site is the `out/` directory (Cloudflare
 * serves it verbatim — no Node runtime on the host). `images.unoptimized`
 * is required by static export; the marketing pages ship no next/image
 * payloads.
 */
/** @type {import('next').NextConfig} */
const config = {
  output: 'export',
  images: { unoptimized: true },
  reactStrictMode: true,
  // next dev 16.3.5 auto-appends a managed "agent rules" block to AGENTS.md
  // on every dev boot (the feature is ON by default). This app's AGENTS.md is
  // a checked-in contract — false disables the writer.
  agentRules: false,
};

export default config;
