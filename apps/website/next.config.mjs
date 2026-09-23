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
};

export default config;
