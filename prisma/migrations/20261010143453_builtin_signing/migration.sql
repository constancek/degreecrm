/*
  Warnings:

  - Added the required column `contentHash` to the `Signature` table without a default value. This is not possible if the table is not empty.
  - Added the required column `method` to the `Signature` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Signature" ADD COLUMN     "consentAt" TIMESTAMP(3),
ADD COLUMN     "contentHash" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "copySentAt" TIMESTAMP(3),
ADD COLUMN     "method" TEXT NOT NULL DEFAULT 'documenso',
ADD COLUMN     "phoneVerified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "recordedById" TEXT,
ADD COLUMN     "signatureImagePath" TEXT,
ADD COLUMN     "signedPdfHash" TEXT,
ADD COLUMN     "typedSignature" TEXT;

-- Defaults only cover rows signed before built-in signing existed.
ALTER TABLE "Signature" ALTER COLUMN "contentHash" DROP DEFAULT, ALTER COLUMN "method" DROP DEFAULT;

-- Documenso replaced by built-in signing.
ALTER TABLE "Proposal" DROP COLUMN IF EXISTS "documensoDocumentId", DROP COLUMN IF EXISTS "signingUrl";
