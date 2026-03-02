import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Disable Turbopack — known crash bug with corrupted .next cache
  // Remove this once Turbopack stabilizes in a future Next.js version
};

export default nextConfig;
