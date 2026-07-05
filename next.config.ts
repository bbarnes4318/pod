import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      // Sound-design asset uploads (themes, beds, SFX packs) go through a
      // server action; the 1MB default can't fit an MP3.
      bodySizeLimit: "40mb",
    },
  },
};

export default nextConfig;
