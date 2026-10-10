import "dotenv/config";
import { defineConfig } from "prisma/config";

// Migrations need a direct (unpooled) connection; Neon on Vercel provides
// DATABASE_URL_UNPOOLED. Locally both point at the same database.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? "",
  },
});
