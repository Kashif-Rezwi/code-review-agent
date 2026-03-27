import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Compile workspace packages from source so the build isn't dependent on pre-built dist/
  transpilePackages: ['@cra/types', '@cra/ai'],

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
