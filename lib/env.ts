/** Public base URL of the CRM, without trailing slash. */
export function appUrl(): string {
  return (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
}

export function ownerEmail(): string | null {
  return process.env.OWNER_EMAIL?.trim().toLowerCase() || null;
}

export function allowedEmails(): string[] {
  return (process.env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/** The password-less test login. Refuses to turn on in a Vercel production deployment. */
export function e2eAuthEnabled(): boolean {
  return process.env.E2E_AUTH === "1" && process.env.VERCEL_ENV !== "production";
}
