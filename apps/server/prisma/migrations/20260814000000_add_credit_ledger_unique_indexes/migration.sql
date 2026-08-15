-- Partial unique indexes for credit ledger idempotency (security hardening S-01, S-06).
-- These enforce at-most-one constraints that the application-level findFirst checks
-- cannot guarantee under concurrent transactions (Read Committed TOCTOU race).

-- S-01: At most one FREE_GRANT per user.
-- Prevents concurrent signup requests from double-granting free credits.
-- Without this index, two concurrent transactions both pass the findFirst check
-- (neither sees the other's uncommitted insert) and both insert + increment.
CREATE UNIQUE INDEX "CreditLedger_userId_type_FREE_GRANT_key"
    ON "CreditLedger"("userId", "type")
    WHERE "type" = 'FREE_GRANT';

-- S-06: At most one CONSUMPTION_REFUND per review.
-- Defense-in-depth alongside the status-guard in markFailedAndRefund (F-05).
-- Only applies when reviewId IS NOT NULL — guard/chat refunds use reviewId = NULL
-- and are allowed to occur multiple times (one per failed request).
CREATE UNIQUE INDEX "CreditLedger_reviewId_type_CONSUMPTION_REFUND_key"
    ON "CreditLedger"("reviewId", "type")
    WHERE "type" = 'CONSUMPTION_REFUND' AND "reviewId" IS NOT NULL;
