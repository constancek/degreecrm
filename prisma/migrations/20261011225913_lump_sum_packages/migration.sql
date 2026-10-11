-- AlterEnum
ALTER TYPE "ProposalStatus" ADD VALUE 'declined';

-- AlterTable
ALTER TABLE "Proposal" ADD COLUMN     "declineReason" TEXT,
ADD COLUMN     "declinedAt" TIMESTAMP(3),
ADD COLUMN     "depositChoice" TEXT,
ADD COLUMN     "depositInvoiceId" TEXT,
ADD COLUMN     "depositInvoiceLink" TEXT,
ADD COLUMN     "number" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "ProposalOption" ADD COLUMN     "priceCents" INTEGER;

-- CreateTable
CREATE TABLE "PaymentMilestone" (
    "id" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "percent" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "amountCents" INTEGER,
    "invoiceId" TEXT,
    "invoiceLink" TEXT,
    "invoicedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentMilestone_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PaymentMilestone_proposalId_idx" ON "PaymentMilestone"("proposalId");

-- AddForeignKey
ALTER TABLE "PaymentMilestone" ADD CONSTRAINT "PaymentMilestone_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "Proposal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: one estimate number per lead (revisions share it), starting at #1001; new ones continue after.
WITH numbered AS (
  SELECT "leadId", 1000 + ROW_NUMBER() OVER (ORDER BY MIN("createdAt")) AS n FROM "Proposal" GROUP BY "leadId"
)
UPDATE "Proposal" p SET "number" = numbered.n FROM numbered WHERE p."leadId" = numbered."leadId";
SELECT setval(pg_get_serial_sequence('"Proposal"', 'number'), GREATEST(1000, (SELECT COALESCE(MAX("number"), 1000) FROM "Proposal")));

-- Existing packages: their current subtotal becomes the package price.
UPDATE "ProposalOption" SET "priceCents" = "subtotalCents";
