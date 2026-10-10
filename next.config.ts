import type { NextConfig } from "next";

// Cache Components is off on purpose: every CRM page is per-user and
// request-time, so the default dynamic rendering model is the simpler fit.
const nextConfig: NextConfig = {
  serverExternalPackages: ["pg", "@prisma/adapter-pg"],
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
