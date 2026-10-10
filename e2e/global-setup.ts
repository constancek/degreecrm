import { execSync } from "node:child_process";
import { E2E_ENV } from "../playwright.config";

// Fresh schema + seed data before every run.
export default function setup() {
  const env = { ...process.env, ...E2E_ENV };
  execSync("npx prisma migrate deploy", { stdio: "pipe", env });
  execSync("npx tsx prisma/seed.ts", { stdio: "pipe", env });
}
