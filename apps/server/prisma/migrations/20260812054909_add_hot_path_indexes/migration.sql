-- AlterTable
ALTER TABLE "Document" ALTER COLUMN "userId" DROP DEFAULT;

-- CreateIndex
CREATE INDEX "Conversation_reviewId_idx" ON "Conversation"("reviewId");

-- CreateIndex
CREATE INDEX "Document_userId_idx" ON "Document"("userId");

-- CreateIndex
CREATE INDEX "DocumentChunk_documentId_idx" ON "DocumentChunk"("documentId");

-- CreateIndex
CREATE INDEX "Issue_reviewId_idx" ON "Issue"("reviewId");

-- CreateIndex
CREATE INDEX "Review_userId_idx" ON "Review"("userId");
