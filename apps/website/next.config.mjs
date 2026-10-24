/**
 * Static export: the deployable site is the `out/` directory (Cloudflare
 * serves it verbatim; no Node runtime on the host). `images.unoptimized`
 * is required by static export; the marketing pages ship no next/image
 * payloads.
 */
/** @type {import('next').NextConfig} */
const config = {
  output: 'export',
  // Private preview hosts belong in local environment settings, not source control.
  allowedDevOrigins: (process.env.WEBSITE_DEV_ORIGINS ?? '')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean),
  images: { unoptimized: true },
  reactStrictMode: true,
  // next dev 16.3.5 auto-appends a managed "agent rules" block to AGENTS.md
  // on every dev boot (the feature is ON by default). This app's AGENTS.md is
  // a checked-in contract: false disables the writer.
  agentRules: false,
};

export default config;
