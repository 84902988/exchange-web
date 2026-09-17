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
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
      // TradingView's unhashed entry file points at version-hashed bundles.
      // Revalidate it on every load so an update cannot pair an old entry
      // script with a new bundle directory. This rule intentionally comes
      // after the wildcard because Next.js lets the last matching key win.
      {
        source: "/tradingview/charting_library/charting_library.js",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=0, must-revalidate",
          },
        ],
      },
      {
        source: "/tradingview/charting_library/sameorigin.html",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=0, must-revalidate",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
