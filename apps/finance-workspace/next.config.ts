import type { NextConfig } from "next";
import { prepareServerEnvironment } from "./lib/server-env";

// Load the single repository-root file before Next bundles NEXT_PUBLIC_* values.
prepareServerEnvironment();

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  serverExternalPackages: ['@llamaindex/liteparse'],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
