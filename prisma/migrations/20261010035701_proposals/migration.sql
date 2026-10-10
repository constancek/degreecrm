-- CreateEnum
CREATE TYPE "PriceCategory" AS ENUM ('equipment', 'material', 'labor', 'fee');

-- CreateEnum
CREATE TYPE "Tier" AS ENUM ('good', 'better', 'best');

-- CreateEnum
CREATE TYPE "ProposalStatus" AS ENUM ('draft', 'sent', 'viewed', 'signed', 'superseded');

-- AlterTable
ALTER TABLE "Property" ADD COLUMN     "county" TEXT;

-- CreateTable
CREATE TABLE "PriceBookItem" (
    "id" TEXT NOT NULL,
    "trade" "Trade",
    "category" "PriceCategory" NOT NULL DEFAULT 'material',
    "name" TEXT NOT NULL,
    "description" TEXT,
    "sku" TEXT,
    "unit" TEXT NOT NULL DEFAULT 'ea',
    "costCents" INTEGER,
    "priceCents" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PriceBookItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxRate" (
    "id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "county" TEXT NOT NULL DEFAULT '',
    "rateBps" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaxRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TermsVersion" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "keyTerms" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TermsVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadPhoto" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "blobPath" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeadPhoto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Proposal" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "ProposalStatus" NOT NULL DEFAULT 'draft',
    "token" TEXT,
    "summary" TEXT NOT NULL DEFAULT '',
    "assumptions" TEXT[],
    "exclusions" TEXT[],
    "recommendedTier" "Tier",
    "selectedOptionId" TEXT,
    "taxRateBps" INTEGER NOT NULL DEFAULT 0,
    "taxLabel" TEXT NOT NULL DEFAULT '',
    "depositPercent" INTEGER NOT NULL DEFAULT 50,
    "termsVersionId" TEXT,
    "inputNotes" TEXT,
    "targetMarginPercent" INTEGER,
    "aiModel" TEXT,
    "sentAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "firstViewedAt" TIMESTAMP(3),
    "lastViewedAt" TIMESTAMP(3),
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "gateFailures" INTEGER NOT NULL DEFAULT 0,
    "lockedAt" TIMESTAMP(3),
    "pdfPath" TEXT,
    "pdfKey" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Proposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProposalOption" (
    "id" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "tier" "Tier" NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL DEFAULT '',
    "highlights" TEXT[],
    "warrantyText" TEXT NOT NULL DEFAULT '',
    "sortOrder" INTEGER NOT NULL,
    "subtotalCents" INTEGER NOT NULL DEFAULT 0,
    "taxCents" INTEGER NOT NULL DEFAULT 0,
    "totalCents" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProposalOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LineItem" (
    "id" TEXT NOT NULL,
    "optionId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "qty" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "unit" TEXT NOT NULL DEFAULT 'ea',
    "unitCents" INTEGER NOT NULL,
    "isOptional" BOOLEAN NOT NULL DEFAULT false,
    "needsPrice" BOOLEAN NOT NULL DEFAULT false,
    "priceBookItemId" TEXT,
    "sortOrder" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LineItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PriceBookItem_trade_active_idx" ON "PriceBookItem"("trade", "active");

-- CreateIndex
CREATE UNIQUE INDEX "TaxRate_state_county_key" ON "TaxRate"("state", "county");

-- CreateIndex
CREATE UNIQUE INDEX "TermsVersion_version_key" ON "TermsVersion"("version");

-- CreateIndex
CREATE INDEX "LeadPhoto_leadId_idx" ON "LeadPhoto"("leadId");

-- CreateIndex
CREATE UNIQUE INDEX "Proposal_token_key" ON "Proposal"("token");

-- CreateIndex
CREATE UNIQUE INDEX "Proposal_leadId_version_key" ON "Proposal"("leadId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "ProposalOption_proposalId_tier_key" ON "ProposalOption"("proposalId", "tier");

-- CreateIndex
CREATE INDEX "LineItem_optionId_idx" ON "LineItem"("optionId");

-- AddForeignKey
ALTER TABLE "TermsVersion" ADD CONSTRAINT "TermsVersion_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadPhoto" ADD CONSTRAINT "LeadPhoto_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Proposal" ADD CONSTRAINT "Proposal_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Proposal" ADD CONSTRAINT "Proposal_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Proposal" ADD CONSTRAINT "Proposal_termsVersionId_fkey" FOREIGN KEY ("termsVersionId") REFERENCES "TermsVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProposalOption" ADD CONSTRAINT "ProposalOption_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "Proposal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LineItem" ADD CONSTRAINT "LineItem_optionId_fkey" FOREIGN KEY ("optionId") REFERENCES "ProposalOption"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LineItem" ADD CONSTRAINT "LineItem_priceBookItemId_fkey" FOREIGN KEY ("priceBookItemId") REFERENCES "PriceBookItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
