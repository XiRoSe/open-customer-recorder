import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  // playwright-core has runtime-loaded JSON (browsers.json) and native
  // bindings that Next's output tracer can't statically discover, so it
  // ships an incomplete copy. Same for @huggingface/transformers, whose
  // onnxruntime-node dependency carries native binaries. Mark them
  // external so they're required from node_modules at runtime.
  serverExternalPackages: ['playwright-core', '@huggingface/transformers'],
  async headers() {
    return [
      {
        // /tracker.js is injected into customer sites with no
        // cache-busting query param, so a stale build can stick on a
        // user's browser (especially mobile) for hours. Force every
        // request to revalidate so a deploy actually reaches users.
        source: '/tracker.js',
        headers: [
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
        ],
      },
    ];
  },
};

export default nextConfig;
