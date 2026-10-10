import type { Tier } from "@/generated/prisma/enums";

// Client-safe (no server imports): used by browser components.
export const TIER_LABELS: Record<Tier, string> = { good: "Good", better: "Better", best: "Best" };
