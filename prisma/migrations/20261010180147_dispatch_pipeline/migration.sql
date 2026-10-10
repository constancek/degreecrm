-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "LeadStage" ADD VALUE 'needs_tech';
ALTER TYPE "LeadStage" ADD VALUE 'needs_reschedule';
ALTER TYPE "LeadStage" ADD VALUE 'on_the_way';
ALTER TYPE "LeadStage" ADD VALUE 'on_site';
ALTER TYPE "LeadStage" ADD VALUE 'estimate_declined';

-- AlterEnum
ALTER TYPE "PaymentKind" ADD VALUE 'service_fee';

-- AlterTable
ALTER TABLE "Visit" ADD COLUMN     "arrivalEnd" TIMESTAMP(3),
ADD COLUMN     "arrivalStart" TIMESTAMP(3),
ADD COLUMN     "feeCents" INTEGER,
ADD COLUMN     "feeInvoiceId" TEXT,
ADD COLUMN     "feeInvoiceLink" TEXT,
ADD COLUMN     "feeStatus" TEXT,
ADD COLUMN     "lateEta" TIMESTAMP(3),
ADD COLUMN     "outcome" TEXT,
ALTER COLUMN "techId" DROP NOT NULL;

-- Appointment texts now say the arrival window, address and technician. Only templates still at their
-- old defaults are updated (anything edited in Settings is left alone).
UPDATE "SequenceStep" SET "template" = 'Hi {firstName}, this is {companyName}. Your service call at {address} is confirmed for {visitDay}. {techFullName} will arrive {arrivalWindow}. We''ll text you when {techName} is on the way. Reply here if you need to reschedule.'
WHERE "template" = 'Hi {firstName}, you''re confirmed! {companyName} will arrive {visitTime} for your estimate. {techName} will text when on the way.';

UPDATE "SequenceStep" SET "template" = 'Reminder: {techFullName} from {companyName} will arrive {visitDay}, {arrivalWindow}, for your service call. Reply here if you need to reschedule.'
WHERE "template" = 'Reminder: {techName} from {companyName} arrives {visitTime}. Reply here if you need to reschedule.';

UPDATE "SequenceStep" SET "template" = 'Hi {firstName}, your {jobTitle} is scheduled for {visitDay}. {techFullName} will arrive {arrivalWindow}. Thank you for choosing {companyName}!'
WHERE "template" = 'Hi {firstName}, your {jobTitle} is scheduled for {visitTime}. Thank you for choosing {companyName}!';

UPDATE "SequenceStep" SET "template" = 'Reminder: {techFullName} will arrive {visitDay}, {arrivalWindow}, for your {jobTitle}. Reply here with any questions.'
WHERE "template" = 'Reminder: we''ll see you {visitTime} for your {jobTitle}. Reply here with any questions.';

UPDATE "Sequence" SET "name" = 'Service call booked' WHERE "key" = 'estimate_visit' AND "name" = 'Estimate booked';
