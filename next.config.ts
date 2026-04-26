import type { NextConfig } from "next";

const config: NextConfig = {
  typedRoutes: true,
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "polymarket-upload.s3.us-east-2.amazonaws.com" },
      { protocol: "https", hostname: "manifold.markets" },
      { protocol: "https", hostname: "kalshi.com" },
    ],
  },
};

export default config;
