-- CreateEnum
CREATE TYPE "PaymentKind" AS ENUM ('deposit', 'progress', 'final');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('card', 'ach', 'check', 'cash', 'financing', 'quickbooks_invoice', 'other');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('succeeded', 'failed', 'pending');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('unscheduled', 'scheduled', 'in_progress', 'completed', 'invoiced', 'paid', 'cancelled');

-- CreateEnum
CREATE TYPE "VisitKind" AS ENUM ('estimate', 'job');

-- CreateEnum
CREATE TYPE "VisitStatus" AS ENUM ('scheduled', 'en_route', 'in_progress', 'done', 'rescheduled', 'cancelled');

-- AlterTable
ALTER TABLE "Proposal" ADD COLUMN     "depositPaidAt" TIMESTAMP(3),
ADD COLUMN     "documensoDocumentId" INTEGER,
ADD COLUMN     "signedAt" TIMESTAMP(3),
ADD COLUMN     "signedOptionId" TEXT,
ADD COLUMN     "signingUrl" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "googleCalendarConnectedAt" TIMESTAMP(3),
ADD COLUMN     "googleCalendarEmail" TEXT,
ADD COLUMN     "googleCalendarPolledAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "Signature" (
    "id" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "optionId" TEXT NOT NULL,
    "signerName" TEXT NOT NULL,
    "signerEmail" TEXT NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "signedAt" TIMESTAMP(3) NOT NULL,
    "termsVersion" INTEGER NOT NULL,
    "termsAcceptedAt" TIMESTAMP(3) NOT NULL,
    "signedPdfPath" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Signature_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "proposalId" TEXT,
    "jobId" TEXT,
    "kind" "PaymentKind" NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "status" "PaymentStatus" NOT NULL,
    "quickbooksChargeId" TEXT,
    "quickbooksPaymentId" TEXT,
    "cardLast4" TEXT,
    "note" TEXT,
    "failureReason" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "propertyId" TEXT,
    "title" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'unscheduled',
    "assignedToId" TEXT,
    "totalCents" INTEGER NOT NULL,
    "depositCents" INTEGER NOT NULL,
    "durationHours" DOUBLE PRECISION NOT NULL DEFAULT 4,
    "quickbooksEstimateId" TEXT,
    "quickbooksInvoiceId" TEXT,
    "invoiceSentAt" TIMESTAMP(3),
    "invoiceLink" TEXT,
    "completedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Visit" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "jobId" TEXT,
    "kind" "VisitKind" NOT NULL,
    "techId" TEXT NOT NULL,
    "start" TIMESTAMP(3) NOT NULL,
    "end" TIMESTAMP(3) NOT NULL,
    "status" "VisitStatus" NOT NULL DEFAULT 'scheduled',
    "notes" TEXT,
    "googleEventId" TEXT,
    "googleEventOwnerId" TEXT,
    "syncState" TEXT NOT NULL DEFAULT 'pending',
    "syncError" TEXT,
    "enRouteAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Visit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Sequence" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Sequence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SequenceStep" (
    "id" TEXT NOT NULL,
    "sequenceId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "anchor" TEXT NOT NULL DEFAULT 'enrolled',
    "offsetHours" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "template" TEXT NOT NULL,
    "personalize" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SequenceStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Enrollment" (
    "id" TEXT NOT NULL,
    "sequenceId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "visitId" TEXT,
    "stepIndex" INTEGER NOT NULL DEFAULT 0,
    "nextSendAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'active',
    "stoppedReason" TEXT,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Enrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "leadId" TEXT,
    "direction" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "quoMessageId" TEXT,
    "enrollmentId" TEXT,
    "sentById" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Signature_proposalId_key" ON "Signature"("proposalId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_quickbooksChargeId_key" ON "Payment"("quickbooksChargeId");

-- CreateIndex
CREATE UNIQUE INDEX "Job_proposalId_key" ON "Job"("proposalId");

-- CreateIndex
CREATE INDEX "Job_status_idx" ON "Job"("status");

-- CreateIndex
CREATE INDEX "Job_leadId_idx" ON "Job"("leadId");

-- CreateIndex
CREATE INDEX "Visit_techId_start_idx" ON "Visit"("techId", "start");

-- CreateIndex
CREATE INDEX "Visit_start_idx" ON "Visit"("start");

-- CreateIndex
CREATE INDEX "Visit_syncState_idx" ON "Visit"("syncState");

-- CreateIndex
CREATE UNIQUE INDEX "Sequence_key_key" ON "Sequence"("key");

-- CreateIndex
CREATE INDEX "SequenceStep_sequenceId_sortOrder_idx" ON "SequenceStep"("sequenceId", "sortOrder");

-- CreateIndex
CREATE INDEX "Enrollment_status_nextSendAt_idx" ON "Enrollment"("status", "nextSendAt");

-- CreateIndex
CREATE INDEX "Enrollment_leadId_idx" ON "Enrollment"("leadId");

-- CreateIndex
CREATE UNIQUE INDEX "Message_quoMessageId_key" ON "Message"("quoMessageId");

-- CreateIndex
CREATE INDEX "Message_customerId_createdAt_idx" ON "Message"("customerId", "createdAt");

-- AddForeignKey
ALTER TABLE "Signature" ADD CONSTRAINT "Signature_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "Proposal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "Proposal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "Proposal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Visit" ADD CONSTRAINT "Visit_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Visit" ADD CONSTRAINT "Visit_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Visit" ADD CONSTRAINT "Visit_techId_fkey" FOREIGN KEY ("techId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SequenceStep" ADD CONSTRAINT "SequenceStep_sequenceId_fkey" FOREIGN KEY ("sequenceId") REFERENCES "Sequence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Enrollment" ADD CONSTRAINT "Enrollment_sequenceId_fkey" FOREIGN KEY ("sequenceId") REFERENCES "Sequence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Enrollment" ADD CONSTRAINT "Enrollment_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Enrollment" ADD CONSTRAINT "Enrollment_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "Visit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "Enrollment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_sentById_fkey" FOREIGN KEY ("sentById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
