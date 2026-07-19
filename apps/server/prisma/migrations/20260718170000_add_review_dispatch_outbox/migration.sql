-- CreateEnum
CREATE TYPE "DispatchStatus" AS ENUM ('PENDING', 'PROCESSING', 'DISPATCHED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "ReviewDispatch" (
    "id" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "status" "DispatchStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedUntil" TIMESTAMP(3),
    "lastError" TEXT,
    "dispatchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewDispatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReviewDispatch_reviewId_key" ON "ReviewDispatch"("reviewId");

-- CreateIndex
CREATE INDEX "ReviewDispatch_status_availableAt_idx" ON "ReviewDispatch"("status", "availableAt");

-- AddForeignKey
ALTER TABLE "ReviewDispatch" ADD CONSTRAINT "ReviewDispatch_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "Review"("id") ON DELETE CASCADE ON UPDATE CASCADE;
