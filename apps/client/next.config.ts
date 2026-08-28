import type { NextConfig } from "next";

// Fail fast when required env vars are missing. NEXT_PUBLIC_* is inlined at build time.
// NEXTAUTH_* / GITHUB_* are runtime but failing build early gives a clear Vercel build log
// instead of opaque ?error=OAuthCallback at login time.
if (!process.env.NEXT_PUBLIC_API_URL) {
  throw new Error(
    'NEXT_PUBLIC_API_URL is not set. Define it in apps/client/.env (local dev), as a Docker build ARG, or in the Vercel project environment before building.',
  );
}
if (!process.env.GITHUB_CLIENT_ID) {
  throw new Error(
    'GITHUB_CLIENT_ID is not set. Define it in apps/client/.env or Vercel Project Settings -> Environment Variables (Production/Preview).',
  );
}
if (!process.env.GITHUB_CLIENT_SECRET) {
  throw new Error(
    'GITHUB_CLIENT_SECRET is not set. Define it in apps/client/.env or Vercel Project Settings -> Environment Variables (Production/Preview).',
  );
}
if (!process.env.NEXTAUTH_SECRET) {
  throw new Error(
    'NEXTAUTH_SECRET is not set. Generate with `openssl rand -base64 32` and set it in Vercel for Production and Preview (can be same value).',
  );
}
if (process.env.NODE_ENV === 'production' && !process.env.NEXTAUTH_URL && !process.env.VERCEL_URL) {
  console.warn(
    'WARNING: NEXTAUTH_URL is not set. Vercel will fall back to VERCEL_URL which will cause GitHub redirect_uri_mismatch. Set NEXTAUTH_URL=https://<your-domain> in Vercel.',
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
