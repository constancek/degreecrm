import { defineConfig, devices } from "@playwright/test";

// E2E runs a production build against the test database (`npm run db:local` must be running).
const PORT = 3100;
const TEST_DB = process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:54329/degreecrm_test";

export const E2E_ENV = {
  DATABASE_URL: TEST_DB,
  DATABASE_URL_UNPOOLED: TEST_DB,
  APP_HOST: "localhost",
  CLIENT_HOST: "go.localhost",
  APP_URL: `http://localhost:${PORT}`,
  OWNER_EMAIL: "owner@e2e.test",
  ALLOWED_EMAILS: "tech1@example.com,tech2@example.com",
  E2E_AUTH: "1",
  AI_MOCK: "1",
  ANTHROPIC_API_KEY: "",
  QUO_API_KEY: "",
  BLOB_READ_WRITE_TOKEN: "",
  GOOGLE_MAPS_API_KEY: "",
  DISCORD_SERVICE_WEBHOOK_URL: "",
  INTAKE_ALLOWED_ORIGINS: "https://cincydegreeofcomfort.com",
  TURNSTILE_SECRET_KEY: "",
  AUTH_GOOGLE_ID: "",
  AUTH_GOOGLE_SECRET: "",
};

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npx next build && npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}/login`,
    timeout: 240_000,
    reuseExistingServer: !process.env.CI,
    env: E2E_ENV,
  },
});
