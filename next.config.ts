import type { NextConfig } from "next";

const projectRoot = process.cwd();

const nextConfig: NextConfig = {
  // output: "standalone" removed — the @opennextjs/cloudflare adapter
  // handles output bundling for Cloudflare Pages. Docker builds still
  // work with the default output mode.
  // This checkout sits below another package-lock.json. Pin both tracing and
  // Turbopack to this app so generated next/font modules resolve in dev too.
  outputFileTracingRoot: projectRoot,
  turbopack: { root: projectRoot },
};

export default nextConfig;
