-- AlterEnum
ALTER TYPE "ReviewStatus" ADD VALUE 'PARTIAL';

-- AlterTable
ALTER TABLE "Review" ADD COLUMN "coverage" JSONB;
