import { execSync } from "node:child_process";

// Bring the test database to the current schema. Needs `npm run db:local` (or TEST_DATABASE_URL).
export default function setup() {
  const url = process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:54329/degreecrm_test";
  execSync("npx prisma migrate deploy", {
    stdio: "pipe",
    env: { ...process.env, DATABASE_URL: url, DATABASE_URL_UNPOOLED: url },
  });
}
