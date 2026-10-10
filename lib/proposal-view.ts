// One serializable view of a proposal, used by the client page, the owner preview and the PDF,
// so all three always show the same numbers.

import type { Tier } from "@/generated/prisma/enums";
import { lineTotalCents } from "@/lib/money";
import { formatPhone } from "@/lib/phone";
import { formatAddress } from "@/lib/notifications/discord-embeds";
import { companyAddressLine, depositPercentFor, type CompanyProfile } from "@/lib/services/company";
import { renderKeyTerms } from "@/lib/services/terms";

type SourceProposal = {
  id: string;
  version: number;
  summary: string;
  assumptions: string[];
  exclusions: string[];
  recommendedTier: Tier | null;
  selectedOptionId: string | null;
  taxRateBps: number;
  taxLabel: string;
  depositPercent: number | null;
  expiresAt: Date | null;
  sentAt: Date | null;
  terms: { version: number; keyTerms: string } | null;
  lead: { title: string; customer: { name: string }; property: Parameters<typeof formatAddress>[0] };
  options: {
    id: string;
    tier: Tier;
    title: string;
    summary: string;
    highlights: string[];
    warrantyText: string;
    subtotalCents: number;
    taxCents: number;
    totalCents: number;
    lineItems: { id: string; description: string; qty: number; unit: string; unitCents: number; isOptional: boolean }[];
  }[];
};

export type ProposalView = ReturnType<typeof buildProposalView>;
export type OptionView = ProposalView["options"][number];

const DATE = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "long", day: "numeric", year: "numeric" });

export function buildProposalView(p: SourceProposal, company: CompanyProfile, fallbackKeyTerms?: string) {
  const expires = p.expiresAt ? DATE.format(p.expiresAt) : null;
  const keyTermsSource = p.terms?.keyTerms ?? fallbackKeyTerms ?? "";
  return {
    id: p.id,
    version: p.version,
    jobTitle: p.lead.title,
    customerName: p.lead.customer.name,
    address: formatAddress(p.lead.property),
    summary: p.summary,
    assumptions: p.assumptions,
    exclusions: p.exclusions,
    recommendedTier: p.recommendedTier,
    selectedOptionId: p.selectedOptionId,
    taxLabel: p.taxLabel,
    taxRateBps: p.taxRateBps,
    expires,
    sentOn: p.sentAt ? DATE.format(p.sentAt) : null,
    termsVersion: p.terms?.version ?? null,
    company: {
      name: company.name,
      phone: formatPhone(company.phone),
      phoneHref: company.phone ? `tel:${company.phone}` : null,
      email: company.email,
      address: companyAddressLine(company),
      licenseNumber: company.licenseNumber,
      website: company.website,
      logoUrl: company.logoPath ? `/brand/logo?v=${company.logoVersion}` : null,
    },
    options: p.options.map((o) => {
      const depositPercent = depositPercentFor(o.totalCents, company, p.depositPercent);
      return {
        id: o.id,
        tier: o.tier,
        title: o.title,
        summary: o.summary,
        highlights: o.highlights,
        warrantyText: o.warrantyText,
        subtotalCents: o.subtotalCents,
        taxCents: o.taxCents,
        totalCents: o.totalCents,
        depositPercent,
        depositCents: Math.round((o.totalCents * depositPercent) / 100),
        keyTerms: renderKeyTerms(keyTermsSource, { depositPercent, expires }),
        items: o.lineItems.map((l) => ({
          id: l.id,
          description: l.description,
          qty: l.qty,
          unit: l.unit,
          unitCents: l.unitCents,
          totalCents: lineTotalCents(l),
          isOptional: l.isOptional,
        })),
      };
    }),
  };
}

export { TIER_LABELS } from "@/lib/tiers";
