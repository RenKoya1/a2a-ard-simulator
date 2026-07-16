import type { NextConfig } from 'next';

const gateway = `http://localhost:${process.env.SIM_GATEWAY_PORT ?? 4600}`;

const nextConfig: NextConfig = {
  // Production build is a static export served by the express gateway
  // (single-process deployment). In dev, next runs as a normal server so
  // /api/* can proxy to the running gateway below.
  ...(process.env.NODE_ENV === 'production' ? { output: 'export' as const } : {}),
  eslint: { ignoreDuringBuilds: true },
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${gateway}/api/:path*` }];
  },
};

export default nextConfig;
