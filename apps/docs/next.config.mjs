import { createMDX } from 'fumadocs-mdx/next';

/**
 * Static export: the deployable site is the `out/` directory (Cloudflare
 * Pages serves it verbatim — no Node runtime on the host). `images.unoptimized`
 * is required by static export; the docs pages ship no next/image payloads.
 */
/** @type {import('next').NextConfig} */
const config = {
  output: 'export',
  images: { unoptimized: true },
  reactStrictMode: true,
};

const withMDX = createMDX();

export default withMDX(config);
