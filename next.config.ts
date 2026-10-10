import type { NextConfig } from "next";

// Cache Components is off on purpose: every CRM page is per-user and
// request-time, so the default dynamic rendering model is the simpler fit.
const nextConfig: NextConfig = {
  serverExternalPackages: ["pg", "@prisma/adapter-pg", "playwright-core", "@sparticuz/chromium"],
  // Files read at runtime that the bundler can't see: Claude prompts and the Chromium binary for PDFs.
  outputFileTracingIncludes: {
    "/**": ["./prompts/**/*"],
    "/p/[token]/pdf": ["./node_modules/@sparticuz/chromium/bin/**/*"],
    "/proposals/[id]/pdf": ["./node_modules/@sparticuz/chromium/bin/**/*"],
  },
  experimental: {
    // Photos for proposal drafting are resized in the browser first; this leaves room for six.
    serverActions: { bodySizeLimit: "4mb" },
  },
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
