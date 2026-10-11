import type { Tier } from "@/generated/prisma/enums";

// Client-safe (no server imports): used by browser components.
// Tier ids stay good/better/best in the database; customers and staff see these names.
export const TIER_LABELS: Record<Tier, string> = { good: "Essential", better: "Premium", best: "Supreme" };
