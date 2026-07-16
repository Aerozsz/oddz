import type { NextConfig } from "next";

const config: NextConfig = {
  typedRoutes: true,
  poweredByHeader: false,
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "polymarket-upload.s3.us-east-2.amazonaws.com" },
      { protocol: "https", hostname: "manifold.markets" },
      { protocol: "https", hostname: "kalshi.com" },
    ],
  },
  async headers() {
    // Conservative, app-safe security headers. A strict CSP needs a nonce
    // middleware to avoid breaking Next's inline bootstrap scripts, so
    // that's a deliberate follow-up; these are safe to ship day 1.
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), browsing-topics=()",
          },
        ],
      },
    ];
  },
};

export default config;
