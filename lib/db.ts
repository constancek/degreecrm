import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

// One client per process (web, worker, seed). Reused across hot reloads in dev.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/**
 * Neon URLs say sslmode=require, which pg 8 already treats as verify-full and warns about.
 * Say verify-full explicitly (Neon's certificates are publicly trusted).
 */
export function normalizeSslMode(url: string | undefined): string | undefined {
  return url?.replace(/([?&]sslmode=)(prefer|require|verify-ca)(?=&|$)/, "$1verify-full");
}

function createClient() {
  const adapter = new PrismaPg({ connectionString: normalizeSslMode(process.env.DATABASE_URL) });
  return new PrismaClient({ adapter });
}

export const db = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;

export type Db = typeof db;
export type Tx = Parameters<Parameters<Db["$transaction"]>[0]>[0];
