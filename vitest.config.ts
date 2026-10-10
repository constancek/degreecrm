import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const TEST_DB = process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:54329/degreecrm_test";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    env: {
      DATABASE_URL: TEST_DB,
      DATABASE_URL_UNPOOLED: TEST_DB,
      APP_URL: "https://app.test",
      OWNER_EMAIL: "owner@test.dev",
      ALLOWED_EMAILS: "tech@test.dev",
      DATA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      DISCORD_SERVICE_WEBHOOK_URL: "",
    },
    // Service tests share one database.
    fileParallelism: false,
  },
});
