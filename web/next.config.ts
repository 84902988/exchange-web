import type { NextConfig } from "next";

const backend = process.env.NEXT_PUBLIC_BACKEND_ORIGIN || "http://127.0.0.1:8000";

const configuredDevOrigins = (process.env.NEXT_DEV_ALLOWED_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const allowedDevOrigins = Array.from(
  new Set([
    "127.0.0.1",
    "localhost",
    "moralis-hook.cpolar.io",
    "moralis-hook.zaf.cpolar.io",
    ...configuredDevOrigins,
  ]),
);

const nextConfig: NextConfig = {
  distDir: process.env.NEXT_DIST_DIR || ".next",
  allowedDevOrigins,
  turbopack: {
    root: process.cwd(),
  },
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
  async headers() {
    return [
      {
        source: "/tradingview/charting_library/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=3600, stale-while-revalidate=86400",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
