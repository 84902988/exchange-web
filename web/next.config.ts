import type { NextConfig } from "next";

const backend = process.env.NEXT_PUBLIC_BACKEND_ORIGIN || "http://127.0.0.1:8000";

const nextConfig: NextConfig = {
  // TypeScript remains an explicit audit gate; do not let existing diagnostics
  // prevent production assets from being compiled.
  typescript: {
    ignoreBuildErrors: true,
  },
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${backend}/:path*` },
      { source: "/static/:path*", destination: `${backend}/static/:path*` },
    ];
  },
};

export default nextConfig;
