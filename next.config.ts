import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // output: "standalone" removed — the @opennextjs/cloudflare adapter
  // handles output bundling for Cloudflare Pages. Docker builds still
  // work with the default output mode.
};

export default nextConfig;
