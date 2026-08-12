import type { NextConfig } from "next";

// Fail fast when the API base URL is missing: Next inlines NEXT_PUBLIC_* at build
// time, so an unset var would bake in '' and every browser request would silently
// hit the Next.js origin and 404 (set it in apps/client/.env, the Docker build ARG,
// or the Vercel project environment).
if (!process.env.NEXT_PUBLIC_API_URL) {
  throw new Error(
    'NEXT_PUBLIC_API_URL is not set. Define it in apps/client/.env (local dev), as a Docker build ARG, or in the Vercel project environment before building.',
  );
}

const nextConfig: NextConfig = {
  // Compile workspace packages from source so the build isn't dependent on pre-built dist/
  transpilePackages: ['@cra/types', '@cra/ai'],

  // Produce a self-contained bundle for Docker deployment
  output: 'standalone',

  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'avatars.githubusercontent.com',
      },
    ],
  },
};

export default nextConfig;
