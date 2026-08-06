import path from "node:path";
import type { NextConfig } from "next";

const config: NextConfig = {
  poweredByHeader: false,
  // This app lives inside a larger repo that has its own PostCSS/Tailwind
  // setup. Pin the root so the build resolves config from here and not upward.
  turbopack: { root: path.resolve(process.cwd()) },
  reactStrictMode: false, // the stream engine owns real sockets; double-mount churns them
};

export default config;
